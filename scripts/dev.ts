/**
 * Dev mode orchestrator.
 *
 * Plays the same L2 "port authority" role in dev that Electron main plays
 * in prod (electron/main.ts):
 *   - probe a free port for backend web + MCP (47331+)
 *   - spawn backend (`tsx watch src/main.ts`) with OPENALICE_WEB_PORT /
 *     OPENALICE_MCP_PORT env injected
 *   - spawn Vite UI dev server (`pnpm --filter open-alice-ui dev`) with
 *     OPENALICE_BACKEND_PORT env so its proxy target matches the backend
 *   - forward SIGINT / SIGTERM / SIGHUP to both children
 *   - if either child exits, shut down the other
 *
 * Contributor experience: a single `pnpm dev` command, ports auto-picked
 * out of contention, backend hot-reloads via tsx watch (port persists
 * across reloads because env stays in the spawn config). Backend remains
 * a pure L3 executor — reads ports from env, doesn't read config files
 * for them, doesn't decide ports itself.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { probeFreePort } from './probe-port.js'

const DEFAULT_WEB_PORT_START = 47331
const SIGKILL_GRACE_MS = 5_000

const children: ChildProcess[] = []
let shuttingDown = false

async function main(): Promise<void> {
  const webPort = await probeFreePort(DEFAULT_WEB_PORT_START)
  const mcpPort = await probeFreePort(webPort + 1)

  console.log('')
  console.log(`[dev] backend  →  http://localhost:${webPort}`)
  console.log(`[dev] MCP      →  http://localhost:${mcpPort}/mcp`)
  console.log(`[dev] UI       →  http://localhost:5173  (Vite picks +1 if taken)`)
  console.log('')

  const backend = spawn('tsx', ['watch', 'src/main.ts'], {
    env: {
      ...process.env,
      // Tell Node's resolver to honor the `openalice-source` export
      // condition on @traderalice/* workspace packages, so backend imports
      // hit `packages/*/src/*.ts` directly — no need for those packages to
      // be pre-built into `dist/` before `pnpm dev`.
      NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --conditions=openalice-source`.trim(),
      OPENALICE_WEB_PORT: String(webPort),
      OPENALICE_MCP_PORT: String(mcpPort),
    },
    stdio: 'inherit',
  })
  children.push(backend)
  backend.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.log(`[dev] backend exited (code=${code}, signal=${signal}) — shutting down`)
      shutdown()
    }
  })

  const vite = spawn('pnpm', ['--filter', 'open-alice-ui', 'dev'], {
    env: {
      ...process.env,
      OPENALICE_BACKEND_PORT: String(webPort),
    },
    stdio: 'inherit',
  })
  children.push(vite)
  vite.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.log(`[dev] vite exited (code=${code}, signal=${signal}) — shutting down`)
      shutdown()
    }
  })
}

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    if (c.exitCode === null && !c.killed) {
      try { c.kill('SIGTERM') } catch { /* noop */ }
    }
  }
  // SIGKILL fallback if a child doesn't exit gracefully.
  setTimeout(() => {
    for (const c of children) {
      if (c.exitCode === null && !c.killed) {
        try { c.kill('SIGKILL') } catch { /* noop */ }
      }
    }
    process.exit(0)
  }, SIGKILL_GRACE_MS).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGHUP', shutdown)

main().catch((err: unknown) => {
  console.error('[dev] fatal:', err)
  shutdown()
  process.exit(1)
})
