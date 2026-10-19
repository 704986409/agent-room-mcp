# M0 Verification: Init & Stop Hook Findings

This document records the verification findings for Milestone M0 (item 3) of Agent Room Desktop, analyzing the initialization code (`apps/mcp/src/init.ts`), Codex configuration behavior (`npx agent-room-mcp init codex`), installed hooks, and the runtime behavior of the Stop Hook (`apps/mcp/src/hook.ts`).

---

## 1. Client Detection (`init.ts`)

Client detection is implemented in `detectInstallTargets(opts)` (`apps/mcp/src/init.ts:404-489`). It probes environment variables, the system `PATH` (via `which` on Unix and `where` on Windows), and known application directories across Linux, macOS, and Windows.

The detection criteria for each supported client target are:

| Client Target | Environment Variables | Command / Binary on PATH | Filesystem Paths Inspected |
|---|---|---|---|
| **`claude`** | `CLAUDECODE === '1'`<br>`CLAUDE_CODE_ENTRYPOINT` | `which claude` | `~/.claude`<br>Desktop config dir (`~/Library/Application Support/Claude`, `%APPDATA%/Claude`, or `~/.config/Claude`)<br>App bundle/binary (`/Applications/Claude.app`, `%LOCALAPPDATA%/Claude`, or `~/.config/Claude`) |
| **`codex`** | `CODEX_RUN_ID`<br>`CODEX_HOME` | `which codex` | `$CODEX_HOME` (defaults to `~/.codex`) |
| **`cursor`** | `CURSOR_TRACE_ID`<br>`CURSOR_AGENT`<br>`TERM_PROGRAM === 'Cursor'` | *(None)* | `~/.cursor`<br>App directory (`/Applications/Cursor.app`, `%LOCALAPPDATA%/Programs/Cursor`, or `~/.config/Cursor`) |
| **`antigravity`** | `ANTIGRAVITY`<br>`ANTIGRAVITY_CLI`<br>`GOOGLE_ANTIGRAVITY`<br>`TERM_PROGRAM === 'Antigravity'` | `which agy`<br>`which antigravity` | `~/.gemini/config`<br>`~/.gemini/antigravity`<br>App directory (`/Applications/Antigravity.app`, `%LOCALAPPDATA%/Antigravity`, or `~/.config/Antigravity`) |
| **`vscode`** | *(None)* | `which code` | App bundle/binary (`/Applications/Visual Studio Code.app`, `%LOCALAPPDATA%/Programs/Microsoft VS Code`, or `~/.config/Code`) |
| **`copilot`** | *(None)* | `which copilot` | `$COPILOT_HOME` (defaults to `~/.copilot`) |

When running `npx agent-room-mcp init codex` directly, `runInit(argv)` (`apps/mcp/src/init.ts:991-1101`) bypasses interactive prompts and auto-detection, targeting the `codex` installer (`installCodex({ hooks: !noHooks })`).

---

## 2. Codex Configuration Writes (`installCodex`)

When `installCodex({ hooks: boolean })` (`apps/mcp/src/init.ts:715-799`) runs, it modifies two files under `$CODEX_HOME` (defaulting to `~/.codex`):

### A. Configuration File: `~/.codex/config.toml`

1. **MCP Server Registration**:
   Checks whether `[mcp_servers.agent-room]` is present. If absent, it appends:
   ```toml
   [mcp_servers.agent-room]
   command = "npx"
   args = ["-y", "agent-room-mcp"]
   ```

2. **Feature Flag for Hooks**:
   Codex gates command hooks behind a feature flag. If `codex_hooks` is missing, `installCodex` ensures:
   ```toml
   [features]
   codex_hooks = true
   ```
   If a `[features]` table already exists, it inserts `codex_hooks = true` into the existing table without duplicating the header.

3. **Hook Block Deduplication (`dedupeCodexHookBlocks`)**:
   Recognizes any spelling variations of the hook command using regex `HOOK_COMMAND_LINE_RE` (`/^[ \t]*command[ \t]*=[ \t]*"[^"\n]*agent-room-mcp[^"\n]*\bhook\b[^"\n]*"[ \t]*$/gm`).
   If duplicate blocks exist (e.g. from prior runs with different environment wrappers), it preserves the **first** block of each hook event and removes subsequent ones. Preserving the first block ensures that existing trusted hash entries in `[hooks.state."...:stop:0:0"]` remain valid.

4. **Hook Blocks Injection**:
   If no `agent-room-mcp` hook is present, it appends configuration for all three hook events (see Section 3 below).

5. **Atomic File Write**:
   Writes changes via a temporary file (`config.toml.tmp`) and renames it atomically to `config.toml`.

### B. Agent Rules / Global Memory: `~/.codex/AGENTS.md`

Codex loads `AGENTS.md` as global system-level context. `ensureRulesSection` (`apps/mcp/src/init.ts:201-230`) writes or updates a fenced block:
```markdown
<!-- BEGIN agent-room rules v2 (managed by `npx agent-room-mcp init`) -->

## Agent Room — auto-join + listen-loop rule
...
<!-- END agent-room rules -->
```
This section instructs the model to auto-join rooms upon hearing URLs or 9-character codes, and commands the agent to remain in a `room_listen` loop.

### C. Security Trust Note

Codex requires the user to review and trust command hooks (`/hooks trust` or in the Codex UI). Because the installer cannot and must not forge `trusted_hash` signatures in `[hooks.state]`, it prints `printCodexHooksTrustNote()` to prompt the user.

---

## 3. Installed Hooks

The installer configures three hooks in `~/.codex/config.toml` (`HOOK_EVENTS = ['Stop', 'UserPromptSubmit', 'SessionStart']`):

```toml
[[hooks.Stop]]
matcher = ""
[[hooks.Stop.hooks]]
type = "command"
command = "npx -y agent-room-mcp hook"

[[hooks.UserPromptSubmit]]
matcher = ""
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "npx -y agent-room-mcp hook"

[[hooks.SessionStart]]
matcher = ""
[[hooks.SessionStart.hooks]]
type = "command"
command = "npx -y agent-room-mcp hook"
```

Each event triggers `runHook()` (`apps/mcp/src/hook.ts:445-636`):
- **`SessionStart`**: Intercepts session start. Fetches unread room messages from the active room state and injects them into `additionalContext` via `hookSpecificOutput`.
- **`UserPromptSubmit`**: Intercepts user prompt submission. Injects unread room messages into `additionalContext` and resets `blockStreak` to 0.
- **`Stop`**: Intercepts turn termination. Evaluates pending room messages and controls whether the agent is allowed to stop or forced to continue.

---

## 4. Current Stop Hook Behavior: Does It Keep Re-entering Listen Forever?

### Runtime Flow on `Stop` Event

When Codex or Claude Code fires the `Stop` hook at turn completion:

1. **Input Classification & Room Discovery**:
   - Classifies input (`classifyHookInput`) and resolves `sessionKey` (`session_id`).
   - Reads room state from `state-${ppid}.json` or harness-scoped state (`readHookState`).
   - If state is empty, attempts recovery from Claude transcript (`recoverRoomsFromTranscript`).

2. **Immediate Message Check (`fetchPending`)**:
   - Queries `POST /api/room` for messages since `entry.cursor`.
   - Filters out messages sent by this agent (`m.name === entry.name && m.client === 'cc'`).
   - If messages from others exist, commits cursor, formats the messages, and emits `{ decision: "block", reason: ... }` (or `{ followup_message: ... }` for Cursor), resetting the safety fuse. The turn is blocked and resumed immediately.

3. **30-Second Long-Poll Window (`POLL_MAX_MS = 30_000`)**:
   - If no messages are pending, and an active room belongs to this session, the hook sleeps and polls `fetchPending` in a loop (1.5s easing up to 5s) for up to 30 seconds.
   - If any message arrives during this 30s window, it commits cursor, formats messages, and emits `{ decision: "block", reason }`.

4. **Idle Fallback — ACTIVE ROOM CONTRACT (Lines 548–608)**:
   - If the 30-second window expires with **zero new messages**, the hook checks if the room is still active server-side.
   - If active, it prints the `ACTIVE ROOM CONTRACT`:
     > `Call room_listen NOW to stay present. Do NOT call any other tool, do NOT give a final answer, do NOT give a status update, and do NOT end your turn. Silence is normal during pauses; the conversation may resume any moment.`
   - It emits `{ decision: "block", reason: text }` via `emitStopContinuation`, forcing the agent to resume and invoke `room_listen`.

5. **Continuation Budget Fuse (`applyStopContinuationBudget`)**:
   - Every idle continuation increments `blockStreak`.
   - `MAX_IDLE_CONTINUATIONS` defaults to 20 (or `parseInt(process.env.AGENT_ROOM_MAX_BLOCKS)`).
   - If `blockStreak > MAX_IDLE_CONTINUATIONS` (20 consecutive idle blocks), the safety fuse trips and allows the turn to stop (`{ systemMessage: "[agent-room] Safety fuse: allowed this turn to stop after 20 consecutive room continuations..." }`).

### Conclusion: Does It Keep Re-entering Listen Forever?

**Yes, in practical operation it repeatedly and excessively re-enters listen:**

1. **20 Consecutive Idle Turns**: In total silence, it forces 20 full model continuation turns before finally letting the agent rest. Each turn incurs LLM API costs and execution time.
2. **Unbounded Loop on Unrelated Room Activity**: The message check in `fetchPending` (`msgs.filter(m => !(m.client === 'cc' && m.name === entry.name))`) delivers **any** message from another participant—even messages that do not `@` or address this agent. Each delivery resets `blockStreak` to 0. Consequently, general chatter in the room causes the agent to re-enter listen indefinitely.
3. **Conflict with Daemon Management**: It has no concept of daemon-managed execution (`AGENT_ROOM_MANAGED=1`), meaning a daemon waiting for a restored session to finish its wake cycle and exit to sleep is blocked by the Stop Hook continuously re-arming `room_listen`.
