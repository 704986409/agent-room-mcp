import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hookCommand,
  installCodex,
  resolveMcpLaunch,
  shellQuoteArg,
  stripWin32VerbatimPrefix,
  tomlQuoted,
} from '../src/init.js';

const NODE = '/opt/agent-room/node';
const ENTRY = '/opt/agent-room/resources/mcp/dist/index.js';
const WIN_NODE = 'D:\\Agent Room\\resources\\node\\node.exe';
const WIN_ENTRY = 'D:\\Agent Room\\resources\\mcp\\dist\\index.js';

function bundledEnv(): NodeJS.ProcessEnv {
  return {
    AGENT_ROOM_MCP_COMMAND: NODE,
    AGENT_ROOM_MCP_ARGS: JSON.stringify([ENTRY]),
  };
}

describe('resolveMcpLaunch', () => {
  it('keeps the public npx entry when the override is unset', () => {
    expect(resolveMcpLaunch({})).toEqual({ command: 'npx', args: ['-y', 'agent-room-mcp'] });
    expect(hookCommand({}, 'linux')).toBe('npx -y agent-room-mcp hook');
  });

  it('uses the bundled node and script, and strips Win32 verbatim prefixes', () => {
    const command = '\\\\?\\D:\\Agent Room\\resources\\node\\node.exe';
    const entry = '\\\\?\\D:\\Agent Room\\resources\\mcp\\dist\\index.js';
    expect(stripWin32VerbatimPrefix(command)).toBe(WIN_NODE);
    expect(resolveMcpLaunch({
      AGENT_ROOM_MCP_COMMAND: command,
      AGENT_ROOM_MCP_ARGS: JSON.stringify([entry]),
    })).toEqual({ command: WIN_NODE, args: [WIN_ENTRY] });
  });

  it('quotes a Windows hook command so paths with spaces stay one argv each', () => {
    const env = {
      AGENT_ROOM_MCP_COMMAND: WIN_NODE,
      AGENT_ROOM_MCP_ARGS: JSON.stringify([WIN_ENTRY]),
    };
    const hook = hookCommand(env, 'win32');
    expect(hook).toBe(`"${WIN_NODE}" "${WIN_ENTRY}" hook`);
    expect(tomlQuoted(hook)).toBe(`'${hook}'`);
    expect(shellQuoteArg(NODE, 'linux')).toBe(NODE);
  });

  it('rejects a half-set override', () => {
    expect(() => resolveMcpLaunch({ AGENT_ROOM_MCP_COMMAND: NODE })).toThrow(/must be set together/);
    expect(() => resolveMcpLaunch({ AGENT_ROOM_MCP_COMMAND: NODE, AGENT_ROOM_MCP_ARGS: '[]' })).toThrow(/JSON array of strings/);
    expect(() => resolveMcpLaunch({ AGENT_ROOM_MCP_COMMAND: NODE, AGENT_ROOM_MCP_ARGS: 'nope' })).toThrow(/JSON array of strings/);
  });
});

describe('installCodex bundled launch', () => {
  let codexHome: string;
  const prevCodex = process.env.CODEX_HOME;
  const prevCommand = process.env.AGENT_ROOM_MCP_COMMAND;
  const prevArgs = process.env.AGENT_ROOM_MCP_ARGS;

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'agent-room-bundled-'));
    process.env.CODEX_HOME = codexHome;
    process.env.AGENT_ROOM_MCP_COMMAND = bundledEnv().AGENT_ROOM_MCP_COMMAND;
    process.env.AGENT_ROOM_MCP_ARGS = bundledEnv().AGENT_ROOM_MCP_ARGS;
  });

  afterEach(() => {
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
    if (prevCommand === undefined) delete process.env.AGENT_ROOM_MCP_COMMAND;
    else process.env.AGENT_ROOM_MCP_COMMAND = prevCommand;
    if (prevArgs === undefined) delete process.env.AGENT_ROOM_MCP_ARGS;
    else process.env.AGENT_ROOM_MCP_ARGS = prevArgs;
  });

  it('writes the bundled command into config.toml instead of npx', async () => {
    await installCodex({ hooks: true });
    const toml = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(toml).toContain(`command = "${NODE}"`);
    expect(toml).toContain(`args = ["${ENTRY}"]`);
    expect(toml).toContain(`command = "${hookCommand(bundledEnv(), process.platform)}"`);
    expect(toml).not.toContain('npx -y agent-room-mcp');
  });
});
