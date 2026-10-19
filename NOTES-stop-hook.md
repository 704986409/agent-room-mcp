# Stop Hook One-Round Listening & Cursor Handoff (M0 / M5)

## Summary of Changes

This track implements the one-round Stop Hook listener and cursor handoff mechanism for Agent Room Desktop (M0 item 3 & M5), following `/tmp/design-r3.1.md` (§2.5, §3.5, §7).

---

## 1. M0 Verification & Findings Summary

As documented in `docs/M0-init-stop-hook-findings.md`:
- **Client Detection (`init.ts:detectHarness()`)**: Inspects process environment markers (`CODEX_THREAD_ID` / `CODEX_SESSION_ID`, `CLAUDECODE`, `CURSOR_AGENT_VERSION`, `VSCODE_PID`, etc.) or falls back to inspect parent process ancestry via `/proc/$PPID/cmdline`.
- **Codex Configuration Writes (`npx agent-room-mcp init codex`)**:
  - Modifies `~/.codex/config.toml` by adding the MCP server declaration `[mcp_servers.agent_room]` pointing to `npx -y agent-room-mcp`.
  - Configures hook definitions under `[hooks.codex_hooks]` (or `[hooks]`) pointing to `npx -y agent-room-mcp hook <Event>`.
  - Injects room contract and instructions into `~/.codex/AGENTS.md` (or workspace `AGENTS.md`).
- **Installed Hooks**:
  - `Stop`: Runs when the agent completes its turn / attempts to finish.
  - `UserPromptSubmit`: Injects new room context when user submits prompt.
  - `SessionStart`: Injects active room context on fresh session start.
- **Legacy Stop Hook Spin Problem**:
  - Previously, when no new messages arrived during long-poll, the Stop Hook verified active rooms and output `{ decision: "block", followup_message: ... }` to force Codex to call `room_listen` again.
  - While capped by a 20-streak budget, any incoming message (even non-mention messages like ambient chatter or other agents' outputs) reset the block streak to 0, causing the session to spin indefinitely and never finish its turn.

---

## 2. Implemented Changes

### A. One-Round Listening & Mention Filtering (`apps/mcp/src/hook.ts`)
- **Single Round Long-Poll**: Long-poll defaults to 30s (`POLL_MAX_MS = 30_000`, configurable via `AGENT_ROOM_POLL_MAX_MS`) with 1s intervals.
- **Agent Mention Detection (`messageMentionsAgent`)**:
  - Checks message `metadata.targetAgentName` against current agent name.
  - Checks regex word-boundary mentions: `@Name`, case-insensitive `@name`, and suffixed names like `@Name (2)`.
  - Disregards messages sent by the agent itself.
- **Continuation Condition**:
  - The session is resumed **only** if at least one message targeting or @-mentioning the agent arrived (`hasMention === true`).
  - If messages arrived but none mention the agent, or if no messages arrived, the agent does **not** auto-continue.

### B. Cursor Handoff (`apps/mcp/src/state.ts`, `apps/mcp/src/roomApi.ts`, `apps/mcp/src/hook.ts`, `apps/mcp/src/tools.ts`)
- **`performHandoff` Execution**:
  - Calls `roomSleep(client, { code, name, cursor, seatKey })` on the server (`POST { action: 'sleep', code, name, cursor, seatKey }`).
  - Writes local handoff record atomically via `writeHandoff()` to:
    - `handoff-${code}.json` (per-room state)
    - `handoff.json` (latest + dictionary of room handoffs)
    - `AGENT_ROOM_HANDOFF_FILE` (if custom path specified in env)
  - Files are written with restricted permissions (`0600`) via temporary write + rename.
  - Advances and commits the local cursor via `updateCursor()`.
  - Resets the stop continuation budget (`resetStopContinuationBudget()`).
  - Exits process with code `0` without emitting `{ decision: "block" }` or any continuation payload.
- **`room_sleep` Tool**:
  - MCP operational tool handler that performs `roomSleep`, records handoff, and advances state cursor.

### C. Daemon-Managed Sessions (`AGENT_ROOM_MANAGED=1`)
- When running in daemon-managed mode (`process.env.AGENT_ROOM_MANAGED === '1'`), the Stop Hook **never** auto-continues.
- If unread messages exist, it updates cursors in state.
- Executes `performHandoff` immediately for all session rooms.
- Exits code `0` without blocking or returning a `followup_message`, allowing the daemon supervisor to manage subsequent turns and wakeups.

### D. Manual Sessions Preserved
- Manual (non-managed) sessions:
  - If an @-mention for the agent arrives during the round, the hook delivers the formatted messages and emits `{ decision: "block", followup_message: ... }` to resume the agent.
  - If no @-mention arrives, it executes `performHandoff` and exits cleanly.

---

## 3. Verification & Test Suite

All unit tests and builds run with completely mocked environments (no network, no real servers):
- **New Unit Tests (`apps/mcp/test/hook-stop-one-round.test.ts`)**:
  - `messageMentionsAgent`: exact `@Name`, case-insensitive `@name`, suffixed `@Name (2)`, metadata `targetAgentName`, negative non-mention cases.
  - `local handoff file in state.ts`: verifies `handoff.json` and `handoff-${code}.json` structure and `0600` permissions; custom `AGENT_ROOM_HANDOFF_FILE`.
  - `roomSleep API client`: verifies HTTP client calls with `action: 'sleep'`, `code`, `name`, `cursor`, and `seatKey`.
  - `performHandoff in hook.ts`: verifies combined server call + local fallback file write.
  - `Stop Hook execution (runHook)`:
    - Daemon-managed session (`AGENT_ROOM_MANAGED=1`): never auto-continues, commits cursor, hands off, exits 0.
    - Manual session with @ mention: delivers messages and resumes session.
    - Manual session with non-mention messages: hands off cursor and exits cleanly without resuming.
    - Manual session with quiet room: listens 1 round, hands off cursor and exits cleanly without resuming.
    - Manual session in Cursor mode: outputs `followup_message` when @ arrives.
- **Build and Test Results**:
  ```bash
  npm run build && npm test
  ```
  - Packages: `@agent-room/shared`, `@agent-room/upstash-client`, `agent-room-mcp`
  - Results: **17 test files passed, 174 tests passed (0 failures)**.
