import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatCodexHookCommandLines,
  hookCommand,
  hostedMcpUrl,
  installCodex,
  mcpClientEntry,
  resolveMcpLaunch,
  rewriteCodexHookCommands,
  shellQuoteArg,
  stripWin32VerbatimPrefix,
  tomlQuoted,
} from '../src/init.js';

/**
 * ReactOS/Windows `cmd /C` quote rule: a remainder that starts with `"` drops
 * that quote and the last `"` on the line (unless the two-quote executable
 * exception applies). Codex passes the hook as `cmd /C "<command>"`.
 */
function cmdSlashC(remainder: string): string {
  const trimmed = remainder.trimStart();
  if (!trimmed.startsWith('"')) return trimmed;
  const afterFirst = trimmed.slice(1);
  const last = afterFirst.lastIndexOf('"');
  if (last < 0) return trimmed;
  const inside = afterFirst.slice(0, last);
  const quoteCount = trimmed.match(/"/g)?.length ?? 0;
  const preserve = quoteCount === 2 && /\s/.test(inside) && !/["&<>@^|]/.test(inside);
  if (preserve) return trimmed;
  return afterFirst.slice(0, last) + afterFirst.slice(last + 1);
}

function decodeTomlQuoted(assignment: string): string {
  const value = assignment.replace(/^[^=]*=\s*/, '');
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return value;
}

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
    expect(hook).toBe(`call "${WIN_NODE}" "${WIN_ENTRY}" hook`);
    expect(hook.startsWith('"')).toBe(false);
    expect(tomlQuoted(hook)).toBe(`'${hook}'`);
    expect(shellQuoteArg(NODE, 'linux')).toBe(NODE);
    // Codex cmd.exe /C strips a leading quote and the last quote. `call` keeps
    // each spaced path quoted both bare and inside that outer wrap.
    expect(cmdSlashC(hook)).toBe(hook);
    expect(cmdSlashC(`"${hook}"`)).toBe(hook);
    expect(cmdSlashC(`"${hook}"`)).toContain(`"${WIN_NODE}"`);
    expect(cmdSlashC(`"${hook}"`)).toContain(`"${WIN_ENTRY}"`);
    const lines = formatCodexHookCommandLines(env, 'win32');
    expect(lines.commandLine).toBe(`command = '${hook}'`);
    expect(lines.windowsLine).toBe(`command_windows = '${hook}'`);
    expect(lines.windowsLine).toContain('Agent Room');
    expect(decodeTomlQuoted(lines.windowsLine!)).toBe(hook);
  });

  it('replaces a stale command_windows whose Agent Room path is split on spaces', () => {
    const env = {
      AGENT_ROOM_MCP_COMMAND: WIN_NODE,
      AGENT_ROOM_MCP_ARGS: JSON.stringify([WIN_ENTRY]),
    };
    const programFiles = 'C:\\Program Files\\Agent Room\\resources\\node\\node.exe';
    const programEntry = 'C:\\Program Files\\Agent Room\\resources\\mcp\\dist\\index.js';
    const spaced = hookCommand({
      AGENT_ROOM_MCP_COMMAND: programFiles,
      AGENT_ROOM_MCP_ARGS: JSON.stringify([programEntry]),
    }, 'win32');
    expect(spaced).toBe(`call "${programFiles}" "${programEntry}" hook`);
    expect(cmdSlashC(`"${spaced}"`)).toContain(`"${programFiles}"`);
    expect(cmdSlashC(spaced).startsWith('call "')).toBe(true);

    const stale = [
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "npx -y agent-room-mcp hook"',
      'command_windows = "D:\\\\Agent Room\\\\resources\\\\node\\\\node.exe D:\\\\Agent Room\\\\resources\\\\mcp\\\\dist\\\\index.js hook"',
      '',
    ].join('\n');
    const { commandLine, windowsLine } = formatCodexHookCommandLines(env, 'win32');
    const rewritten = rewriteCodexHookCommands(stale, commandLine, windowsLine);
    expect(rewritten).toContain(commandLine);
    expect(rewritten).toContain(windowsLine!);
    expect(rewritten).not.toContain('node.exe D:');
    expect(decodeTomlQuoted(windowsLine!)).toContain(`"${WIN_NODE}"`);
    expect(rewriteCodexHookCommands(rewritten, commandLine, windowsLine)).toBe(rewritten);
  });

  it('keeps a client env marker on stdio and uses HTTP when a server is paired', () => {
    expect(mcpClientEntry({ CLAUDECODE: '1' }, {})).toEqual({
      command: 'npx',
      args: ['-y', 'agent-room-mcp'],
      env: { CLAUDECODE: '1' },
    });
    expect(mcpClientEntry({ CLAUDECODE: '1' }, { AGENT_ROOM_BASE_URL: 'https://ai-room.pupgo.top' })).toEqual({
      type: 'http',
      url: 'https://ai-room.pupgo.top/mcp',
    });
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
  const prevBase = process.env.AGENT_ROOM_BASE_URL;
  const prevServer = process.env.AGENT_ROOM_SERVER;

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'agent-room-bundled-'));
    process.env.CODEX_HOME = codexHome;
    process.env.AGENT_ROOM_MCP_COMMAND = bundledEnv().AGENT_ROOM_MCP_COMMAND;
    process.env.AGENT_ROOM_MCP_ARGS = bundledEnv().AGENT_ROOM_MCP_ARGS;
    delete process.env.AGENT_ROOM_BASE_URL;
    delete process.env.AGENT_ROOM_SERVER;
  });

  afterEach(() => {
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
    if (prevCommand === undefined) delete process.env.AGENT_ROOM_MCP_COMMAND;
    else process.env.AGENT_ROOM_MCP_COMMAND = prevCommand;
    if (prevArgs === undefined) delete process.env.AGENT_ROOM_MCP_ARGS;
    else process.env.AGENT_ROOM_MCP_ARGS = prevArgs;
    if (prevBase === undefined) delete process.env.AGENT_ROOM_BASE_URL;
    else process.env.AGENT_ROOM_BASE_URL = prevBase;
    if (prevServer === undefined) delete process.env.AGENT_ROOM_SERVER;
    else process.env.AGENT_ROOM_SERVER = prevServer;
  });

  it('writes the bundled command into config.toml instead of npx', async () => {
    await installCodex({ hooks: true });
    const toml = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(toml).toContain(`command = "${NODE}"`);
    expect(toml).toContain(`args = ["${ENTRY}"]`);
    expect(toml).toContain(`command = "${hookCommand(bundledEnv(), process.platform)}"`);
    expect(toml).not.toContain('npx -y agent-room-mcp');
  });

  it('points Codex at the paired HTTP MCP and rewrites a stale npx hook', async () => {
    const base = 'https://ai-room.pupgo.top';
    process.env.AGENT_ROOM_BASE_URL = base;
    await writeFile(join(codexHome, 'config.toml'), [
      '[mcp_servers.agent-room]',
      'command = "npx"',
      'args = ["-y", "agent-room-mcp"]',
      '',
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.Stop]]',
      'matcher = ""',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "npx -y agent-room-mcp hook"',
      '',
    ].join('\n'));
    await installCodex({ hooks: true });
    const toml = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(hostedMcpUrl()).toBe(`${base}/mcp`);
    expect(toml).toContain(`url = "${base}/mcp"`);
    expect(toml).not.toContain('command = "npx"');
    expect(toml).not.toContain('npx -y agent-room-mcp hook');
    expect(toml).toContain(hookCommand());
    expect(toml).toContain('mcp/dist/index.js');
    const again = await installCodex({ hooks: true });
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe(toml);
    expect(again.changes).toHaveLength(0);
  });

  it('sets the base URL inside a Windows hook command without a leading quote', () => {
    const hook = hookCommand({
      AGENT_ROOM_MCP_COMMAND: WIN_NODE,
      AGENT_ROOM_MCP_ARGS: JSON.stringify([WIN_ENTRY]),
      AGENT_ROOM_BASE_URL: 'https://ai-room.pupgo.top',
    }, 'win32');
    expect(hook.startsWith('set "AGENT_ROOM_BASE_URL=https://ai-room.pupgo.top"&& call ')).toBe(true);
    expect(hook.startsWith('"')).toBe(false);
    expect(hook).toContain(`call "${WIN_NODE}" "${WIN_ENTRY}" hook`);
  });
});
