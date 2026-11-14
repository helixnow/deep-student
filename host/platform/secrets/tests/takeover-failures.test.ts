/**
 * 接管 Tauri 版密钥时的两种平台失败模式：
 * - macOS：钥匙串条目由 Tauri 签名的应用创建，Electron 版读取会弹授权框，用户拒绝时必须 fail-closed，
 *   但要告诉用户“数据还在、怎样重新授权”，且授权后无需重启状态即可重试成功。
 * - Windows：DPAPI 经 powershell.exe 调用，AppLocker / 受限语言模式下会失败；不能被说成
 *   “跨设备种子无法解密”，也不能降级为明文。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../log/api.ts';
import { resolveOsDirs } from '../../paths/index.ts';
import { SecureStoreError, type SeedKeystore } from '../api.ts';
import {
  classifyDpapiOutcome,
  dpapiUnprotectDetailed,
  type DpapiPort,
  type DpapiResult,
  type PowerShellOutcome,
} from '../keystore.ts';
import { keystoreUnavailableDetail, resolveKeystoreSeed, SecureStoreImpl, seedFingerprint } from '../secure-store.ts';

const silent: Logger = { target: 't', error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const os = resolveOsDirs('linux', { HOME: '/nonexistent-home' });
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'w07-takeover-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rejection(p: Promise<unknown>): Promise<SecureStoreError> {
  const error = await p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
  expect(error).toBeInstanceOf(SecureStoreError);
  return error as SecureStoreError;
}

const outcome = (o: Partial<PowerShellOutcome>): PowerShellOutcome => ({ spawnError: null, exitCode: 1, stdout: '', stderr: '', ...o });

describe('DPAPI over PowerShell: failure classification', () => {
  it('separates policy blocks from genuine DPAPI failures', () => {
    const blocked = [
      outcome({ spawnError: 'UNKNOWN', exitCode: null, stderr: 'spawn UNKNOWN' }),
      outcome({ spawnError: 'EACCES', exitCode: null, stderr: 'spawn powershell.exe EACCES' }),
      outcome({ stderr: 'Add-Type : Cannot add type. Definition of new types is not supported in this language mode.' }),
      outcome({ stderr: 'Cannot invoke method. Method invocation is supported only on core types in this language mode.' }),
      outcome({ stderr: 'This program is blocked by group policy. For more information, contact your system administrator.' }),
    ];
    for (const item of blocked) expect(classifyDpapiOutcome(item)).toMatchObject({ ok: false, failure: { kind: 'blocked' } });

    expect(classifyDpapiOutcome(outcome({
      stderr: 'Exception calling "Unprotect" with "3" argument(s): "Key not valid for use in specified state."\r\n+ CategoryInfo : NotSpecified: (:) [], MethodInvocationException\r\n+ FullyQualifiedErrorId : CryptographicException',
    }))).toMatchObject({ ok: false, failure: { kind: 'crypto' } });
    expect(classifyDpapiOutcome(outcome({ spawnError: 'ENOENT', exitCode: null }))).toMatchObject({ ok: false, failure: { kind: 'unavailable' } });
    expect(classifyDpapiOutcome(outcome({ stderr: 'something else entirely' }))).toMatchObject({ ok: false, failure: { kind: 'unavailable' } });
    expect(classifyDpapiOutcome(outcome({ exitCode: 0, stdout: '' }))).toMatchObject({ ok: false, failure: { kind: 'unavailable' } });

    const ok = classifyDpapiOutcome(outcome({ exitCode: 0, stdout: `${Buffer.from('seed').toString('base64')}\r\n` }));
    expect(ok.ok && ok.data.toString()).toBe('seed');
  });

  it('passes the payload through stdin in the documented format', async () => {
    let stdin = '';
    const result = await dpapiUnprotectDetailed(Buffer.from('wrapped'), Buffer.from('entropy'), async (_script, input) => {
      stdin = input;
      return outcome({ exitCode: 0, stdout: Buffer.from('plain').toString('base64') });
    });
    expect(stdin).toBe(`unprotect ${Buffer.from('wrapped').toString('base64')} ${Buffer.from('entropy').toString('base64')}\n`);
    expect(result.ok && result.data.toString()).toBe('plain');
  });
});

/** 可切换的假 DPAPI：封装 = 加前缀；`mode` 模拟策略阻止 / 用户绑定失败。 */
class FakeDpapi implements DpapiPort {
  mode: 'ok' | 'blocked' | 'crypto' = 'ok';
  private fail(): DpapiResult {
    return this.mode === 'blocked'
      ? { ok: false, failure: { kind: 'blocked', detail: 'PowerShell 退出码 1: Cannot add type ... language mode.' } }
      : { ok: false, failure: { kind: 'crypto', detail: 'Key not valid for use in specified state.' } };
  }
  async protect(data: Uint8Array): Promise<DpapiResult> {
    return this.mode === 'ok' ? { ok: true, data: Buffer.concat([Buffer.from('W:'), data]) } : this.fail();
  }
  async unprotect(data: Uint8Array): Promise<DpapiResult> {
    return this.mode === 'ok' ? { ok: true, data: Buffer.from(data).subarray(2) } : this.fail();
  }
}

function windowsStore(root: string, dpapi: DpapiPort): SecureStoreImpl {
  return new SecureStoreImpl({ secureDir: join(root, '.secure'), enabled: true, keystore: null, platform: 'win32', env: {}, os, log: silent, dpapi });
}

describe('Windows: DPAPI blocked by AppLocker / constrained language mode', () => {
  it('a fresh install refuses to store secrets in plaintext and says why', async () => {
    const root = tempDir();
    const dpapi = new FakeDpapi();
    dpapi.mode = 'blocked';
    const error = await rejection(windowsStore(root, dpapi).saveSecret('openai.api_key', 'sk-test'));
    expect(error.kind).toBe('PlatformUnsupported');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/AppLocker/);
    expect(error.message).toMatch(/不会以明文保存/);
    expect(existsSync(join(root, '.secure', '.key_seed'))).toBe(false);
    expect(existsSync(join(root, '.secure', 'openai.api_key.enc'))).toBe(false);
  });

  it('an existing DPAPI seed is reported as blocked (data intact) and works once the policy is lifted', async () => {
    const root = tempDir();
    const dpapi = new FakeDpapi();
    await windowsStore(root, dpapi).saveSecret('openai.api_key', 'sk-live');
    const seedBefore = readFileSync(join(root, '.secure', '.key_seed'), 'utf8');
    expect(seedBefore.startsWith('DPAPI1:')).toBe(true);

    dpapi.mode = 'blocked';
    const error = await rejection(windowsStore(root, dpapi).getSecret('openai.api_key'));
    expect(error.kind).toBe('PlatformUnsupported');
    expect(error.message).toMatch(/没有丢失/);
    expect(error.message).not.toMatch(/跨设备/);
    expect(readFileSync(join(root, '.secure', '.key_seed'), 'utf8')).toBe(seedBefore);

    dpapi.mode = 'ok';
    expect(await windowsStore(root, dpapi).getSecret('openai.api_key')).toBe('sk-live');
  });

  it('a seed bound to another Windows user keeps the Rust error kind and explains how to recover', async () => {
    const root = tempDir();
    const dpapi = new FakeDpapi();
    await windowsStore(root, dpapi).saveSecret('k', 'v');
    dpapi.mode = 'crypto';
    const error = await rejection(windowsStore(root, dpapi).getSecret('k'));
    expect(error.kind).toBe('EncryptionError');
    expect(error.message).toContain('DPAPI 解封密钥种子失败：种子与当前 Windows 用户/机器绑定，跨设备复制的种子无法解密');
    expect(error.message).toMatch(/原电脑上导出备份/);
  });
});

class FakeKeychain implements SeedKeystore {
  readonly backendName = 'macOS Keychain';
  readonly entries = new Map<string, string>();
  denial: string | null = null;
  async load(fingerprint: string): Promise<string | null> {
    if (this.denial !== null) throw new Error(this.denial);
    return this.entries.get(fingerprint) ?? null;
  }
  async store(fingerprint: string, seed: string): Promise<void> {
    this.entries.set(fingerprint, seed);
  }
}

describe('macOS: keychain item created by the Tauri-signed app', () => {
  it('a denied authorization prompt explains how to re-authorize instead of pointing at Linux', async () => {
    const keychain = new FakeKeychain();
    keychain.denial = 'Platform secure storage failure: User canceled the operation.';
    const error = await rejection(resolveKeystoreSeed(keychain, seedFingerprint('ef'.repeat(32))));
    expect(error.kind).toBe('KeychainUnavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/始终允许/);
    expect(error.message).toMatch(/钥匙串访问/);
    expect(error.message).not.toMatch(/Linux/);
  });

  it('classifies auth failures, missing UI and other keychain errors', () => {
    expect(keystoreUnavailableDetail('macOS Keychain', 'The user name or passphrase you entered is not correct.')).toMatch(/始终允许/);
    expect(keystoreUnavailableDetail('macOS Keychain', 'Platform secure storage failure: errSecAuthFailed (-25293)')).toMatch(/始终允许/);
    expect(keystoreUnavailableDetail('macOS Keychain', 'User interaction is not allowed.')).toMatch(/解锁“登录”钥匙串/);
    const generic = keystoreUnavailableDetail('macOS Keychain', 'The specified keychain could not be found.');
    expect(generic).toMatch(/解锁“登录”钥匙串/);
    expect(generic).not.toMatch(/Linux/);
    expect(keystoreUnavailableDetail('Secret Service', 'org.freedesktop.DBus.Error.ServiceUnknown')).toMatch(/Secret Service（gnome-keyring\/KWallet）/);
  });

  it('stays fail-closed while denied, never replaces the seed marker, and succeeds after the user allows access', async () => {
    const root = tempDir();
    const secureDir = join(root, '.secure');
    mkdirSync(secureDir, { recursive: true });
    const seed = '7a'.repeat(32);
    const fingerprint = seedFingerprint(seed);
    const marker = `KEYSTORE1:${fingerprint}`;
    writeFileSync(join(secureDir, '.key_seed'), marker);
    writeFileSync(join(secureDir, '.keystore_opt_in'), '');
    const keychain = new FakeKeychain();
    keychain.entries.set(fingerprint, seed);
    keychain.denial = 'Platform secure storage failure: User canceled the operation.';
    const store = new SecureStoreImpl({ secureDir, enabled: true, keystore: keychain, platform: 'darwin', env: {}, os, log: silent });

    const error = await rejection(store.saveSecret('deepseek.api_key', 'sk-new'));
    expect(error.kind).toBe('KeychainUnavailable');
    expect(readFileSync(join(secureDir, '.key_seed'), 'utf8')).toBe(marker);
    expect(existsSync(join(secureDir, 'deepseek.api_key.enc'))).toBe(false);

    keychain.denial = null;
    await store.saveSecret('deepseek.api_key', 'sk-new');
    expect(await store.getSecret('deepseek.api_key')).toBe('sk-new');
    expect(readFileSync(join(secureDir, '.key_seed'), 'utf8')).toBe(marker);
  });
});
