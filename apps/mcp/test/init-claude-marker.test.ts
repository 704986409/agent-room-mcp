import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// T-18. Claude Code was dropping out of rooms because detectHarness returned
// 'unknown' — the MCP server is a spawned child and CLAUDECODE /
// CLAUDE_CODE_ENTRYPOINT were not reaching it. 'unknown' falls back to
// state-${ppid}.json, so a Claude Code process (roughly one per turn) read a
// fresh empty state file every time and had no idea it was still in a room.
//
// These assert the shape of the config `init` writes, on source, because the
// installers write to real home-directory paths and the interesting property is
// "which entry goes into which client's file", not the file I/O.
// Resolve from this test file so both `npm -w apps/mcp test` and repo-root
// `vitest run apps/mcp/test/...` find the same source.
const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/init.ts'),
  'utf8',
);

describe('T-18: Claude Code self-identifies to the MCP server', () => {
  it('declares CLAUDECODE on the Claude Code entry', () => {
    expect(SRC).toMatch(/const CLAUDE_CODE_MCP_ENTRY = \{[\s\S]*?env: \{ CLAUDECODE: '1' \}[\s\S]*?\};/);
  });

  it('writes that entry into ~/.claude.json', () => {
    const claudeJsonBlock = SRC.slice(SRC.indexOf("join(homedir(), '.claude.json')"));
    expect(claudeJsonBlock.slice(0, 700)).toContain('env: CLAUDE_CODE_MCP_ENTRY.env');
  });

  // The half of T-18 that was missed: the desktop app's Code surface reads
  // claude_desktop_config.json, not ~/.claude.json, and spawns the MCP server
  // through Claude.app's own helper. Writing the marker to only one of the two
  // files left the desktop app reporting 'unknown' and dropping out of rooms.
  it('writes a marked entry into the desktop app config too', () => {
    const desktopBlock = SRC.slice(SRC.indexOf('async function installClaude(opts:'));
    expect(desktopBlock.slice(0, 700)).toContain('env: CLAUDE_DESKTOP_MCP_ENTRY.env');
  });

  // The desktop entry carries the SAME CLAUDECODE marker (kind must stay
  // claude-code so the stop hook matches) plus the entrypoint that tells
  // detectHarness to use the shorter listen cap that surface can sustain.
  it('tells the server which Claude Code surface it is', () => {
    expect(SRC).toMatch(
      /const CLAUDE_DESKTOP_MCP_ENTRY = \{[\s\S]*?env: \{ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' \}[\s\S]*?\};/,
    );
  });

  // `init print` is what users hand-copy when the installer cannot write for
  // them; an unmarked sample reproduces the bug by hand.
  it('prints the marked entry for both Claude config files', () => {
    const printBlock = SRC.slice(SRC.indexOf('function printConfigs()'));
    const claudeSection = printBlock.slice(0, printBlock.indexOf('--- Cursor'));
    expect(claudeSection).toContain('CLAUDE_CODE_MCP_ENTRY');
    expect(claudeSection).toContain('console.log(claudeMcp)');      // ~/.claude.json
    expect(claudeSection).toContain('console.log(claudeDesktopMcp)'); // desktop app
  });

  // The regression that matters more than the fix: detectHarness checks
  // CLAUDECODE FIRST, so putting the marker on the shared entry would make
  // Cursor / Gemini / Antigravity all report themselves as claude-code.
  it('does NOT put the marker on the entry shared with other clients', () => {
    // Only the object literal — the doc comment below it naturally mentions
    // CLAUDECODE while explaining why the marker must NOT live here.
    const start = SRC.indexOf('const MCP_ENTRY = {');
    const shared = SRC.slice(start, SRC.indexOf('};', start) + 2);
    expect(shared).not.toContain('CLAUDECODE');
    expect(shared).not.toContain('env:');
  });

  it('leaves the other clients writing the unmarked shared entry', () => {
    // Cursor's installer and the printed sample config must still use MCP_ENTRY.
    const cursorBlock = SRC.slice(SRC.indexOf('async function installCursor'));
    expect(cursorBlock.slice(0, 900)).toContain("servers['agent-room'] = resolveMcpLaunch();");
  });
});
