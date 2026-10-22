import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCodex, countInstalledCodexHookCommands } from '../src/init.js';

// installCodex writes ~/.codex/config.toml, resolved from CODEX_HOME. Point it
// at a temp dir so the test never touches the real user config.
let codexHome: string;
const prevCodexHome = process.env.CODEX_HOME;
const prevBase = process.env.AGENT_ROOM_BASE_URL;
const prevServer = process.env.AGENT_ROOM_SERVER;

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), 'agent-room-codex-'));
  process.env.CODEX_HOME = codexHome;
  delete process.env.AGENT_ROOM_BASE_URL;
  delete process.env.AGENT_ROOM_SERVER;
});

afterEach(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  if (prevBase === undefined) delete process.env.AGENT_ROOM_BASE_URL;
  else process.env.AGENT_ROOM_BASE_URL = prevBase;
  if (prevServer === undefined) delete process.env.AGENT_ROOM_SERVER;
  else process.env.AGENT_ROOM_SERVER = prevServer;
});

const configPath = () => join(codexHome, 'config.toml');

describe('installCodex — hooks', () => {
  it('enables the codex_hooks feature flag alongside the hook blocks', async () => {
    await installCodex({ hooks: true });
    const toml = await readFile(configPath(), 'utf8');

    // Codex ignores [[hooks.*]] unless the feature is enabled.
    expect(toml).toContain('[features]');
    expect(toml).toMatch(/^codex_hooks = true$/m);

    // All three autonomous-chat hooks are present.
    expect(toml).toContain('[[hooks.Stop]]');
    expect(toml).toContain('[[hooks.UserPromptSubmit]]');
    expect(toml).toContain('[[hooks.SessionStart]]');
    expect(toml).toContain('command = "npx -y agent-room-mcp hook"');
  });

  it('is idempotent — re-running does not duplicate the feature flag or hooks', async () => {
    await installCodex({ hooks: true });
    const first = await readFile(configPath(), 'utf8');
    const second = await installCodex({ hooks: true });
    const after = await readFile(configPath(), 'utf8');

    expect(after).toBe(first);
    expect(second.changes).toHaveLength(0);
    expect((after.match(/codex_hooks = true/g) ?? []).length).toBe(1);
    expect((after.match(/\[\[hooks\.Stop\]\]/g) ?? []).length).toBe(1);
  });

  it('inserts codex_hooks into a pre-existing [features] table instead of duplicating it', async () => {
    await writeFile(configPath(), '[features]\nweb_search = true\n', 'utf8');
    await installCodex({ hooks: true });
    const toml = await readFile(configPath(), 'utf8');

    expect((toml.match(/\[features\]/g) ?? []).length).toBe(1);
    expect(toml).toContain('web_search = true');
    expect(toml).toMatch(/^codex_hooks = true$/m);
  });

  it('does not write hooks or the feature flag when hooks are disabled', async () => {
    await installCodex({ hooks: false });
    const toml = await readFile(configPath(), 'utf8');

    expect(toml).toContain('[mcp_servers.agent-room]');
    expect(toml).not.toContain('codex_hooks');
    expect(toml).not.toContain('[[hooks.Stop]]');
  });
});

describe('installCodex — duplicate hook detection', () => {
  // Robin's machine, 2026-08-05: config.toml carried a hand-written
  // `env CODEX_HOME=... npx -y agent-room-mcp hook`. The old exact-substring
  // check did not recognise it, so init appended a SECOND full set of hook
  // blocks and every Stop ran the hook twice.
  it('recognises a hand-written hook command variant and does not append a second set', async () => {
    const handWritten = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.Stop]]',
      'matcher = ""',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "env CODEX_HOME=/Users/robin/.codex npx -y agent-room-mcp hook"',
      '',
    ].join('\n');
    await writeFile(configPath(), handWritten, 'utf8');

    const result = await installCodex({ hooks: true });
    const toml = await readFile(configPath(), 'utf8');

    expect(countInstalledCodexHookCommands(toml)).toBe(1);
    expect(result.unchanged.some((u) => u.includes('hooks already installed'))).toBe(true);
  });

  it('is idempotent across repeated runs', async () => {
    await installCodex({ hooks: true });
    const once = countInstalledCodexHookCommands(await readFile(configPath(), 'utf8'));
    await installCodex({ hooks: true });
    const twice = countInstalledCodexHookCommands(await readFile(configPath(), 'utf8'));

    expect(once).toBe(3); // Stop / UserPromptSubmit / SessionStart
    expect(twice).toBe(once);
  });

  it('removes duplicate hook blocks instead of telling the user to do it by hand', async () => {
    await installCodex({ hooks: true });
    const doubled = (await readFile(configPath(), 'utf8')).repeat(2);
    await writeFile(configPath(), doubled, 'utf8');

    const result = await installCodex({ hooks: true });
    const toml = await readFile(configPath(), 'utf8');

    expect(countInstalledCodexHookCommands(toml)).toBe(3);
    expect(result.changes.some((c) => c.includes('duplicate agent-room hook block'))).toBe(true);
  });

  // The 2026-08-10 shape from Robin's machine: an older init wrote the bare
  // command, a newer one wrote the CODEX_HOME-prefixed variant, and both sets
  // survived. [hooks.state] only carries trust for index 0, so the second set
  // was untrusted — the Stop hook never ran, nothing re-armed room_listen, and
  // Codex silently left the room at the end of every turn.
  it('keeps the FIRST block of each event so the existing trust records still apply', async () => {
    const real = [
      '[features]',
      'codex_hooks = true',
      '',
      '[[hooks.Stop]]',
      'matcher = ""',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "env CODEX_HOME=/Users/robin/.codex npx -y agent-room-mcp hook"',
      '',
      '[hooks.state]',
      '',
      '[hooks.state."/Users/robin/.codex/config.toml:stop:0:0"]',
      'trusted_hash = "sha256:15e63bd3"',
      '',
      '[[hooks.Stop]]',
      'matcher = ""',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "npx -y agent-room-mcp hook"',
      '',
    ].join('\n');
    await writeFile(configPath(), real, 'utf8');

    await installCodex({ hooks: true });
    const toml = await readFile(configPath(), 'utf8');

    // The trusted spelling survived; the untrusted duplicate is gone.
    expect(toml).toContain('command = "env CODEX_HOME=/Users/robin/.codex npx -y agent-room-mcp hook"');
    expect(toml).not.toContain('command = "npx -y agent-room-mcp hook"');
    // Trust records are Codex's own security state — we never rewrite them.
    expect(toml).toContain('[hooks.state."/Users/robin/.codex/config.toml:stop:0:0"]');
    expect(toml).toContain('trusted_hash = "sha256:15e63bd3"');
  });

  it('leaves somebody else\'s hooks alone', async () => {
    const foreign = [
      '[[hooks.Stop]]',
      'matcher = ""',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "some-other-tool --on-stop"',
      '',
      '[[hooks.Stop]]',
      'matcher = ""',
      '[[hooks.Stop.hooks]]',
      'type = "command"',
      'command = "some-other-tool --on-stop"',
      '',
    ].join('\n');
    await writeFile(configPath(), foreign, 'utf8');

    await installCodex({ hooks: true });
    const toml = await readFile(configPath(), 'utf8');

    // Both foreign blocks survive — duplicated or not, they are not ours.
    expect(toml.match(/command = "some-other-tool --on-stop"/g)).toHaveLength(2);
    // And our own hooks were installed, since none were present before.
    expect(countInstalledCodexHookCommands(toml)).toBe(3);
  });
});
