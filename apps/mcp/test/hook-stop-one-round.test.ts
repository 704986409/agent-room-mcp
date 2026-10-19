import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@agent-room/shared';
import { messageMentionsAgent, performHandoff, runHook } from '../src/hook.js';
import { roomSleep, type RoomApiClient } from '../src/roomApi.js';
import { readHandoff, setRoom, writeHandoff, type HandoffRecord } from '../src/state.js';

describe('messageMentionsAgent', () => {
  const baseMsg: Message = {
    id: 100,
    type: 'msg',
    name: 'Alice',
    initials: 'AL',
    color: '#123456',
    role: '',
    text: '',
    client: 'web',
    time: Date.now(),
  };

  it('matches exact @Name in message text', () => {
    expect(messageMentionsAgent({ ...baseMsg, text: 'Hey @Bob, can you help?' }, 'Bob')).toBe(true);
  });

  it('matches case-insensitive @name in message text', () => {
    expect(messageMentionsAgent({ ...baseMsg, text: 'Hey @bob, take a look' }, 'Bob')).toBe(true);
  });

  it('matches suffixed agent name when base name is @-mentioned', () => {
    expect(messageMentionsAgent({ ...baseMsg, text: '@Bob what do you think?' }, 'Bob (2)')).toBe(true);
    expect(messageMentionsAgent({ ...baseMsg, text: '@Bob (2) what do you think?' }, 'Bob (2)')).toBe(true);
  });

  it('matches targetAgentName in metadata', () => {
    expect(
      messageMentionsAgent(
        { ...baseMsg, text: 'Direct task assignment', metadata: { targetAgentName: 'Bob' } },
        'Bob',
      ),
    ).toBe(true);
    expect(
      messageMentionsAgent(
        { ...baseMsg, text: 'Direct task assignment', metadata: { targetAgentName: 'bob' } },
        'Bob',
      ),
    ).toBe(true);
  });

  it('returns false when no mention or different agent mentioned', () => {
    expect(messageMentionsAgent({ ...baseMsg, text: 'Good morning everyone!' }, 'Bob')).toBe(false);
    expect(messageMentionsAgent({ ...baseMsg, text: '@Charlie please review' }, 'Bob')).toBe(false);
    expect(messageMentionsAgent({ ...baseMsg, text: 'bob is a great teammate without at' }, 'Bob')).toBe(false);
  });
});

describe('local handoff file in state.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'agent-room-handoff-test-'));
    vi.stubEnv('AGENT_ROOM_STATE_DIR', tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes handoff.json and handoff-${code}.json with 0600 permissions', async () => {
    const record: HandoffRecord = {
      code: 'TEST-123-ABC',
      name: 'AgentX',
      cursor: 42,
      seatKey: 'sk_secret',
      sessionId: 'sess_123',
      at: Date.now(),
    };
    await writeHandoff(record);

    const perRoom = await readHandoff('TEST-123-ABC');
    expect(perRoom).toMatchObject({
      code: 'TEST-123-ABC',
      name: 'AgentX',
      cursor: 42,
      seatKey: 'sk_secret',
      sessionId: 'sess_123',
    });

    const general = await readHandoff();
    expect(general).toMatchObject({
      code: 'TEST-123-ABC',
      cursor: 42,
    });

    const stat = await fs.stat(join(tempDir, 'handoff-TEST-123-ABC.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('honours AGENT_ROOM_HANDOFF_FILE if set', async () => {
    const customPath = join(tempDir, 'custom-handoff.json');
    vi.stubEnv('AGENT_ROOM_HANDOFF_FILE', customPath);

    const record: HandoffRecord = {
      code: 'ROOM-CUSTOM',
      name: 'AgentC',
      cursor: 99,
      at: Date.now(),
    };
    await writeHandoff(record);

    const read = await readHandoff();
    expect(read).toMatchObject({
      code: 'ROOM-CUSTOM',
      cursor: 99,
    });
    const exists = await fs.access(customPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });
});

describe('roomSleep API client', () => {
  it('posts action sleep with code, name, cursor, and seatKey', async () => {
    let calledPayload: any = null;
    const mockClient: RoomApiClient = {
      post: async <T>(payload: Record<string, unknown>): Promise<T> => {
        calledPayload = payload;
        return { ok: true, cursor: payload.cursor } as T;
      },
    };

    const res = await roomSleep(mockClient, {
      code: 'ABC-123-XYZ',
      name: 'SleepAgent',
      cursor: 88,
      seatKey: 'sk_test_123',
    });

    expect(res).toEqual({ ok: true, cursor: 88 });
    expect(calledPayload).toEqual({
      action: 'sleep',
      code: 'ABC-123-XYZ',
      name: 'SleepAgent',
      cursor: 88,
      seatKey: 'sk_test_123',
    });
  });
});

describe('performHandoff in hook.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'agent-room-perform-handoff-'));
    vi.stubEnv('AGENT_ROOM_STATE_DIR', tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('calls roomSleep on server and writes local handoff file', async () => {
    let postedPayload: any = null;
    const mockClient: RoomApiClient = {
      post: async <T>(payload: Record<string, unknown>): Promise<T> => {
        postedPayload = payload;
        return { ok: true, cursor: payload.cursor } as T;
      },
    };

    await performHandoff(mockClient, {
      code: 'ROOM-1',
      name: 'Agent1',
      cursor: 120,
      seatKey: 'sk_1',
      sessionId: 'sess_1',
    });

    expect(postedPayload).toEqual({
      action: 'sleep',
      code: 'ROOM-1',
      name: 'Agent1',
      cursor: 120,
      seatKey: 'sk_1',
    });

    const handoff = await readHandoff('ROOM-1');
    expect(handoff).toMatchObject({
      code: 'ROOM-1',
      name: 'Agent1',
      cursor: 120,
      seatKey: 'sk_1',
      sessionId: 'sess_1',
    });
  });

  it('falls back to writing local handoff file when server roomSleep throws', async () => {
    const mockClient: RoomApiClient = {
      post: async () => {
        throw new Error('Not implemented on server');
      },
    };

    await performHandoff(mockClient, {
      code: 'ROOM-FALLBACK',
      name: 'AgentFallback',
      cursor: 150,
    });

    const handoff = await readHandoff('ROOM-FALLBACK');
    expect(handoff).toMatchObject({
      code: 'ROOM-FALLBACK',
      name: 'AgentFallback',
      cursor: 150,
    });
  });
});

describe('Stop Hook execution (runHook)', () => {
  let tempDir: string;
  let fetchSpy: any;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'agent-room-hook-exec-'));
    vi.stubEnv('AGENT_ROOM_STATE_DIR', tempDir);
    vi.stubEnv('AGENT_ROOM_HOOK_POLL_MAX_MS', '50');
    vi.stubEnv('AGENT_ROOM_HOOK_POLL_INTERVAL_MS', '10');
  });

  afterEach(async () => {
    if (fetchSpy) fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('daemon-managed session (AGENT_ROOM_MANAGED=1): never auto-continues and hands off cursor', async () => {
    vi.stubEnv('AGENT_ROOM_MANAGED', '1');

    await setRoom('ROOM-DM-1', {
      name: 'ManagedAgent',
      cursor: 10,
      joinedAt: Date.now(),
      sessionKey: 'sess-managed',
      seatKey: 'seat-managed-key',
    });

    let stdoutOutput = '';
    let exitCode: number | null = null;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_info, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.action === 'messages') {
        return new Response(JSON.stringify({ messages: [], total: 10 }), { status: 200 });
      }
      if (body.action === 'sleep') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runHook(
      { hook_event_name: 'Stop', session_id: 'sess-managed' },
      {
        stdout: (d) => { stdoutOutput += d; },
        exit: (code) => { exitCode = code; },
      },
    );

    // Never auto-continues (must not block the turn)
    expect(stdoutOutput).not.toContain('decision');
    expect(stdoutOutput).not.toContain('block');
    expect(stdoutOutput).not.toContain('followup_message');
    expect(exitCode).toBe(0);

    // Handoff file was written
    const handoff = await readHandoff('ROOM-DM-1');
    expect(handoff).toMatchObject({
      code: 'ROOM-DM-1',
      name: 'ManagedAgent',
      cursor: 10,
      seatKey: 'seat-managed-key',
      sessionId: 'sess-managed',
    });
  });

  it('manual session: delivers messages and resumes session when @ for this agent arrives', async () => {
    await setRoom('ROOM-MANUAL-1', {
      name: 'Claude',
      cursor: 5,
      joinedAt: Date.now(),
      sessionKey: 'sess-manual',
    });

    let stdoutOutput = '';
    let exitCode: number | null = null;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_info, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.action === 'messages') {
        return new Response(
          JSON.stringify({
            messages: [
              {
                id: 6,
                type: 'msg',
                name: 'Alice',
                initials: 'AL',
                color: '#fff',
                role: '',
                text: 'Hey @Claude, what is the status of the release?',
                client: 'web',
                time: Date.now(),
              },
            ],
            total: 6,
          }),
          { status: 200 },
        );
      }
      if (body.action === 'get') {
        return new Response(JSON.stringify({ room: { status: 'active', topic: 'Release' } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runHook(
      { hook_event_name: 'Stop', session_id: 'sess-manual' },
      {
        stdout: (d) => { stdoutOutput += d; },
        exit: (code) => { exitCode = code; },
      },
    );

    expect(stdoutOutput).toContain('"decision":"block"');
    expect(stdoutOutput).toContain('what is the status of the release?');
    expect(exitCode).toBe(0);
  });

  it('manual session: does NOT auto-continue when messages do NOT mention this agent, hands off and exits', async () => {
    await setRoom('ROOM-MANUAL-2', {
      name: 'Claude',
      cursor: 12,
      joinedAt: Date.now(),
      sessionKey: 'sess-manual-2',
    });

    let stdoutOutput = '';
    let exitCode: number | null = null;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_info, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.action === 'messages') {
        return new Response(
          JSON.stringify({
            messages: [
              {
                id: 13,
                type: 'msg',
                name: 'Alice',
                initials: 'AL',
                color: '#fff',
                role: '',
                text: '@Bob please update the docs',
                client: 'web',
                time: Date.now(),
              },
            ],
            total: 13,
          }),
          { status: 200 },
        );
      }
      if (body.action === 'sleep') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runHook(
      { hook_event_name: 'Stop', session_id: 'sess-manual-2' },
      {
        stdout: (d) => { stdoutOutput += d; },
        exit: (code) => { exitCode = code; },
      },
    );

    // No continuation: turn is allowed to end
    expect(stdoutOutput).not.toContain('"decision":"block"');
    expect(stdoutOutput).not.toContain('followup_message');
    expect(exitCode).toBe(0);

    // Cursor was advanced and handed off
    const handoff = await readHandoff('ROOM-MANUAL-2');
    expect(handoff).toMatchObject({
      code: 'ROOM-MANUAL-2',
      name: 'Claude',
      cursor: 13,
    });
  });

  it('manual session: listens one round; if quiet, hands off cursor and exits without resuming', async () => {
    await setRoom('ROOM-MANUAL-3', {
      name: 'Claude',
      cursor: 20,
      joinedAt: Date.now(),
      sessionKey: 'sess-manual-3',
    });

    let stdoutOutput = '';
    let exitCode: number | null = null;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_info, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.action === 'messages') {
        return new Response(JSON.stringify({ messages: [], total: 20 }), { status: 200 });
      }
      if (body.action === 'sleep') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runHook(
      { hook_event_name: 'Stop', session_id: 'sess-manual-3' },
      {
        stdout: (d) => { stdoutOutput += d; },
        exit: (code) => { exitCode = code; },
      },
    );

    // Must not block the turn with ACTIVE ROOM CONTRACT continuation
    expect(stdoutOutput).not.toContain('"decision":"block"');
    expect(stdoutOutput).not.toContain('followup_message');
    expect(exitCode).toBe(0);

    // Handoff file was written
    const handoff = await readHandoff('ROOM-MANUAL-3');
    expect(handoff).toMatchObject({
      code: 'ROOM-MANUAL-3',
      name: 'Claude',
      cursor: 20,
    });
  });

  it('manual session: Cursor mode receives followup_message when @ arrives', async () => {
    await setRoom('ROOM-CURSOR-1', {
      name: 'CursorAgent',
      cursor: 1,
      joinedAt: Date.now(),
      sessionKey: 'conv-cursor-1',
    });

    let stdoutOutput = '';
    let exitCode: number | null = null;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_info, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.action === 'messages') {
        return new Response(
          JSON.stringify({
            messages: [
              {
                id: 2,
                type: 'msg',
                name: 'Lead',
                initials: 'LD',
                color: '#fff',
                role: '',
                text: '@CursorAgent run the build',
                client: 'web',
                time: Date.now(),
              },
            ],
            total: 2,
          }),
          { status: 200 },
        );
      }
      if (body.action === 'get') {
        return new Response(JSON.stringify({ room: { status: 'active', topic: 'Testing' } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runHook(
      { status: 'completed', conversation_id: 'conv-cursor-1' },
      {
        stdout: (d) => { stdoutOutput += d; },
        exit: (code) => { exitCode = code; },
      },
    );

    expect(stdoutOutput).toContain('followup_message');
    expect(stdoutOutput).toContain('@CursorAgent run the build');
    expect(exitCode).toBe(0);
  });
});
