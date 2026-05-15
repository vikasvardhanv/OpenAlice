import { tool } from 'ai'
import { z } from 'zod'

/**
 * notify_user — **DEPRECATED legacy tool**.
 *
 * Exists only to serve the Automation legacy path (heartbeat / cron /
 * external `task.requested`) which pre-dates Workspace. The AgentWork
 * outputGate inspects `ProviderResult.toolCalls` for this name and
 * routes the `text` arg through dedup → `connectorCenter.notify` →
 * the legacy NotificationsStore.
 *
 * Workspace-era agents should use `inbox_push` (exposed at
 * `/mcp/:wsId`) instead — it writes to the new workspace-anchored
 * Inbox and supports docs + comments. `notify_user` plain-text
 * notifications are a strictly lesser surface and exist only so the
 * pre-Workspace Automation flows keep working until they retire.
 *
 * **Why no side-effects in execute**: the actual delivery is gated
 * by the AgentWork outputGate; this tool is intent-only and the
 * runner is the control point.
 *
 * Globally registered by ToolCenter — visible to every session. The
 * description below tries to dissuade workspace agents from picking
 * it accidentally; if you find a workspace agent still reaching for
 * it, treat that as a description-tuning bug, not a tool-registration
 * one (removing it would break the heartbeat / cron paths that
 * legitimately depend on it).
 */
export function createNotifyUserTool() {
  return {
    notify_user: tool({
      description: [
        '[DEPRECATED — legacy Automation path only]',
        'Send a plain-text notification through the legacy',
        'NotificationsStore.',
        '',
        'Do NOT use this tool if you are inside a Workspace —',
        'use `inbox_push` instead (exposed at the workspace-scoped',
        'MCP server). `inbox_push` supports doc references + markdown',
        'comments and is the correct path for workspace agents.',
        '',
        'This tool exists only for pre-Workspace Automation flows',
        '(heartbeat / cron / external task.requested triggers) whose',
        'AgentWork outputGate inspects this tool call. If neither of',
        'those is your context, do not call this.',
      ].join(' '),
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .describe(
            'The notification body, in the user\'s language. Keep it concise — under ~300 chars where possible. Plain text only; markdown is not rendered downstream.',
          ),
        urgency: z
          .enum(['info', 'important'])
          .optional()
          .describe(
            '"info" (default) for routine surfacing; "important" for time-sensitive matters the user should see promptly.',
          ),
      }),
      execute: async ({ text, urgency }) => {
        // Intent-only signal — the AgentWork runner's outputGate
        // observes this call via ProviderResult.toolCalls and routes
        // through dedup / connectorCenter.notify. Returning success
        // here doesn't mean the user has been pinged yet; it means
        // Alice's intent has been recorded for the runner to act on.
        return { acknowledged: true, text, urgency: urgency ?? 'info' }
      },
    }),
  }
}
