// HTTP client for the agent-room server API (`POST /api/room`).
//
// The MCP server used to talk to Upstash Redis directly, which meant the
// Redis REST token had to live in the environment of every machine running
// the npm package. agent-room is a single hosted backend, so that token is
// effectively a shared master credential — it must never leave the server.
// This module routes every room operation through the same `/api/room`
// endpoint the web client uses; the token now lives only in the Vercel
// deployment's server env.
//
// Base URL is overridable via AGENT_ROOM_BASE_URL (same env var
// uploadAttachment.ts already uses) so self-hosters can point at their own
// deploy.

import type {
  ClientKind,
  Message,
  Participant,
  ReplyMode,
  ReplyModeConfig,
  Room,
  RoomReport,
  Task,
  TaskBoard,
} from '@agent-room/shared';
import type { AppendResult, TurnState, TurnSpokenEntry, GameView } from '@agent-room/upstash-client';

// Errors reconstructed from the API response body. The server serializes
// thrown errors as `{ error: <ErrorName>, message }`; we re-hydrate the few
// the MCP tool handlers branch on so existing `instanceof` checks keep
// working after the transport swap.
export class RoomApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RoomApiError';
    this.status = status;
  }
}
export class RoomNotFoundError extends Error { constructor(m: string) { super(m); this.name = 'RoomNotFoundError'; } }
export class HostNameTakenError extends Error { constructor(m: string) { super(m); this.name = 'HostNameTakenError'; } }
export class InterviewRoomBusyError extends Error { constructor(m: string) { super(m); this.name = 'InterviewRoomBusyError'; } }
export class MutedError extends Error { constructor(m: string) { super(m); this.name = 'MutedError'; } }
export class NotYourTurnError extends Error { constructor(m: string) { super(m); this.name = 'NotYourTurnError'; } }
// (name, client) is not a joined participant at all — distinct from MutedError
// (a joined participant the host silenced). The server used to report both as
// MutedError, which told an agent that had never actually joined the room
// (e.g. sending under a stale or unresolved display name) to sit and wait for
// a host to unmute someone who was never a participant. See tools.ts's
// room_send/room_status catch blocks.
export class NotParticipantError extends Error { constructor(m: string) { super(m); this.name = 'NotParticipantError'; } }
export class NotHostError extends Error { constructor(m: string) { super(m); this.name = 'NotHostError'; } }
export class InvalidModeConfigError extends Error { constructor(m: string) { super(m); this.name = 'InvalidModeConfigError'; } }
export class ModeNotSupportedError extends Error { constructor(m: string) { super(m); this.name = 'ModeNotSupportedError'; } }
export class TaskNotFoundError extends Error { constructor(m: string) { super(m); this.name = 'TaskNotFoundError'; } }
export class TaskExistsError extends Error { constructor(m: string) { super(m); this.name = 'TaskExistsError'; } }
export class TaskStateError extends Error { constructor(m: string) { super(m); this.name = 'TaskStateError'; } }
export class EvidenceIncompleteError extends Error { constructor(m: string) { super(m); this.name = 'EvidenceIncompleteError'; } }
export class NotVerifierError extends Error { constructor(m: string) { super(m); this.name = 'NotVerifierError'; } }
export class OwnerCannotVerifyError extends Error { constructor(m: string) { super(m); this.name = 'OwnerCannotVerifyError'; } }
export class TaskDoneImmutableError extends Error { constructor(m: string) { super(m); this.name = 'TaskDoneImmutableError'; } }

function errorFromBody(error: string | undefined, message: string, status: number): Error {
  switch (error) {
    case 'RoomNotFoundError': return new RoomNotFoundError(message);
    case 'HostNameTakenError': return new HostNameTakenError(message);
    case 'InterviewRoomBusyError': return new InterviewRoomBusyError(message);
    case 'MutedError': return new MutedError(message);
    case 'NotYourTurnError': return new NotYourTurnError(message);
    case 'NotParticipantError': return new NotParticipantError(message);
    case 'NotHostError': return new NotHostError(message);
    case 'InvalidModeConfigError': return new InvalidModeConfigError(message);
    case 'ModeNotSupportedError': return new ModeNotSupportedError(message);
    case 'TaskNotFoundError': return new TaskNotFoundError(message);
    case 'TaskExistsError': return new TaskExistsError(message);
    case 'TaskStateError': return new TaskStateError(message);
    case 'EvidenceIncompleteError': return new EvidenceIncompleteError(message);
    case 'NotVerifierError': return new NotVerifierError(message);
    case 'OwnerCannotVerifyError': return new OwnerCannotVerifyError(message);
    case 'TaskDoneImmutableError': return new TaskDoneImmutableError(message);
    default: return new RoomApiError(message, status);
  }
}

function apiEndpoint(): string {
  // The desktop daemon exports AGENT_ROOM_SERVER. Hooks inherit that even when
  // the MCP config has not yet been rewritten with AGENT_ROOM_BASE_URL.
  const base = (process.env.AGENT_ROOM_BASE_URL || process.env.AGENT_ROOM_SERVER || 'https://www.agent-room.com').replace(/\/$/, '');
  return `${base}/api/room`;
}

export interface RoomApiClient {
  post<T>(payload: Record<string, unknown>): Promise<T>;
}

export function createRoomApiClient(): RoomApiClient {
  const endpoint = apiEndpoint();
  return {
    async post<T>(payload: Record<string, unknown>): Promise<T> {
      let resp: Response;
      try {
        resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'network failure';
        throw new RoomApiError(`POST ${endpoint} failed: ${msg}`, 0);
      }
      const body = (await resp.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        [k: string]: unknown;
      };
      if (!resp.ok) {
        throw errorFromBody(body.error, body.message ?? `Room API failed (${resp.status})`, resp.status);
      }
      return body as T;
    },
  };
}

export async function createRoom(
  client: RoomApiClient,
  input: { topic: string; createdBy: string; projectId?: string; projectKey?: string },
): Promise<Room & { hostKey: string }> {
  const body = await client.post<{ room: Room & { hostKey: string }; hostKey: string }>({
    action: 'create',
    topic: input.topic,
    createdBy: input.createdBy,
    // Optional durable-project attach (capability key proves authority).
    ...(input.projectId ? { projectId: input.projectId, projectKey: input.projectKey } : {}),
  });
  return { ...body.room, hostKey: body.hostKey };
}

export async function getRoom(client: RoomApiClient, code: string): Promise<Room> {
  const body = await client.post<{ room: Room }>({ action: 'get', code });
  return body.room;
}

export async function joinRoom(
  client: RoomApiClient,
  code: string,
  participant: Participant,
  options: { hostKey?: string; priorIdentity?: { name: string; client: 'web' | 'cc' } } = {},
): Promise<Room & { participant: Participant; agentContext?: string; roomPolicy?: string; policyVersion?: number }> {
  const body = await client.post<{
    room: Room;
    participant: Participant;
    // Canonical shared context + policy (PRD §2.6) — the same text hosted
    // agents get in their system prompt. Present on servers ≥ the parity
    // release; older servers just omit them.
    agentContext?: string;
    roomPolicy?: string;
    policyVersion?: number;
  }>({
    action: 'join',
    code,
    participant,
    hostKey: options.hostKey,
    priorIdentity: options.priorIdentity,
  });
  return {
    ...body.room,
    participant: body.participant,
    agentContext: body.agentContext,
    roomPolicy: body.roomPolicy,
    policyVersion: body.policyVersion,
  };
}

export async function getMessages(client: RoomApiClient, code: string, since: number): Promise<{ messages: Message[]; total: number | null }> {
  const body = await client.post<{ messages: Message[]; total: number | null }>({ action: 'messages', code, cursor: since });
  return { messages: body.messages, total: typeof body.total === 'number' ? body.total : null };
}

export async function listMessages(client: RoomApiClient, code: string, since: number): Promise<Message[]> {
  return (await getMessages(client, code, since)).messages;
}

// Trigger the server-side turn-timeout sweep and return the current room.
// Replaces the MCP-side getRoom + sweepTimeouts pair: the server runs the
// sweep and emits any timeout / fallback system messages itself.
export async function sweepRoom(client: RoomApiClient, code: string): Promise<Room> {
  const body = await client.post<{ room: Room }>({ action: 'sweep', code });
  return body.room;
}

export async function appendMessage(
  client: RoomApiClient,
  code: string,
  message: Message,
  hostKey?: string,
  kind: 'message' | 'status' = 'message',
): Promise<AppendResult> {
  const body = await client.post<{ result: AppendResult }>({ action: 'send', code, message, hostKey, kind });
  return body.result;
}

export async function appendSystemMessage(
  client: RoomApiClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
  message: Message,
): Promise<void> {
  await client.post({ action: 'systemMessage', code, requesterName, hostKey, message });
}

export async function setListenUntil(
  client: RoomApiClient,
  code: string,
  name: string,
  until: number,
): Promise<void> {
  await client.post({ action: 'presence', code, name, until });
}

export async function getTurnState(client: RoomApiClient, code: string): Promise<TurnState | null> {
  const body = await client.post<{ turnState: TurnState | null }>({ action: 'turnState', code });
  return body.turnState;
}

export async function removeParticipant(
  client: RoomApiClient,
  code: string,
  requesterName: string,
  targetName: string,
  targetClient: 'web' | 'cc',
  hostKey?: string,
): Promise<Room> {
  const body = await client.post<{ room: Room }>({
    action: 'removeParticipant',
    code,
    requesterName,
    targetName,
    targetClient,
    hostKey,
  });
  return body.room;
}

export async function endRoom(
  client: RoomApiClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  const body = await client.post<{ room: Room }>({ action: 'end', code, requesterName, hostKey });
  return body.room;
}

export async function reactivateRoom(
  client: RoomApiClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  const body = await client.post<{ room: Room }>({ action: 'reactivate', code, requesterName, hostKey });
  return body.room;
}

export async function createRoomReport(client: RoomApiClient, code: string): Promise<RoomReport> {
  const body = await client.post<{ report: RoomReport }>({ action: 'createReport', code });
  return body.report;
}

export async function setReplyMode(
  client: RoomApiClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
  mode: ReplyMode,
  config: ReplyModeConfig | undefined,
): Promise<Room> {
  const body = await client.post<{ room: Room }>({
    action: 'setReplyMode',
    code,
    requesterName,
    hostKey,
    mode,
    config,
  });
  return body.room;
}

export async function directInvoke(
  client: RoomApiClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
  target: { name: string; client: 'web' | 'cc' },
  source: 'host' | 'moderator',
): Promise<boolean> {
  const body = await client.post<{ added: boolean }>({
    action: 'directInvoke',
    code,
    requesterName,
    hostKey,
    target,
    source,
  });
  return body.added;
}

export async function hostSkipCurrent(
  client: RoomApiClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<TurnSpokenEntry | null> {
  const body = await client.post<{ skipped: TurnSpokenEntry | null }>({
    action: 'skipCurrent',
    code,
    requesterName,
    hostKey,
  });
  return body.skipped;
}

// ─── Evidence-gated task board ───────────────────────────────────────────

export async function getTaskBoard(client: RoomApiClient, code: string): Promise<TaskBoard> {
  const body = await client.post<{ board: TaskBoard }>({ action: 'taskBoard', code });
  return body.board;
}

export async function createTask(
  client: RoomApiClient,
  code: string,
  requesterName: string,
  input: { title: string; id?: string; owner?: string; ownerClient?: ClientKind; verifier?: string; verifierClient?: ClientKind; dod?: string },
): Promise<{ board: TaskBoard; task: Task }> {
  return client.post<{ board: TaskBoard; task: Task }>({
    action: 'taskCreate', code, requesterName, ...input,
  });
}

export async function claimTask(
  client: RoomApiClient,
  code: string,
  id: string,
  name: string,
  clientKind: ClientKind,
): Promise<{ board: TaskBoard; task: Task }> {
  return client.post<{ board: TaskBoard; task: Task }>({
    action: 'taskClaim', code, id, name, client: clientKind,
  });
}

export async function submitTask(
  client: RoomApiClient,
  code: string,
  id: string,
  name: string,
  clientKind: ClientKind,
  evidence: { fileListing: string; fileExcerpt: string; runOutput: string; exitCode: number },
): Promise<{ board: TaskBoard; task: Task }> {
  return client.post<{ board: TaskBoard; task: Task }>({
    action: 'taskSubmit', code, id, name, client: clientKind, evidence,
  });
}

export async function verifyTask(
  client: RoomApiClient,
  code: string,
  id: string,
  name: string,
  clientKind: ClientKind,
  verdict: 'done' | 'rejected',
  note?: string,
): Promise<{ board: TaskBoard; task: Task }> {
  return client.post<{ board: TaskBoard; task: Task }>({
    action: 'taskVerify', code, id, name, client: clientKind, verdict, note,
  });
}

// Reassign a task's owner and/or verifier without changing its state. Gated
// server-side: the caller must be the proven host (hostKey) or the room's
// configured Moderator/Lead — the server resolves that from stored room
// state, never from this client's claim.
export async function reassignTaskRoles(
  client: RoomApiClient,
  code: string,
  id: string,
  requesterName: string,
  requesterClient: ClientKind,
  patch: { owner?: string; ownerClient?: ClientKind; verifier?: string; verifierClient?: ClientKind },
  hostKey?: string,
): Promise<{ board: TaskBoard; task: Task }> {
  return client.post<{ board: TaskBoard; task: Task }>({
    action: 'taskReassign', code, id, requesterName, requesterClient, hostKey, ...patch,
  });
}

// Archive a task to the cancelled lane. Gated server-side: host/moderator/lead
// only; rejects done/awaiting_review tasks and tasks with submitted evidence.
export async function cancelTask(
  client: RoomApiClient,
  code: string,
  id: string,
  requesterName: string,
  requesterClient: ClientKind,
  hostKey?: string,
  reason?: string,
): Promise<{ board: TaskBoard; task: Task }> {
  return client.post<{ board: TaskBoard; task: Task }>({
    action: 'taskCancel', code, id, requesterName, requesterClient, hostKey, reason,
  });
}

export async function gameAction(client: RoomApiClient, code: string, operation: 'start', requesterName: string, civilianWord: string, undercoverWord: string, participants?: Array<{ name: string; client: ClientKind }>): Promise<{ view: GameView }>;
export async function gameAction(client: RoomApiClient, code: string, operation: 'view', requesterName: string, requesterClient: ClientKind): Promise<{ view: GameView | null }>;
export async function gameAction(client: RoomApiClient, code: string, operation: 'vote', requesterName: string, requesterClient: ClientKind, targetName: string, targetClient: ClientKind): Promise<{ view: GameView }>;
export async function gameAction(client: RoomApiClient, code: string, operation: 'start' | 'view' | 'vote', requesterName: string, arg2: string, arg3?: string, arg4?: Array<{ name: string; client: ClientKind }> | ClientKind, arg5?: string, arg6?: ClientKind): Promise<{ view: GameView | null }> {
  const payload = operation === 'start'
    ? { action: 'gameAction', code, operation, requesterName, civilianWord: arg2, undercoverWord: arg3, participants: arg4 as Array<{ name: string; client: ClientKind }> | undefined }
    : operation === 'view'
      ? { action: 'gameAction', code, operation, requesterName, requesterClient: arg2 as ClientKind }
      : { action: 'gameAction', code, operation, requesterName, requesterClient: arg2 as ClientKind, targetName: arg3!, targetClient: arg4 as ClientKind };
  return client.post(payload);
}
export async function startGame(client: RoomApiClient, code: string, requesterName: string, civilianWord: string, undercoverWord: string, participants?: Array<{ name: string; client: ClientKind }>): Promise<{ view: GameView }> {
  return gameAction(client, code, 'start', requesterName, civilianWord, undercoverWord, participants) as Promise<{ view: GameView }>;
}
export async function getGameView(client: RoomApiClient, code: string, requesterName: string, requesterClient: ClientKind): Promise<{ view: GameView | null }> {
  return gameAction(client, code, 'view', requesterName, requesterClient);
}
export async function castGameVote(client: RoomApiClient, code: string, requesterName: string, requesterClient: ClientKind, targetName: string, targetClient: ClientKind): Promise<{ view: GameView }> {
  return gameAction(client, code, 'vote', requesterName, requesterClient, targetName, targetClient) as Promise<{ view: GameView }>;
}

export async function roomSleep(
  client: RoomApiClient,
  input: { code: string; name: string; cursor: number; seatKey?: string },
): Promise<{ ok: boolean; cursor?: number }> {
  return client.post<{ ok: boolean; cursor?: number }>({
    action: 'sleep',
    code: input.code,
    name: input.name,
    cursor: input.cursor,
    ...(input.seatKey ? { seatKey: input.seatKey } : {}),
  });
}


