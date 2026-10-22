import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { detectHarness, harnessRunId } from './harness.js';

export function getStateDir(): string {
  return process.env.AGENT_ROOM_STATE_DIR || join(homedir(), '.agent-room');
}

// PPID-scoped state. Two parallel sessions on the same machine end up with
// distinct files — without this, the later writer's `name` would clobber the
// earlier one's, and each session's hook would filter the *other* agent's
// messages as "own" by mistake.
//
// This is a FALLBACK, not the primary identity. It assumes the MCP server and
// the hook command are both spawned directly by the harness and therefore share
// a parent PID — which is false whenever either side runs through `npx`, since
// `npm exec` inserts a process of its own and its pid differs per invocation.
// Harnesses that expose a session id to their child processes (see
// harnessRunId) get a run-scoped file instead; this path only serves the ones
// that do not.
//
// Override with AGENT_ROOM_STATE_FILE to share state across sessions on purpose
// (e.g. integration tests).
export function getStateFile(): string {
  return (
    process.env.AGENT_ROOM_STATE_FILE ||
    join(getStateDir(), `state-${process.ppid ?? process.pid}.json`)
  );
}

function runScopedHarnessStateFile(kind: string): string | null {
  if (process.env.AGENT_ROOM_STATE_FILE) return null;
  const runId = harnessRunId();
  if (!runId) return null;
  // A harness file shared by every thread is not a useful canonical store:
  // one thread can overwrite another thread's rooms, and every Stop hook can
  // then see the wrong room. Keep the stable filename shape for the harness,
  // but include the thread identity supplied by the harness.
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(getStateDir(), `state-harness-${kind}-${safeRunId}.json`);
}

function currentHarnessStateFile(): string | null {
  if (process.env.AGENT_ROOM_STATE_FILE) return null;
  const kind = detectHarness().kind;
  if (kind !== 'cursor' && kind !== 'codex' && kind !== 'claude-code') return null;
  const scoped = runScopedHarnessStateFile(kind);
  if (scoped) return scoped;
  // Codex Desktop does not currently expose a run id in every integration, and
  // a Claude Code old enough to not export CLAUDE_CODE_SESSION_ID is in the
  // same position. A SHARED harness file is unsafe there: it would broadcast
  // rooms to every thread on that harness. Fall back to the PPID-scoped file.
  if (kind === 'codex' || kind === 'claude-code') return null;
  return join(getStateDir(), `state-harness-${kind}.json`);
}

/** True when this process can resolve a run-scoped harness state file, i.e. the
 *  harness hands both the MCP server and the hook the same session identity.
 *  The hook uses this to pick its state scope: with a shared identity the
 *  harness file is authoritative, without one the PPID file is all there is. */
export function hasRunScopedHarnessState(): boolean {
  if (process.env.AGENT_ROOM_STATE_FILE) return false;
  return Boolean(runScopedHarnessStateFile(detectHarness().kind));
}

export interface RoomState {
  name: string;
  cursor: number;
  joinedAt: number;
  lastSentAt?: number;
  gameVersion?: number;
  // Stored when this MCP session is the host of the room (room_create).
  // Required to claim the host display name on rejoin / reconnect; without
  // it, joinRoom rejects with HostNameTakenError. Plain text on disk under
  // ~/.agent-room/ — same trust level as the MCP state itself.
  hostKey?: string;
  // Codex `session_id` / Cursor `conversation_id` that owns this join.
  // Shared harness state (`state-harness-codex.json` / `state-harness-cursor.json`)
  // is otherwise visible to EVERY thread on that harness — without this key,
  // a Reddit-work Codex chat would keep getting stop-hook room contract
  // injections for a different thread that joined an Agent Room.
  sessionKey?: string;
  // Harness client kind (e.g. 'codex', 'cursor', 'antigravity') that joined the room.
  clientKind?: string;
  // Harness run id (see harnessRunId) of the thread that performed the join,
  // recorded at join time. `clientKind` only partitions by client *type*, so
  // two Codex threads still share a partition; this is what separates them.
  ownerRunId?: string;
  // Per-seat credential returned by joinRoom for managed wakeups and handoffs.
  seatKey?: string;
}

/**
 * True when this room should receive stop-hook keep-alive for `sessionKey`.
 *
 * Order matters, and it must fail CLOSED once a room has an owner. The first
 * cut of this checked `!sessionKey` first and returned true — "legacy
 * behaviour" — which reopened the exact hole the session key exists to close:
 * a Codex Stop payload that carries no `session_id` resolves to undefined, so
 * an unrelated thread (Robin's Reddit chat, 2026-08-05) kept getting the room
 * contract injected even though the room was demonstrably claimed by another
 * session. A claimed room plus an anonymous caller is not a legacy setup — it
 * is precisely the leak.
 *
 * Genuinely legacy state (joined before sessionKey existed, so `room.sessionKey`
 * is unset) still gets the permissive path and stays claimable.
 *
 * `ownerRunId` is checked BEFORE the claim path, and it is what closes the
 * remaining hole: `clientKind` partitions by client *type*, so two Codex threads
 * land in the same partition and an unclaimed room is still up for grabs by
 * whichever of them reaches Stop first. Binding at join time means the room was
 * never up for grabs. The check only fires when BOTH sides have a run id — a
 * harness that exposes none behaves exactly as before.
 */
export function roomBelongsToSession(
  room: RoomState,
  sessionKey: string | undefined,
): boolean {
  const currentKind = detectHarness().kind;
  // `unknown` on either side is a DETECTION FAILURE, not evidence that the room
  // belongs to somebody else — so it must not disqualify the room. Observed
  // 2026-08-19: the Claude desktop app spawns the MCP server from
  // claude_desktop_config.json, which carried no CLAUDECODE marker, so the
  // server stamped rooms `clientKind: 'unknown'`; the Stop hook is spawned by
  // Claude Code itself, sees CLAUDECODE=1, and resolved 'claude-code'. The two
  // never matched, this check rejected every room, the hook stayed silent, and
  // the agent silently dropped out one turn after joining.
  //
  // Fail OPEN on `unknown` specifically. Two *known* kinds still partition (a
  // Codex thread never picks up a Cursor room), and `sessionKey` / `ownerRunId`
  // below remain the real ownership checks. The downside of being wrong here is
  // one spurious keep-alive; the downside of being wrong the other way is the
  // agent dropping out of every room, which is what we had.
  const kindKnown = currentKind !== 'unknown' && room.clientKind !== 'unknown';
  if (room.clientKind && kindKnown && room.clientKind !== currentKind) return false;
  const currentRunId = harnessRunId();
  if (room.ownerRunId && currentRunId && room.ownerRunId !== currentRunId) return false;
  if (!room.sessionKey) return true; // unclaimed / pre-sessionKey state; caller may claim it
  if (!sessionKey) return false; // room has an owner and this caller has no identity — not theirs
  return room.sessionKey === sessionKey;
}

export interface AgentRoomState {
  version: 1;
  rooms: Record<string, RoomState>;
  // Number of consecutive Stop-hook blocks since the last UserPromptSubmit.
  // Used to cap autonomous chat back-and-forth so it can't loop forever
  // without the user typing.
  blockStreak?: number;
}

const EMPTY: AgentRoomState = { version: 1, rooms: {}, blockStreak: 0 };

function cloneEmpty(): AgentRoomState {
  return { ...EMPTY, rooms: {} };
}

function isValidState(parsed: AgentRoomState): boolean {
  return parsed.version === 1 && typeof parsed.rooms === 'object' && parsed.rooms !== null;
}

async function readStateFile(file: string): Promise<AgentRoomState> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as AgentRoomState;
    if (!isValidState(parsed)) return cloneEmpty();
    return parsed;
  } catch {
    return cloneEmpty();
  }
}

export async function readState(): Promise<AgentRoomState> {
  return readStateFile(getStateFile());
}

/**
 * Pick which of two records for the same room code survives the merge.
 *
 * Recency alone is wrong. Two clients in the same room each write their own
 * state file, and the merged record keeps exactly one `clientKind` — so
 * "newest wins" means the client that joined LAST silently takes ownership of
 * the room record every other client reads, and the earlier client's own room
 * fails its `clientKind` check afterwards. Observed 2026-08-05: a Claude
 * Desktop join 118s after an Antigravity join flipped the shared record to
 * `unknown`, which is also the only reason a Codex thread stopped matching it.
 * Isolation that depends on join order is not isolation.
 *
 * So: a record whose `clientKind` matches the harness doing the read always
 * beats one that does not. Recency only breaks ties within the same kind.
 */
function preferredRoomRecord(a: RoomState, b: RoomState, currentKind: string): RoomState {
  const aMatches = a.clientKind === currentKind;
  const bMatches = b.clientKind === currentKind;
  if (aMatches !== bMatches) return aMatches ? a : b;
  return a.joinedAt >= b.joinedAt ? a : b;
}

export function mergeStates(states: AgentRoomState[]): AgentRoomState {
  const merged = cloneEmpty();
  const currentKind = detectHarness().kind;

  for (const state of states) {
    merged.blockStreak = Math.max(merged.blockStreak ?? 0, state.blockStreak ?? 0);

    for (const [code, room] of Object.entries(state.rooms)) {
      const existing = merged.rooms[code];
      if (!existing) {
        merged.rooms[code] = { ...room };
        continue;
      }

      const winner = preferredRoomRecord(room, existing, currentKind);
      // Identity fields come from the winner ALONE — never `winner.x ?? loser.x`.
      // Grafting a loser's sessionKey / ownerRunId onto the winner would hand
      // the winner an owner it never had, which is the same cross-thread leak
      // one level down.
      merged.rooms[code] = {
        ...winner,
        // Cursors and send timestamps are safe to take the max of: they only
        // guard against replaying messages, and both records saw the room.
        cursor: Math.max(existing.cursor, room.cursor),
        lastSentAt: Math.max(existing.lastSentAt ?? 0, room.lastSentAt ?? 0) || undefined,
        gameVersion: Math.max(existing.gameVersion ?? -1, room.gameVersion ?? -1) >= 0
          ? Math.max(existing.gameVersion ?? -1, room.gameVersion ?? -1)
          : undefined,
        hostKey: winner.hostKey ?? existing.hostKey ?? room.hostKey,
        seatKey: winner.seatKey ?? existing.seatKey ?? room.seatKey,
      };
    }
  }

  return merged;
}

async function listStateFiles(): Promise<string[]> {
  if (process.env.AGENT_ROOM_STATE_FILE) return [getStateFile()];

  let files: string[] = [];
  try {
    const entries = await fs.readdir(getStateDir());
    files = entries
      .filter((name) => /^state-(?:\d+|harness-[a-z-]+(?:-[a-zA-Z0-9._-]+)?)\.json$/.test(name))
      .map((name) => join(getStateDir(), name));
  } catch {
    files = [];
  }

  return Array.from(new Set([...files, getStateFile(), currentHarnessStateFile()].filter(Boolean) as string[]));
}

export async function readMergedState(): Promise<AgentRoomState> {
  const files = await listStateFiles();
  const states = await Promise.all(files.map(readStateFile));
  return mergeStates(states);
}

export async function readRoomStateForJoin(code: string, desiredName: string): Promise<RoomState | undefined> {
  const current = (await readState()).rooms[code];
  if (current) return current;

  const files = await listStateFiles();
  const states = await Promise.all(files.map(readStateFile));
  return states
    .map((state) => state.rooms[code])
    .filter((room): room is RoomState => Boolean(room && room.name === desiredName))
    .sort((a, b) => b.joinedAt - a.joinedAt)[0];
}

/**
 * State a Cursor / Codex hook should act on.
 *
 * The harness file is the canonical store for those two harnesses: every join
 * under them writes it (see writeState), so "harness file exists but lists no
 * rooms" means this harness genuinely is not in any room — NOT that we should
 * go looking elsewhere.
 *
 * The previous `rooms.length > 0` guard fell through to readMergedState() on an
 * empty harness file, i.e. on every Stop of every Codex thread that is not in a
 * room. That read EVERY client's state file — the exact cross-client leak the
 * harness scope exists to prevent, and it ran before `clientKind` got a chance
 * to filter anything. The merged fallback now only applies to state written
 * before the harness file existed (< 0.26.6), detected by the file's absence.
 */
export async function readHarnessStateOrMerged(): Promise<AgentRoomState> {
  const harnessFile = currentHarnessStateFile();
  if (harnessFile) {
    const exists = await fs
      .access(harnessFile)
      .then(() => true)
      .catch(() => false);
    if (exists) return readStateFile(harnessFile);
    // With a thread-scoped harness identity, an absent file means this
    // thread has not joined a room. Never fall back to the legacy shared
    // harness file: doing so reintroduces cross-thread Stop-hook injections.
    //
    // Claude Code is the exception, and only until its next join: a room joined
    // by a pre-0.26.22 server (or by a stale copy still in the npx cache) sits
    // in a PPID file that no longer gets read, so an absent harness file there
    // means "not written yet", not "no rooms". Fall through to the merged read,
    // which roomBelongsToSession still filters by clientKind / sessionKey.
    const kind = detectHarness().kind;
    if (kind !== 'claude-code' && runScopedHarnessStateFile(kind)) return cloneEmpty();
  }
  return readMergedState();
}

/** Windows `fs.rename` cannot replace an existing file (EPERM/EEXIST). */
async function replaceFile(tmp: string, file: string): Promise<void> {
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST') throw error;
    await fs.rm(file, { force: true });
    await fs.rename(tmp, file);
  }
}

async function writeStateFile(file: string, state: AgentRoomState): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  // 0600: the file carries hostKey; don't leave it group/world-readable on
  // shared machines. The tmp file is recreated on every write, so the mode always applies.
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  await replaceFile(tmp, file);
}

/** Age after which a dead session's state file is discarded even if it still
 *  lists rooms. Long enough that `readRoomStateForJoin` can still recover a
 *  name / cursor after a crash-and-restart, short enough that the directory
 *  does not grow without bound. */
const STALE_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything. EPERM means the process exists but is owned by someone else.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Delete `state-<pid>.json` files left behind by sessions that are gone.
 *
 * PID-scoped state is per MCP-server process, and every one of them leaks its
 * file at exit — 65 had accumulated on Robin's machine by 2026-08-19. They are
 * not merely clutter: `readMergedState` reads every one of them on each hook
 * run, so the cost of a stale file is paid on every Stop.
 *
 * Conservative on purpose: a file is only removed when its owning PID is dead
 * AND it either lists no rooms or is older than STALE_STATE_MAX_AGE_MS. A dead
 * session that still holds rooms is exactly what a restart wants to recover
 * from, so it is kept for the grace window.
 */
export async function reapStaleStateFiles(now = Date.now()): Promise<number> {
  if (process.env.AGENT_ROOM_STATE_FILE) return 0;
  let entries: string[];
  try {
    entries = await fs.readdir(getStateDir());
  } catch {
    return 0;
  }

  let reaped = 0;
  for (const name of entries) {
    const match = /^state-(\d+)\.json$/.exec(name);
    if (!match) continue;
    const file = join(getStateDir(), name);
    if (file === getStateFile()) continue;
    if (pidIsAlive(Number(match[1]))) continue;
    try {
      const stat = await fs.stat(file);
      const state = await readStateFile(file);
      const empty = Object.keys(state.rooms).length === 0;
      if (!empty && now - stat.mtimeMs < STALE_STATE_MAX_AGE_MS) continue;
      await fs.unlink(file);
      reaped++;
    } catch {
      // Racing with another process's write or unlink — leave it for next time.
    }
  }
  return reaped;
}

// Reaping scans the whole directory, so do it once per process rather than on
// every write. Fire-and-forget: a failed sweep must never fail a room action.
let reapStarted = false;
function reapStaleStateFilesOnce(): void {
  if (reapStarted) return;
  reapStarted = true;
  void reapStaleStateFiles().catch(() => {});
}

async function writeState(state: AgentRoomState): Promise<void> {
  await writeStateFile(getStateFile(), state);
  const harnessFile = currentHarnessStateFile();
  if (harnessFile) await writeStateFile(harnessFile, state);
  reapStaleStateFilesOnce();
}


// ---- Cross-process state lock ----------------------------------------------
// The MCP server and the Stop/SessionStart hooks are separate processes that
// all read-modify-write the same state files. Without a lock, two concurrent
// writers both read the same snapshot and the second write silently drops the
// first one's update (lost cursor advance → replayed/missed messages; lost
// blockStreak bump → the autonomous-loop cap stops working). `mkdir` is atomic
// on every platform, so an empty lock directory is the mutex; a stale lock
// (holder crashed) is stolen after LOCK_STALE_MS — hook processes live for
// seconds, so 5s is generous.
function getLockDir(): string {
  return join(getStateDir(), '.state-lock');
}
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_TRIES = 40; // ~1s worst case, then proceed unlocked

async function acquireStateLock(): Promise<boolean> {
  const lockDir = getLockDir();
  for (let i = 0; i < LOCK_MAX_TRIES; i++) {
    try {
      await fs.mkdir(lockDir);
      return true;
    } catch {
      try {
        const st = await fs.stat(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(lockDir).catch(() => { /* raced another stealer */ });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  // Never deadlock the user's agent over a stuck lock — worst case we are
  // back to the old (lossy but functional) unlocked behaviour for one call.
  return false;
}

async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(getStateDir(), { recursive: true }).catch(() => { /* readState handles missing dir */ });
  const locked = await acquireStateLock();
  try {
    return await fn();
  } finally {
    if (locked) await fs.rmdir(getLockDir()).catch(() => { /* already released */ });
  }
}

export async function setRoom(code: string, room: RoomState): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    state.rooms[code] = room;
    await writeState(state);
  });
}

export async function removeRoom(code: string): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    if (code in state.rooms) {
      delete state.rooms[code];
      await writeState(state);
    }
  });
}

export async function updateCursor(code: string, cursor: number): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    const room = state.rooms[code];
    if (!room) return;
    if (cursor <= room.cursor) return;
    room.cursor = cursor;
    await writeState(state);
  });
}

export async function updateGameVersion(code: string, gameVersion: number): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    const room = state.rooms[code];
    if (!room || (room.gameVersion ?? -1) >= gameVersion) return;
    room.gameVersion = gameVersion;
    await writeState(state);
  });
}

export async function updateCursorEverywhere(code: string, cursor: number): Promise<void> {
  await withStateLock(async () => {
    const files = await listStateFiles();
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      const room = state.rooms[code];
      if (!room || cursor <= room.cursor) return;
      room.cursor = cursor;
      await writeStateFile(file, state);
    }));
  });
}

export async function markSent(code: string, at: number): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    const room = state.rooms[code];
    if (!room) return;
    room.lastSentAt = at;
    await writeState(state);
  });
}

export async function bumpBlockStreak(): Promise<number> {
  return withStateLock(async () => {
    const state = await readState();
    state.blockStreak = (state.blockStreak ?? 0) + 1;
    await writeState(state);
    return state.blockStreak;
  });
}

export async function bumpBlockStreakEverywhere(): Promise<number> {
  return withStateLock(async () => {
    const next = ((await readMergedState()).blockStreak ?? 0) + 1;
    const files = await listStateFiles();
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      state.blockStreak = next;
      await writeStateFile(file, state);
    }));
    return next;
  });
}

export async function resetBlockStreak(): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    if (!state.blockStreak) return;
    state.blockStreak = 0;
    await writeState(state);
  });
}

export async function resetBlockStreakEverywhere(): Promise<void> {
  await withStateLock(async () => {
    const files = await listStateFiles();
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      if (!state.blockStreak) return;
      state.blockStreak = 0;
      await writeStateFile(file, state);
    }));
  });
}

export async function removeRoomEverywhere(code: string): Promise<void> {
  await withStateLock(async () => {
    const files = await listStateFiles();
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      if (!(code in state.rooms)) return;
      delete state.rooms[code];
      await writeStateFile(file, state);
    }));
  });
}

/**
 * Stamp `sessionKey` onto a room that has none yet (first Stop after join).
 * Writes across the caller's own state files so harness + PPID copies stay
 * aligned. Returns false if the room is already claimed by someone else.
 *
 * "Everywhere" is deliberately narrower than it used to be. The first version
 * stamped every state file on disk that mentioned the code, so one Stop wrote
 * this session's id into OTHER clients' records for the same room — that is how
 * two different agents ended up sharing one sessionKey. A record belonging to a
 * different client kind, or to a different thread of this kind, is another
 * session's business; skip it and leave it untouched.
 */
export async function claimRoomSessionEverywhere(
  code: string,
  sessionKey: string,
): Promise<boolean> {
  const currentKind = detectHarness().kind;
  const currentRunId = harnessRunId();
  return withStateLock(async () => {
    const files = await listStateFiles();
    let ok = true;
    await Promise.all(files.map(async (file) => {
      const state = await readStateFile(file);
      const room = state.rooms[code];
      if (!room) return;
      // Not ours to stamp — and not a reason to fail the claim either.
      if (room.clientKind && room.clientKind !== currentKind) return;
      if (room.ownerRunId && currentRunId && room.ownerRunId !== currentRunId) return;
      if (room.sessionKey && room.sessionKey !== sessionKey) {
        ok = false;
        return;
      }
      if (room.sessionKey === sessionKey) return;
      room.sessionKey = sessionKey;
      await writeStateFile(file, state);
    }));
    return ok;
  });
}

// ---- Local cursor handoff (M0 / M5) ----------------------------------------

export interface HandoffRecord {
  code: string;
  name: string;
  cursor: number;
  seatKey?: string;
  sessionId?: string;
  at: number;
}

export function handoffFilePath(code?: string): string {
  if (process.env.AGENT_ROOM_HANDOFF_FILE) return process.env.AGENT_ROOM_HANDOFF_FILE;
  if (code) return join(getStateDir(), `handoff-${code}.json`);
  return join(getStateDir(), 'handoff.json');
}

export async function writeHandoff(record: HandoffRecord): Promise<void> {
  const dir = getStateDir();
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const data = JSON.stringify(record, null, 2);

  // 1. Write per-room handoff file (e.g. handoff-ABC-123-XYZ.json)
  const roomFile = join(dir, `handoff-${record.code}.json`);
  const roomTmp = roomFile + '.tmp';
  await fs.writeFile(roomTmp, data, { encoding: 'utf8', mode: 0o600 });
  await replaceFile(roomTmp, roomFile);

  // 2. Also write/update general handoff.json
  const mainFile = join(dir, 'handoff.json');
  let mainState: { version: 1; handoffs: Record<string, HandoffRecord>; latest?: HandoffRecord } = {
    version: 1,
    handoffs: {},
  };
  try {
    const raw = await fs.readFile(mainFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      mainState = {
        version: 1,
        handoffs: parsed.handoffs && typeof parsed.handoffs === 'object' ? parsed.handoffs : {},
      };
    }
  } catch {
    // initialize fresh
  }
  mainState.handoffs[record.code] = record;
  mainState.latest = record;

  const combined = {
    ...mainState,
    code: record.code,
    name: record.name,
    cursor: record.cursor,
    seatKey: record.seatKey,
    sessionId: record.sessionId,
    at: record.at,
  };
  const mainTmp = mainFile + '.tmp';
  await fs.writeFile(mainTmp, JSON.stringify(combined, null, 2), { encoding: 'utf8', mode: 0o600 });
  await replaceFile(mainTmp, mainFile);

  // 3. If AGENT_ROOM_HANDOFF_FILE is explicitly set in env, write to it as well
  if (process.env.AGENT_ROOM_HANDOFF_FILE) {
    const customFile = process.env.AGENT_ROOM_HANDOFF_FILE;
    await fs.mkdir(dirname(customFile), { recursive: true }).catch(() => {});
    const customTmp = customFile + '.tmp';
    await fs.writeFile(customTmp, data, { encoding: 'utf8', mode: 0o600 });
    await replaceFile(customTmp, customFile);
  }
}

export async function readHandoff(code?: string): Promise<HandoffRecord | null> {
  const target = handoffFilePath(code);
  try {
    const raw = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.cursor === 'number' && typeof parsed.code === 'string') {
        return parsed as HandoffRecord;
      }
      if (code && parsed.handoffs && parsed.handoffs[code]) {
        return parsed.handoffs[code] as HandoffRecord;
      }
      if (parsed.latest) {
        return parsed.latest as HandoffRecord;
      }
    }
    return null;
  } catch {
    return null;
  }
}

