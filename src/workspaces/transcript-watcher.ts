import { mkdir, readdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';

import type { CliAdapter } from './cli-adapter.js';
import type { Logger } from './logger.js';
import type { PersistentSession } from './persistent-session.js';
import type { SessionRegistry } from './session-registry.js';

interface Pending {
  readonly session: PersistentSession;
  readonly adapter: CliAdapter;
  /** Files in the transcript dir at register time — ignored when matching. */
  readonly existingBefore: ReadonlySet<string>;
}

interface PerKey {
  readonly dir: string;
  readonly fileRe: RegExp;
  readonly watcher: FSWatcher;
  readonly pending: Pending[];
}

function watchKey(wsId: string, dir: string): string {
  return `${wsId}\x00${dir}`;
}

/**
 * Maps PTY sessions to their CLI's on-disk transcript file.
 *
 * Adapter-driven (generalized from the M4-era `ClaudeSessionWatcher`):
 *   - `adapter.transcriptDir(cwd)` decides which directory to watch.
 *   - `adapter.transcriptFileRe` filters watch events.
 *   - `adapter.extractSessionId(filename)` extracts the session id.
 *
 * The watcher is per-(wsId, dir) — most adapters land sessions of the same
 * workspace in the same directory, so we share an `FSWatcher`. Codex (M2)
 * uses `transcriptDiscovery: 'none'` so it never reaches this code; if a
 * future adapter wants a global dir (e.g. `~/.codex/sessions`) we'd need to
 * extend this to read cwd from the file contents — out of v2 scope.
 *
 * Same matching heuristic as before: snapshot existing files at register
 * time, assign each new file to the oldest pending session in spawn order.
 * Reliable for chat flows; rapid concurrent spawns can cross-match (impact
 * is just a misleading tooltip, never anything load-bearing).
 */
export class TranscriptWatcher {
  private readonly entries = new Map<string, PerKey>();

  constructor(
    private readonly logger: Logger,
    /**
     * Optional registry. When provided, the watcher fans out the discovered
     * agent-session-id into the corresponding record's `resumeHint`, so
     * `POST /sessions/:id/resume` can later invoke `claude --resume <uuid>`.
     */
    private readonly sessionRegistry?: SessionRegistry,
  ) {}

  async register(session: PersistentSession, adapter: CliAdapter): Promise<void> {
    if (adapter.capabilities.transcriptDiscovery !== 'fs-watch') return;
    if (!adapter.transcriptDir || !adapter.transcriptFileRe || !adapter.extractSessionId) {
      this.logger.warn('transcript_watch.adapter_missing_fs_methods', { adapter: adapter.id });
      return;
    }

    const dir = adapter.transcriptDir(session.cwd);
    const key = watchKey(session.wsId, dir);

    let existing: ReadonlySet<string>;
    try {
      existing = await snapshotFiles(dir, adapter.transcriptFileRe);
    } catch (err) {
      if (!isENOENT(err)) {
        this.logger.warn('transcript_watch.snapshot_failed', {
          wsId: session.wsId,
          adapter: adapter.id,
          dir,
          err,
        });
      }
      existing = new Set();
    }

    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      this.logger.warn('transcript_watch.mkdir_failed', {
        wsId: session.wsId,
        adapter: adapter.id,
        dir,
        err,
      });
      return;
    }

    let entry = this.entries.get(key);
    if (!entry) {
      try {
        const w = watch(dir, (event, filename) => {
          if (typeof filename === 'string') {
            void this.onEvent(key, event, filename);
          }
        });
        w.on('error', (err) => {
          this.logger.warn('transcript_watch.error', {
            wsId: session.wsId,
            adapter: adapter.id,
            dir,
            err,
          });
        });
        entry = { dir, fileRe: adapter.transcriptFileRe, watcher: w, pending: [] };
        this.entries.set(key, entry);
      } catch (err) {
        this.logger.warn('transcript_watch.watch_failed', {
          wsId: session.wsId,
          adapter: adapter.id,
          dir,
          err,
        });
        return;
      }
    }

    entry.pending.push({ session, adapter, existingBefore: existing });
    this.logger.info('transcript_watch.registered', {
      wsId: session.wsId,
      adapter: adapter.id,
      recordId: session.recordId,
      preexisting: existing.size,
      pending: entry.pending.length,
    });
    // path.trace — what the watcher is actually watching for THIS session.
    // Compare watchDir + projectKey against the spawn path.trace; any
    // divergence means the CLI will write jsonl to a place we're not
    // watching, and resumeHint will never be populated.
    this.logger.info('path.trace', {
      where: 'transcript.watch.register',
      wsId: session.wsId,
      recordId: session.recordId,
      agent: adapter.id,
      sessionCwd: session.cwd,
      watchDir: dir,
      projectKey: basename(dir),
      watchDirJsonlCount: existing.size,
    });
  }

  /** Called when a session is disposed OR resolved. Closes idle watchers. */
  unregister(session: PersistentSession): void {
    for (const [key, entry] of this.entries.entries()) {
      const idx = entry.pending.findIndex((p) => p.session === session);
      if (idx < 0) continue;
      entry.pending.splice(idx, 1);
      if (entry.pending.length === 0) {
        try {
          entry.watcher.close();
        } catch {
          // ignore
        }
        this.entries.delete(key);
      }
    }
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.watcher.close();
      } catch {
        // ignore
      }
    }
    this.entries.clear();
  }

  private async onEvent(key: string, _event: string, filename: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.pending.length === 0) return;
    if (!entry.fileRe.test(filename)) return;

    try {
      await stat(join(entry.dir, filename));
    } catch {
      return;
    }

    for (const p of entry.pending) {
      if (p.existingBefore.has(filename)) continue;
      if (p.session.agentSessionId !== null) continue;
      const sessionId = p.adapter.extractSessionId?.(filename);
      if (!sessionId) return;
      p.session.setAgentSessionId(sessionId);
      this.logger.info('transcript.jsonl.detected', {
        wsId: p.session.wsId,
        recordId: p.session.recordId,
        agent: p.adapter.id,
        filename,
        agentSessionId: sessionId,
      });
      if (this.sessionRegistry) {
        // Fire-and-forget — failed write just means we don't get the
        // resumeHint persisted, which downgrades resume to `--continue`
        // semantics next time.
        void this.sessionRegistry
          .update(p.session.wsId, p.session.recordId, {
            resumeHint: { kind: 'agent-session-id', value: sessionId },
          })
          .catch((err) => {
            this.logger.warn('transcript_watch.registry_update_failed', {
              wsId: p.session.wsId,
              id: p.session.recordId,
              err,
            });
          });
      }
      this.unregister(p.session);
      return;
    }
  }
}

async function snapshotFiles(dir: string, fileRe: RegExp): Promise<Set<string>> {
  const out = new Set<string>();
  const entries = await readdir(dir);
  for (const name of entries) {
    if (fileRe.test(name)) out.add(name);
  }
  return out;
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
