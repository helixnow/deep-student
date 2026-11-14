import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateStdioStart } from '../src/stdio-validation.ts';
import type { JsonValue } from '../api.ts';

const exe = realpathSync(process.execPath), cwd = realpathSync(process.cwd());
const env = { FS_ROOT: 'approved-root' };
const entries = (): JsonValue[] => [
  { id: 'fs', name: 'fs', transportType: 'stdio', enabled: true, command: exe, args: ['--approved'], env, cwd, framing: 'jsonl' },
  { id: 'disabled', name: 'disabled', transportType: 'stdio', enabled: false, command: exe, args: ['--disabled'] },
];
const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'mcp-validation-')); dirs.push(dir); return dir; }
function executable(path: string) { writeFileSync(path, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 }); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('stdio_start_validation_tests', () => {
  it('accepts_exact_match_of_enabled_entry', () => {
    const validated = validateStdioStart(entries(), exe, ['  --approved  '], env, cwd, 'JSONL');
    expect(validated.command).toBe(exe);
    expect(validated.args).toEqual(['--approved']);
    expect(validated.env).toEqual(env);
    expect(validated.cwd).toBe(cwd);
    expect(validated.framing).toBe('jsonl');
  });
  it('rejects_mismatched_args_and_disabled_entries', () => {
    expect(() => validateStdioStart(entries(), exe, ['--evil'], env, cwd, 'jsonl')).toThrow('rejected');
    expect(() => validateStdioStart(entries(), exe, ['--disabled'], {}, null, null)).toThrow();
  });
  it('rejects_unconfigured_executable_used_by_connection_test_or_session_start', () => {
    const path = join(temp(), process.platform === 'win32' ? 'unapproved.cmd' : 'unapproved');
    executable(path);
    expect(() => validateStdioStart(entries(), path, [], {}, null, null)).toThrow('approved configuration');
  });
  it('rejects_env_value_mismatch_missing_and_extra_keys', () => {
    expect(() => validateStdioStart(entries(), exe, ['--approved'], { FS_ROOT: 'evil-root' }, cwd, 'jsonl')).toThrow();
    expect(() => validateStdioStart(entries(), exe, ['--approved'], {}, cwd, 'jsonl')).toThrow();
    expect(() => validateStdioStart(entries(), exe, ['--approved'], { ...env, PATH: '/tmp/evil' }, cwd, 'jsonl')).toThrow();
  });
  it('rejects_canonical_cwd_and_framing_mismatches', () => {
    expect(() => validateStdioStart(entries(), exe, ['--approved'], env, temp(), 'jsonl')).toThrow();
    expect(() => validateStdioStart(entries(), exe, ['--approved'], env, cwd, 'content-length')).toThrow();
  });
  it('normalizes_default_framing_and_cwd_aliases', () => {
    const base = { transportType: 'stdio', enabled: true, command: exe, args: [], env: {} };
    expect(validateStdioStart([{ ...base, workingDir: cwd, framingMode: 'content-length' }], exe, [], {}, cwd, 'content_length').framing).toBe('content_length');
    expect(validateStdioStart([{ transportType: 'stdio', enabled: true, fetch: { command: exe, args: [], env: {}, cwd, framing: 'contentlength' } }], exe, [], {}, cwd, 'content_length').framing).toBe('content_length');
    const actual = validateStdioStart([base], exe, [], {}, null, 'unknown-framing');
    expect(actual.framing).toBe('jsonl');
    expect(actual.cwd).toBe(cwd);
  });
  it('resolves_path_command_to_the_approved_canonical_executable', () => {
    const pathEnv = { PATH: dirname(exe) };
    expect(validateStdioStart([{ transportType: 'stdio', enabled: true, command: exe, args: [], env: pathEnv }], basename(exe), [], pathEnv, null, null).command).toBe(exe);
  });
  it('rejects_same_basename_from_a_different_directory', () => {
    const dir = temp();
    mkdirSync(join(dir, 'trusted')); mkdirSync(join(dir, 'malicious'));
    const name = process.platform === 'win32' ? 'same-name.cmd' : 'same-name';
    const trusted = join(dir, 'trusted', name), malicious = join(dir, 'malicious', name);
    executable(trusted); executable(malicious);
    expect(() => validateStdioStart([{ transportType: 'stdio', enabled: true, command: trusted, args: [], env: {} }], malicious, [], {}, null, null)).toThrow();
  });
  it('does not accept null launch fields through fallback aliases', () => {
    expect(() => validateStdioStart([{ enabled: true, command: exe, args: null, fetch: { args: [] } }], exe, [], {}, null, null)).toThrow();
    expect(() => validateStdioStart([{ enabled: true, command: exe, args: [], env: { A: 1 } }], exe, [], {}, null, null)).toThrow();
  });
});
