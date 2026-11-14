import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExecFileException } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CryptoServiceImpl, type ExecFileRunner } from '../../secrets/crypto-service.ts';
import { adoptActiveSlotMasterKey, DataSpaceStartup } from '../startup.ts';
import { setStorageLogger } from '../logging.ts';

const roots: string[] = [];
const quietLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as never;

function upgradedDataDir(active: 'slotA' | 'slotB'): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w07-master-key-'));
  roots.push(base);
  for (const slot of ['slotA', 'slotB']) fs.mkdirSync(path.join(base, 'slots', slot), { recursive: true });
  fs.writeFileSync(path.join(base, 'slots', 'state.json'), JSON.stringify({ active, pending: null }));
  fs.writeFileSync(path.join(base, 'slots', '.legacy_migration_complete'), '1');
  return base;
}

function writeSlotKey(base: string, slot: string, key: Buffer): string {
  const file = path.join(base, 'slots', slot, '.master_key');
  fs.writeFileSync(file, key.toString('base64'));
  return file;
}

async function startDataSpace(base: string): Promise<DataSpaceStartup> {
  const startup = new DataSpaceStartup(base, { recover: async () => {} } as never);
  await startup.start();
  expect(startup.status()).toMatchObject({ recovery_required: false });
  return startup;
}

function cryptoOptions() {
  return { log: quietLog, platform: process.platform, env: {} };
}

function openLikeLlmPlugin(base: string) {
  return CryptoServiceImpl.open(base, cryptoOptions());
}

afterEach(() => {
  setStorageLogger(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('active slot .master_key adoption', () => {
  it('RF-W07-crypto-root-adopts-slot-master-key: an upgraded Tauri data dir keeps decrypting API keys encrypted with the active slot .master_key', async () => {
    const base = upgradedDataDir('slotB');
    const slotKey = randomBytes(32);
    writeSlotKey(base, 'slotA', randomBytes(32));
    const slotKeyFile = writeSlotKey(base, 'slotB', slotKey);
    const saved = CryptoServiceImpl.fromKey(slotKeyFile, slotKey, cryptoOptions()).encryptApiKey('sk-upgrade-user');

    await startDataSpace(base);
    const crypto = await openLikeLlmPlugin(base);

    expect(crypto.decryptApiKey(saved)).toBe('sk-upgrade-user');
    expect(fs.readFileSync(path.join(base, '.master_key'))).toEqual(fs.readFileSync(slotKeyFile));
    expect(fs.existsSync(slotKeyFile)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(base, '.master_key')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(base).filter((name) => name.includes('.master_key') && name !== '.master_key')).toEqual([]);
  });

  it('never replaces an existing application-root .master_key', async () => {
    const base = upgradedDataDir('slotA');
    writeSlotKey(base, 'slotA', randomBytes(32));
    const rootKey = randomBytes(32).toString('base64');
    fs.writeFileSync(path.join(base, '.master_key'), rootKey);

    await startDataSpace(base);

    expect(fs.readFileSync(path.join(base, '.master_key'), 'utf8')).toBe(rootKey);
  });

  it.each([
    ['wrong length', Buffer.from(randomBytes(16).toString('base64'))],
    ['not base64', Buffer.from('not-a-key!!')],
    ['not UTF-8', Buffer.from([0xff, 0xfe, 0x41])],
  ])('leaves an unusable slot key (%s) alone and logs a warning', async (_label, content) => {
    const base = upgradedDataDir('slotA');
    fs.writeFileSync(path.join(base, 'slots', 'slotA', '.master_key'), content);
    const warnings: string[] = [];
    setStorageLogger(() => ({ info() {}, debug() {}, error() {}, trace() {}, warn(message: string) { warnings.push(message); } }) as never);

    await startDataSpace(base);

    expect(fs.existsSync(path.join(base, '.master_key'))).toBe(false);
    expect(warnings.some((line) => line.includes('.master_key'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('does not follow a symlinked slot key', async () => {
    const base = upgradedDataDir('slotA');
    const outside = path.join(base, 'outside-key');
    fs.writeFileSync(outside, randomBytes(32).toString('base64'));
    fs.symlinkSync(outside, path.join(base, 'slots', 'slotA', '.master_key'));

    await startDataSpace(base);

    expect(fs.existsSync(path.join(base, '.master_key'))).toBe(false);
  });

  it('does nothing when the active slot has no key yet', async () => {
    const base = upgradedDataDir('slotA');

    await startDataSpace(base);

    expect(fs.existsSync(path.join(base, '.master_key'))).toBe(false);
  });
});

interface IcaclsCall { file: string; args: string[]; options: { windowsHide: boolean } }
type IcaclsOutcome = { error: ExecFileException | null; stderr: string };

function recordingExecFile(calls: IcaclsCall[], outcome: IcaclsOutcome = { error: null, stderr: '' }, onCall?: (call: IcaclsCall) => void): ExecFileRunner {
  return (file, args, options, callback) => {
    const call = { file, args: [...args], options };
    calls.push(call);
    onCall?.(call);
    queueMicrotask(() => callback(outcome.error, '', outcome.stderr));
  };
}

function captureWarnings(): string[] {
  const warnings: string[] = [];
  setStorageLogger(() => ({ info() {}, debug() {}, error() {}, trace() {}, warn(message: string) { warnings.push(message); } }) as never);
  return warnings;
}

function strayTemporaries(base: string): string[] {
  return fs.readdirSync(base).filter((name) => name.endsWith('.tmp'));
}

const WINDOWS_ENV = { USERNAME: 'alice', USERDOMAIN: 'CORP' };

describe('root .master_key copy permissions', () => {
  it('RF-W07-crypto-root-adopts-slot-master-key: on Windows the root copy gets the icacls tightening of a newly created .master_key before it is renamed into place', async () => {
    const base = upgradedDataDir('slotB');
    const slotKey = randomBytes(32);
    const slotKeyFile = writeSlotKey(base, 'slotB', slotKey);
    const target = path.join(base, '.master_key');
    const calls: IcaclsCall[] = [];
    const seenAtCall: { targetExists: boolean; content: Buffer }[] = [];
    const execFile = recordingExecFile(calls, undefined, (call) => {
      seenAtCall.push({ targetExists: fs.existsSync(target), content: fs.readFileSync(call.args[0]!) });
    });

    const startup = new DataSpaceStartup(base, { recover: async () => {} } as never, undefined, { platform: 'win32', env: WINDOWS_ENV, execFile });
    await startup.start();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.file).toBe('icacls');
    expect(call!.options).toEqual({ windowsHide: true });
    expect(path.dirname(call!.args[0]!)).toBe(base);
    expect(path.basename(call!.args[0]!)).toMatch(/^\.durable-[0-9a-f-]+\.tmp$/);
    expect(call!.args.slice(1)).toEqual([
      '/inheritance:r', '/grant:r', 'CORP\\alice:(F)', '/grant:r', '*S-1-5-18:(F)', '/grant:r', '*S-1-5-32-544:(F)',
    ]);
    expect(seenAtCall).toEqual([{ targetExists: false, content: fs.readFileSync(slotKeyFile) }]);
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(slotKeyFile));
    expect(strayTemporaries(base)).toEqual([]);

    const createdCalls: IcaclsCall[] = [];
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'w07-master-key-new-'));
    roots.push(fresh);
    await CryptoServiceImpl.open(fresh, { log: quietLog, platform: 'win32', env: WINDOWS_ENV, execFile: recordingExecFile(createdCalls) });
    expect(createdCalls.map((created) => [created.file, created.args.slice(1), created.options])).toEqual([[call!.file, call!.args.slice(1), call!.options]]);
    expect(createdCalls[0]!.args[0]).toBe(path.join(fresh, '.master_key'));
  });

  it('RF-W07-crypto-root-adopts-slot-master-key: on POSIX the root copy is 0600 and icacls is never run', async () => {
    const base = upgradedDataDir('slotA');
    const slotKeyFile = writeSlotKey(base, 'slotA', randomBytes(32));
    fs.chmodSync(slotKeyFile, 0o644);
    const calls: IcaclsCall[] = [];

    await adoptActiveSlotMasterKey(base, path.join(base, 'slots', 'slotA'), { platform: 'linux', env: WINDOWS_ENV, execFile: recordingExecFile(calls) });

    expect(calls).toEqual([]);
    expect(fs.readFileSync(path.join(base, '.master_key'))).toEqual(fs.readFileSync(slotKeyFile));
    if (process.platform !== 'win32') expect(fs.statSync(path.join(base, '.master_key')).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['icacls exits non-zero', { error: Object.assign(new Error('Command failed: icacls'), { code: 5 }), stderr: 'Access is denied.\r\n' }, 'icacls 收紧 .master_key 权限未成功: Access is denied.'],
    ['icacls cannot be spawned', { error: Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' }) as ExecFileException, stderr: '' }, '无法执行 icacls 收紧 .master_key 权限: spawn icacls ENOENT'],
  ])('keeps the copy best-effort like create_master_key when %s', async (_label, outcome, warning) => {
    const base = upgradedDataDir('slotA');
    const slotKeyFile = writeSlotKey(base, 'slotA', randomBytes(32));
    const warnings = captureWarnings();
    const calls: IcaclsCall[] = [];

    await adoptActiveSlotMasterKey(base, path.join(base, 'slots', 'slotA'), { platform: 'win32', env: WINDOWS_ENV, execFile: recordingExecFile(calls, outcome as IcaclsOutcome) });

    expect(calls).toHaveLength(1);
    expect(warnings).toContain(warning);
    expect(fs.readFileSync(path.join(base, '.master_key'))).toEqual(fs.readFileSync(slotKeyFile));
    expect(strayTemporaries(base)).toEqual([]);
  });

  it('skips icacls without USERNAME on Windows (same warning as create_master_key) and still adopts', async () => {
    const base = upgradedDataDir('slotA');
    const slotKeyFile = writeSlotKey(base, 'slotA', randomBytes(32));
    const warnings = captureWarnings();
    const calls: IcaclsCall[] = [];

    await adoptActiveSlotMasterKey(base, path.join(base, 'slots', 'slotA'), { platform: 'win32', env: { USERNAME: '  ' }, execFile: recordingExecFile(calls) });

    expect(calls).toEqual([]);
    expect(warnings).toContain('跳过 .master_key ACL 收紧：无法解析当前用户(USERNAME)');
    expect(fs.readFileSync(path.join(base, '.master_key'))).toEqual(fs.readFileSync(slotKeyFile));
  });

  it('removes the temporary copy and leaves the root without a key when tightening throws', async () => {
    const base = upgradedDataDir('slotA');
    writeSlotKey(base, 'slotA', randomBytes(32));
    const warnings = captureWarnings();
    const execFile: ExecFileRunner = () => { throw new Error('runner exploded'); };

    await adoptActiveSlotMasterKey(base, path.join(base, 'slots', 'slotA'), { platform: 'win32', env: WINDOWS_ENV, execFile });

    expect(fs.existsSync(path.join(base, '.master_key'))).toBe(false);
    expect(strayTemporaries(base)).toEqual([]);
    expect(warnings.some((line) => line.includes('复制活动槽位 .master_key 到应用根目录失败') && line.includes('runner exploded'))).toBe(true);
  });
});
