import { createRoomApiClient, getMessages, getRoom, roomSleep } from './roomApi.js';
import type { Message } from '@agent-room/shared';
import { mentionedAgents } from '@agent-room/shared';
import { readFile } from 'node:fs/promises';
import {
  readState,
  setRoom,
  readHarnessStateOrMerged,
  hasRunScopedHarnessState,
  updateCursor,
  updateCursorEverywhere,
  bumpBlockStreak,
  bumpBlockStreakEverywhere,
  resetBlockStreak,
  resetBlockStreakEverywhere,
  removeRoom,
  removeRoomEverywhere,
  claimRoomSessionEverywhere,
  roomBelongsToSession,
  writeHandoff,
  readHandoff,
} from './state.js';
import { detectHarness } from './harness.js';

// Stop-hook long-poll: how long the hook holds the turn open looking for new
// room messages before letting the agent stop. Increased from the original
// 8s to a full 30s so the hook + the agent's room_listen window line up —
// without this, an agent that finished a turn without a recent send would
// only get an 8-second window to catch a web user's reply before sleeping.
const getPollMaxMs = () => {
  const fromEnv = parseInt(process.env.AGENT_ROOM_HOOK_POLL_MAX_MS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000;
};
const getPollIntervalMs = () => {
  const fromEnv = parseInt(process.env.AGENT_ROOM_HOOK_POLL_INTERVAL_MS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 1_500;
};

// Stop hooks are a fallback for clients that accidentally finish their turn
// while they are still in a room. Each continuation starts another model turn,
// so a broken client/rule must not be able to spend tokens forever.
//
// What the fuse counts matters more than where it trips. It counts only IDLE
// continuations — the ones that hand the agent nothing but "call room_listen
// again". Delivering real room messages resets it, because that is progress,
// not spinning. Counting deliveries too would have made the fuse worst in the
// rooms that are working best: a Cursor session driven entirely by
// followup_message does one continuation per room message, so a busy meeting
// would have burned the budget in a few minutes and released the agent — the
// same silent drop this hook exists to prevent.
//
// With only idle continuations counted, a healthy session never approaches the
// limit, which is why it can be generous. It is deliberately not tuned to any
// particular client's own continuation cap.
const MAX_IDLE_CONTINUATIONS = (() => {
  const fromEnv = parseInt(process.env.AGENT_ROOM_MAX_BLOCKS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 20;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Two clients funnel into this hook today:
//
// - Claude Code / Codex: send `hook_event_name` ∈ { Stop, UserPromptSubmit,
//   SessionStart } and expect `{ decision: "block", reason }` to keep the
//   turn open, or `{ hookSpecificOutput: { ... } }` for context injection.
//
// - Cursor 1.7+: sends `{ status, loop_count }` (no `hook_event_name`) on
//   the `stop` event and expects `{ followup_message }` to enqueue the next
//   user message; an empty/omitted body means "let the turn end".
//
// We detect the shape and emit the right response per client.
interface HookInput {
  // Claude Code / Codex
  hook_event_name?: string;
  stop_hook_active?: boolean;
  // Codex common field — unique per chat thread.
  session_id?: string;
  // Cursor 1.7+ stop hook
  status?: 'completed' | 'aborted' | 'error';
  loop_count?: number;
  conversation_id?: string;
  // Claude Code: JSONL of the conversation so far. The only way to learn
  // which room this session is in when nothing local wrote it down.
  transcript_path?: string;
}

/** Prefer Codex session_id, then Cursor conversation_id. */
export function resolveHookSessionKey(input: HookInput): string | undefined {
  const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : '';
  if (sessionId) return sessionId;
  const conversationId = typeof input.conversation_id === 'string' ? input.conversation_id.trim() : '';
  if (conversationId) return conversationId;
  return undefined;
}

function isCursorStopInput(input: HookInput): boolean {
  return (
    typeof input.status === 'string' &&
    (input.hook_event_name === undefined || input.hook_event_name.toLowerCase() === 'stop')
  );
}

export function classifyHookInput(input: HookInput): { event: string; cursorMode: boolean } | null {
  const cursorMode = isCursorStopInput(input);
  if (cursorMode) return { event: 'Stop', cursorMode };

  if (input.hook_event_name) {
    const normalized =
      input.hook_event_name.toLowerCase() === 'stop' ? 'Stop' : input.hook_event_name;
    return { event: normalized, cursorMode };
  }

  return null;
}

interface PendingRoom {
  code: string;
  topic: string;
  selfName: string;
  newCursor: number;
  messages: Message[];
}

type StateScope = 'scoped' | 'harness';

export interface StopContinuationBudget {
  decision: 'block' | 'allow';
  streak: number;
  reason?: string;
}

async function resetStopContinuationBudget(scope: StateScope): Promise<void> {
  if (scope === 'harness') await resetBlockStreakEverywhere();
  else await resetBlockStreak();
}

/**
 * Account for exactly one Stop-hook continuation. The call that would exceed
 * the budget is allowed through and atomically starts the next user-driven
 * cycle at zero. Exported so the safety property can be tested without
 * spawning a hook process or making room API calls.
 */
export async function applyStopContinuationBudget(
  scope: StateScope,
  maxBlocks = MAX_IDLE_CONTINUATIONS,
): Promise<StopContinuationBudget> {
  const streak = scope === 'harness'
    ? await bumpBlockStreakEverywhere()
    : await bumpBlockStreak();
  if (streak <= maxBlocks) return { decision: 'block', streak };

  await resetStopContinuationBudget(scope);
  return {
    decision: 'allow',
    streak: 0,
    reason: `[agent-room] Safety fuse: allowed this turn to stop after ${maxBlocks} consecutive room continuations that delivered no new messages, to prevent a runaway token loop. The continuation counter has been reset.`,
  };
}

/**
 * Emit one Stop-hook continuation.
 *
 * `delivered` says whether this continuation carries new room messages. A
 * delivering continuation is progress: it resets the fuse and is never
 * refused, so an active room can run indefinitely. Only idle ones — the
 * "nothing new, go listen again" nudges — are counted and can trip it.
 */
async function emitStopContinuation(
  text: string,
  cursorMode: boolean,
  scope: StateScope,
  delivered: boolean,
  writeStdout: (data: string) => void = (d) => process.stdout.write(d),
): Promise<void> {
  if (delivered) {
    try { await resetStopContinuationBudget(scope); }
    catch { /* non-essential */ }
    if (cursorMode) writeStdout(JSON.stringify({ followup_message: text }));
    else writeStdout(JSON.stringify({ decision: 'block', reason: text }));
    return;
  }
  let budget: StopContinuationBudget;
  try {
    budget = await applyStopContinuationBudget(scope);
  } catch {
    // State accounting is safety-critical. Fail open if it cannot be persisted
    // rather than creating an unbounded continuation chain.
    budget = {
      decision: 'allow',
      streak: 0,
      reason: '[agent-room] Safety fuse: allowed this turn to stop because the continuation counter could not be persisted.',
    };
  }

  if (budget.decision === 'allow') {
    // Omitting decision/followup is the documented allow shape. systemMessage
    // makes the reason visible without scheduling another model turn.
    writeStdout(JSON.stringify({ systemMessage: budget.reason }));
    return;
  }
  if (cursorMode) writeStdout(JSON.stringify({ followup_message: text }));
  else writeStdout(JSON.stringify({ decision: 'block', reason: text }));
}

/**
 * Returns true if the message addresses the specified agent.
 * Checks for `@name` (case-insensitive) or `metadata.targetAgentName`.
 */
export function messageMentionsAgent(m: Message, agentName: string): boolean {
  if (!agentName) return false;
  if (m.metadata?.targetAgentName) {
    if (
      m.metadata.targetAgentName === agentName ||
      m.metadata.targetAgentName.toLowerCase() === agentName.toLowerCase()
    ) {
      return true;
    }
  }
  const names = [agentName];
  const baseMatch = agentName.match(/^(.+?)\s*\(\d+\)$/);
  if (baseMatch && baseMatch[1]) {
    names.push(baseMatch[1]);
  }
  return mentionedAgents(m.text, names).length > 0;
}

/**
 * Perform cursor handoff for a room:
 * 1. Calls room_sleep API on server if available.
 * 2. Writes cursor to the local handoff file.
 */
export async function performHandoff(
  client: ReturnType<typeof createRoomApiClient>,
  input: {
    code: string;
    name: string;
    cursor: number;
    seatKey?: string;
    sessionId?: string;
  },
): Promise<void> {
  try {
    await roomSleep(client, {
      code: input.code,
      name: input.name,
      cursor: input.cursor,
      seatKey: input.seatKey,
    });
  } catch {
    // server-side roomSleep is best-effort
  }

  try {
    await writeHandoff({
      code: input.code,
      name: input.name,
      cursor: input.cursor,
      seatKey: input.seatKey,
      sessionId: input.sessionId,
      at: Date.now(),
    });
  } catch {
    // non-essential local write error
  }
}

async function readHookState(scope: StateScope) {
  return scope === 'harness' ? readHarnessStateOrMerged() : readState();
}

/** A room this session is in, as recovered from its own transcript. */
export interface TranscriptRoom {
  code: string;
  name: string;
  cursor: number;
}

const ROOM_TOOL_RE = /(?:^|_)room_(join|listen|send|task|leave)$/;

/**
 * Recover the rooms a session is in by reading its own transcript.
 *
 * The hook has always answered "am I in a room?" from ~/.agent-room state,
 * which only the stdio MCP server writes. A user configured with
 *
 *   "agent-room": { "type": "http", "url": "https://www.agent-room.com/mcp" }
 *
 * never runs that server, so nothing on their machine ever writes that file
 * and the hook has been a no-op for them — the exact configuration we now
 * recommend. The transcript is the one local record of the join that exists
 * either way: the room_join call and every room_listen after it are in it,
 * with the code, the display name, and the cursor.
 *
 * Pure and exported so it can be tested against real transcript text without
 * a filesystem or a room server.
 */
export function roomsFromTranscript(text: string): TranscriptRoom[] {
  const rooms = new Map<string, { name: string; cursor: number; order: number }>();
  const left = new Set<string>();
  // tool_use id -> room code, so a tool_result (which carries no code of its
  // own) can be attributed back to the room it came from.
  const callCodes = new Map<string, string>();
  let order = 0;

  for (const line of text.split('\n')) {
    // Cheap pre-filter: transcripts are large and mostly unrelated to rooms.
    if (!line.includes('room_') && !line.includes('listenStatus')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use') {
        const tool = ROOM_TOOL_RE.exec(String(block.name ?? ''));
        if (!tool) continue;
        const args = block.input;
        const code = typeof args?.code === 'string' ? args.code.trim() : '';
        if (!code) continue;
        if (typeof block.id === 'string') callCodes.set(block.id, code);
        if (tool[1] === 'leave') { left.add(code); continue; }
        const name = typeof args?.name === 'string' ? args.name.trim() : '';
        const since = typeof args?.since === 'number' ? args.since : 0;
        const prev = rooms.get(code);
        rooms.set(code, {
          // A later call without a name must not erase the name an earlier
          // one established — room_task, for instance, carries no display
          // name on some actions.
          name: name || prev?.name || '',
          cursor: Math.max(since, prev?.cursor ?? 0),
          order: order += 1,
        });
        continue;
      }

      if (block.type === 'tool_result') {
        const code = callCodes.get(String(block.tool_use_id ?? ''));
        if (!code) continue;
        const parts = Array.isArray(block.content) ? block.content : [];
        for (const part of parts) {
          if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
          let body: any;
          try { body = JSON.parse(part.text); } catch { continue; }
          // The room told us it is over. Nothing should resurrect it.
          if (body?.listenStatus === 'ended' || body?.listenStatus === 'removed') {
            left.add(code);
            continue;
          }
          const cursor = typeof body?.cursor === 'number' ? body.cursor : null;
          const name = typeof body?.assignedName === 'string' ? body.assignedName.trim() : '';
          const prev = rooms.get(code);
          if (cursor === null && !name) continue;
          rooms.set(code, {
            name: name || prev?.name || '',
            cursor: Math.max(cursor ?? 0, prev?.cursor ?? 0),
            order: prev?.order ?? (order += 1),
          });
        }
      }
    }
  }

  return [...rooms.entries()]
    .filter(([code, r]) => !left.has(code) && r.name)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([code, r]) => ({ code, name: r.name, cursor: r.cursor }));
}

/**
 * Seed local state from the transcript when nothing else wrote it.
 *
 * Only runs when state holds no rooms at all, and only adopts a room the
 * server confirms is still active with this agent seated — a transcript is
 * history, and history includes meetings that ended. Once seeded, every
 * downstream path (pending messages, cleanup, cursor commits) works exactly
 * as it does for a stdio user, and this never runs again for that room.
 */
async function recoverRoomsFromTranscript(
  scope: StateScope,
  transcriptPath: string | undefined,
  sessionKey: string | undefined,
): Promise<void> {
  if (!transcriptPath) return;
  // The harness-scoped file is written by a local stdio server; if that exists
  // there is nothing to recover. Recovery is for the case where no server ran.
  if (scope !== 'scoped') return;
  let state;
  try { state = await readHookState(scope); } catch { return; }
  if (Object.keys(state.rooms).length > 0) return;

  let text: string;
  try { text = await readFile(transcriptPath, 'utf8'); } catch { return; }

  const candidates = roomsFromTranscript(text);
  if (candidates.length === 0) return;

  const client = createRoomApiClient();
  for (const candidate of candidates) {
    try {
      const room = await getRoom(client, candidate.code);
      if (room.status !== 'active') continue;
      if (!room.participants.some(p => p.name === candidate.name && p.client === 'cc')) continue;
      await setRoom(candidate.code, {
        name: candidate.name,
        cursor: candidate.cursor,
        joinedAt: Date.now(),
        ...(sessionKey ? { sessionKey } : {}),
      });
    } catch { /* room gone or unreachable — leave it out */ }
  }
}

async function fetchPending(scope: StateScope, sessionKey?: string): Promise<PendingRoom[]> {
  const state = await readHookState(scope);
  const codes = Object.keys(state.rooms);
  if (codes.length === 0) return [];

  const client = createRoomApiClient();
  const results: PendingRoom[] = [];

  for (const code of codes) {
    const entry = state.rooms[code]!;
    if (!roomBelongsToSession(entry, sessionKey)) continue;
    // First Stop after join: claim unscoped rooms for this session so other
    // Codex/Cursor threads stop seeing them.
    if (sessionKey && !entry.sessionKey) {
      const claimed = await claimRoomSessionEverywhere(code, sessionKey);
      if (!claimed) continue;
      entry.sessionKey = sessionKey;
    }
    let msgs: Message[];
    let total: number | null;
    try {
      ({ messages: msgs, total } = await getMessages(client, code, entry.cursor));
    } catch {
      continue;
    }
    if (msgs.length === 0) continue;

    let topic = '';
    try {
      const room = await getRoom(client, code);
      topic = room.topic;
    } catch { /* room may have expired; still surface the messages */ }

    const others = msgs.filter(
      (m) => !(m.client === 'cc' && m.name === entry.name)
    );

    results.push({
      code,
      topic,
      selfName: entry.name,
      newCursor: total ?? entry.cursor + msgs.length,
      messages: others,
    });
  }

  return results;
}

function formatMessages(rooms: PendingRoom[]): string {
  const lines: string[] = [];
  lines.push('[agent-room] New messages received while you were idle:');
  lines.push('');
  for (const r of rooms) {
    if (r.messages.length === 0) continue;
    const header = r.topic
      ? `Room ${r.code} ("${r.topic}") — joined as "${r.selfName}":`
      : `Room ${r.code} — joined as "${r.selfName}":`;
    lines.push(header);
    for (const m of r.messages) {
      const role = m.role ? ` (${m.role})` : '';
      lines.push(`  • ${m.name}${role}: ${m.text}`);
    }
    lines.push('');
  }
  lines.push(
    'If a reply would move the discussion forward, call room_send. Otherwise, acknowledge silently — do not reply for the sake of replying.'
  );
  return lines.join('\n');
}

async function commitCursors(rooms: PendingRoom[], scope: StateScope): Promise<void> {
  for (const r of rooms) {
    if (scope === 'harness') {
      await updateCursorEverywhere(r.code, r.newCursor);
    } else {
      await updateCursor(r.code, r.newCursor);
    }
  }
}

async function readStdin(): Promise<HookInput> {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    const done = (input: HookInput) => {
      if (resolved) return;
      resolved = true;
      resolve(input);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try { done(JSON.parse(data) as HookInput); }
      catch { done({}); }
    });
    // If the hook is invoked without piped stdin (e.g. manual test), don't hang.
    setTimeout(() => done({}), 1500);
  });
}

export interface RunHookIO {
  stdout?: (data: string) => void;
  exit?: (code: number) => void;
}

export async function runHook(testInput?: HookInput, io?: RunHookIO): Promise<void> {
  const exitProcess = io?.exit ?? ((code: number) => process.exit(code));
  try {
    await executeHook(testInput, io);
  } catch {
    // A Stop hook that throws is reported as "hook exited with code 1" and
    // drops the agent out of the room. Exit 0: no continuation, no failure.
    exitProcess(0);
  }
}

async function executeHook(testInput: HookInput | undefined, io: RunHookIO | undefined): Promise<void> {
  const writeStdout = io?.stdout ?? ((d: string) => process.stdout.write(d));
  const exitProcess = io?.exit ?? ((code: number) => process.exit(code));

  const input = testInput ?? (await readStdin());
  // Normalize the event name across clients. Cursor only fires the stop
  // hook (no UserPromptSubmit / SessionStart equivalent today). Older
  // Cursor hook docs/examples showed `{ status, loop_count }` without a
  // `hook_event_name`, while current Cursor payloads may include
  // `{ hook_event_name: "stop", status, loop_count }`. Collapse both into
  // our internal "Stop" event so Cursor still gets `followup_message`.
  // Claude Code / Codex still send their own event names.
  // An empty stdin payload (e.g. manual test invocation) falls through to
  // a no-op — we used to default to 'Stop' which could trigger phantom
  // long-polls; now we only act when we actually got an event.
  const classified = classifyHookInput(input);
  if (!classified) {
    exitProcess(0);
    return;
  }
  const { event, cursorMode } = classified;
  const sessionKey = resolveHookSessionKey(input);
  // Cursor may start the MCP server and Stop hook under different wrapper
  // processes, so its PPID-scoped state files do not always match. Cursor
  // keeps its stable harness state; Codex uses the PPID-scoped state here to
  // avoid a cross-thread shared file when Desktop exposes no run id.
  const harnessKind = detectHarness().kind;
  // Codex Desktop does not always expose a thread run id. In that case the
  // PPID-scoped state is the safest available boundary; the legacy shared
  // Codex harness file would make separate desktop threads see each other's
  // rooms. Cursor retains harness scope for integrations that lack a stable
  // per-process parent relationship.
  //
  // Claude Code joins them when it exports CLAUDE_CODE_SESSION_ID, for the
  // reason Cursor is here: the PPID files do NOT match across processes. Both
  // sides run through `npx`, so the server's parent is one `npm exec` and this
  // hook's parent is another — the hook read an empty file and never blocked.
  // The run-scoped harness file is written by the same server on join, so it is
  // the only state both processes can agree on.
  const stateScope: StateScope =
    cursorMode || (harnessKind === 'claude-code' && hasRunScopedHarnessState())
      ? 'harness'
      : 'scoped';

  // A real user turn begins a fresh bounded continuation cycle.
  if (event === 'UserPromptSubmit') {
    try { await resetStopContinuationBudget(stateScope); }
    catch { /* non-essential */ }
  }

  // An HTTP-configured client never ran the stdio server, so nothing local
  // recorded the join. Read it back out of the session's own transcript
  // before deciding there is no room to keep alive.
  try { await recoverRoomsFromTranscript(stateScope, input.transcript_path, sessionKey); }
  catch { /* non-essential */ }

  const isManaged = process.env.AGENT_ROOM_MANAGED === '1';

  // Daemon-managed session: NEVER auto-continue under any circumstances.
  // Hand off cursors for active rooms and exit.
  if (event === 'Stop' && isManaged) {
    try {
      let pending: PendingRoom[] = [];
      try {
        pending = await fetchPending(stateScope, sessionKey);
        await commitCursors(pending, stateScope);
      } catch { /* ignore */ }

      const state = await readHookState(stateScope);
      const client = createRoomApiClient();
      let handedOff = false;
      for (const [code, r] of Object.entries(state.rooms)) {
        if (!roomBelongsToSession(r, sessionKey)) continue;
        handedOff = true;
        await performHandoff(client, {
          code,
          name: r.name,
          cursor: r.cursor,
          seatKey: r.seatKey,
          sessionId: r.sessionKey ?? sessionKey,
        });
      }
      // HTTP MCP joins do not write the stdio state file. The daemon puts the
      // seat on the process env; sleep from that so a managed turn can go idle
      // and the next @ can wake it.
      if (!handedOff) {
        const code = process.env.AGENT_ROOM_CODE?.trim();
        const name = process.env.AGENT_ROOM_NAME?.trim();
        const seatKey = process.env.AGENT_ROOM_SEAT_KEY?.trim();
        const cursor = Number(process.env.AGENT_ROOM_CURSOR);
        if (code && name && seatKey && Number.isFinite(cursor)) {
          await performHandoff(client, { code, name, cursor, seatKey, sessionId: sessionKey });
        }
      }
      await resetStopContinuationBudget(stateScope);
    } catch { /* best-effort handoff before exit */ }
    exitProcess(0);
    return;
  }

  let pending: PendingRoom[];
  try {
    pending = await fetchPending(stateScope, sessionKey);
  } catch {
    try { await resetStopContinuationBudget(stateScope); }
    catch { /* non-essential */ }
    exitProcess(0);
    return;
  }

  try {
    await commitCursors(pending, stateScope); // advance cursors even when only own-messages were skipped
  } catch { /* a state-file write must not fail the hook */ }

  const withAnyMessages = pending.filter((r) => r.messages.length > 0);
  let hasMention = withAnyMessages.some((r) =>
    r.messages.some((m) => messageMentionsAgent(m, r.selfName))
  );

  let accumulatedRooms: PendingRoom[] = [...withAnyMessages];

  // Stop hook: listen exactly one round (the long-poll window) if no @ arrived yet:
  if (!hasMention && event === 'Stop') {
    const state = await readHookState(stateScope);
    const hasActiveRoom = Object.values(state.rooms).some((r) => roomBelongsToSession(r, sessionKey));
    if (hasActiveRoom) {
      const deadline = Date.now() + getPollMaxMs();
      let pollDelay = getPollIntervalMs();
      while (Date.now() < deadline) {
        await sleep(pollDelay);
        pollDelay = Math.min(Math.floor(pollDelay * 1.5), 5_000);
        let p: PendingRoom[];
        try { p = await fetchPending(stateScope, sessionKey); }
        catch { break; }
        await commitCursors(p, stateScope);
        const got = p.filter((r) => r.messages.length > 0);
        if (got.length > 0) {
          for (const newRoom of got) {
            const existing = accumulatedRooms.find((r) => r.code === newRoom.code);
            if (existing) {
              existing.messages.push(...newRoom.messages);
              existing.newCursor = newRoom.newCursor;
            } else {
              accumulatedRooms.push(newRoom);
            }
          }
          if (accumulatedRooms.some((r) => r.messages.some((m) => messageMentionsAgent(m, r.selfName)))) {
            hasMention = true;
            break;
          }
        }
      }
    }
  }

  // If messages addressing this agent arrived, deliver them and keep the room turn alive
  if (hasMention && event === 'Stop') {
    const text = formatMessages(accumulatedRooms);
    await emitStopContinuation(text, cursorMode, stateScope, true, writeStdout);
    exitProcess(0);
    return;
  }

  // If NO @ for this agent arrived after the listen round:
  if (!hasMention && event === 'Stop') {
    // Check if user explicitly disabled idle sleep (manual sessions opting out of sleep)
    const idleSleepEnabled = process.env.AGENT_ROOM_IDLE_SLEEP !== '0' && process.env.AGENT_ROOM_IDLE_SLEEP !== 'false';
    if (!idleSleepEnabled) {
      // Keep legacy active room contract loop if explicitly configured
      let activeRooms: Array<{ code: string; topic: string; selfName: string; cursor: number }> = [];
      try {
        const state = await readHookState(stateScope);
        const apiClient = createRoomApiClient();
        for (const [code, r] of Object.entries(state.rooms)) {
          if (!roomBelongsToSession(r, sessionKey)) continue;
          if (sessionKey && !r.sessionKey) {
            const claimed = await claimRoomSessionEverywhere(code, sessionKey);
            if (!claimed) continue;
            r.sessionKey = sessionKey;
          }
          try {
            const room = await getRoom(apiClient, code);
            const stillIn = room.participants.some(p => p.name === r.name && p.client === 'cc');
            if (room.status !== 'active' || !stillIn) {
              try {
                if (stateScope === 'harness') await removeRoomEverywhere(code);
                else await removeRoom(code);
              } catch { /* non-essential */ }
              continue;
            }
            activeRooms.push({ code, topic: room.topic, selfName: r.name, cursor: r.cursor });
          } catch {
            try {
              if (stateScope === 'harness') await removeRoomEverywhere(code);
              else await removeRoom(code);
            } catch { /* non-essential */ }
          }
        }
      } catch { /* fall through */ }

      if (activeRooms.length > 0) {
        const lines: string[] = [];
        lines.push('[agent-room] No new messages during the long-poll, but you are still in an active room.');
        lines.push('');
        lines.push('ACTIVE ROOM CONTRACT applies.');
        lines.push('');
        lines.push('Call room_listen NOW to stay present. Do NOT call any other tool, do NOT give a final answer, do NOT give a status update, and do NOT end your turn. Silence is normal during pauses; the conversation may resume any moment.');
        lines.push('');
        for (const r of activeRooms) {
          lines.push(`  • room_listen({ code: "${r.code}", since: ${r.cursor} })  // joined as "${r.selfName}"`);
        }
        lines.push('');
        lines.push('After the listen returns, decide: reply with room_send (and queue another room_listen), or call room_listen again to keep waiting. A completed task, status summary, or final answer is NOT a valid reason to stop. The only valid reasons to stop are: room ended, you were removed from participants, or the host explicitly said you can leave.');
        const text = lines.join('\n');
        await emitStopContinuation(text, cursorMode, stateScope, false, writeStdout);
        exitProcess(0);
        return;
      }
    }

    // Default: hand off cursor and exit, do NOT resume session
    try {
      const state = await readHookState(stateScope);
      const client = createRoomApiClient();
      for (const [code, r] of Object.entries(state.rooms)) {
        if (!roomBelongsToSession(r, sessionKey)) continue;
        await performHandoff(client, {
          code,
          name: r.name,
          cursor: r.cursor,
          seatKey: r.seatKey,
          sessionId: r.sessionKey ?? sessionKey,
        });
      }
      await resetStopContinuationBudget(stateScope);
    } catch { /* best-effort handoff before exit */ }
    exitProcess(0);
    return;
  }

  if (withAnyMessages.length === 0) {
    try { await resetStopContinuationBudget(stateScope); }
    catch { /* non-essential */ }
    exitProcess(0);
    return;
  }

  const text = formatMessages(withAnyMessages);

  if (event === 'UserPromptSubmit') {
    writeStdout(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: text,
      },
    }));
  } else if (event === 'SessionStart') {
    writeStdout(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: text,
      },
    }));
  } else {
    writeStdout(text);
  }
  exitProcess(0);
}
