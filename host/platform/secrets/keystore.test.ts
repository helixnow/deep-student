/**
 * 真实 macOS 钥匙串互通：用 `security` CLI 写入 generic password（与 Rust keyring 3.6.3 apple-native
 * `set_generic_password(service, account)` 写入同一类条目），再经 @napi-rs/keyring 读出；反向亦然。
 * 只使用测试专用 service 名，结束时删除，绝不触碰 `deep-student` 条目。
 * 默认跳过（避免 CI/无人值守环境弹出授权框）；设置 `F4_KEYCHAIN_TEST=1` 运行。
 */
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DPAPI_SEED_ENTROPY,
  dpapiProtect,
  dpapiUnprotect,
  dpapiUnprotectDetailed,
  keystoreDisabledByEnv,
  PlatformSeedKeystore,
  platformSeedKeystore,
  SERVICE_NAME,
} from './keystore.ts';

const enabled = process.platform === 'darwin' && process.env.F4_KEYCHAIN_TEST === '1';
const service = `deep-student-f4-test-${process.pid}`;
const fp = 'f'.repeat(64);

describe('keystore 配置', () => {
  it('service/account 名与 Rust 一致', () => {
    expect(SERVICE_NAME).toBe('deep-student');
    const ks = platformSeedKeystore('darwin', {});
    expect(ks?.backendName).toBe('macOS Keychain');
    expect(platformSeedKeystore('linux', {})?.backendName).toBe('Secret Service');
    expect(platformSeedKeystore('win32', {})).toBeNull();
  });
  it('DEEP_STUDENT_KEY_SEED_FILE_ONLY', () => {
    expect(keystoreDisabledByEnv({ DEEP_STUDENT_KEY_SEED_FILE_ONLY: '1' })).toBe(true);
    expect(keystoreDisabledByEnv({ DEEP_STUDENT_KEY_SEED_FILE_ONLY: ' FALSE ' })).toBe(false);
    expect(keystoreDisabledByEnv({ DEEP_STUDENT_KEY_SEED_FILE_ONLY: '0' })).toBe(false);
    expect(keystoreDisabledByEnv({ DEEP_STUDENT_KEY_SEED_FILE_ONLY: ' ' })).toBe(false);
    expect(platformSeedKeystore('darwin', { DEEP_STUDENT_KEY_SEED_FILE_ONLY: 'yes' })).toBeNull();
  });
});

describe.runIf(enabled)('macOS 钥匙串互通（真实钥匙串，测试专用 service）', () => {
  const del = (account: string) => {
    try {
      execFileSync('security', ['delete-generic-password', '-s', service, '-a', account], { stdio: 'ignore' });
    } catch {
      // 条目不存在时 security 返回非零；清理是幂等的。
      return;
    }
  };
  afterAll(() => {
    del(`key_seed.${fp}`);
    del(`key_seed.${'e'.repeat(64)}`);
  });

  it('security CLI 写入 → @napi-rs/keyring 读出', async () => {
    execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', `key_seed.${fp}`, '-w', 'seed-from-cli']);
    const ks = new PlatformSeedKeystore('darwin', service);
    expect(await ks.load(fp)).toBe('seed-from-cli');
  });
  it('@napi-rs/keyring 写入 → security CLI 读出；缺失条目返回 null', async () => {
    const ks = new PlatformSeedKeystore('darwin', service);
    const other = 'e'.repeat(64);
    await ks.store(other, 'seed-from-node');
    expect(execFileSync('security', ['find-generic-password', '-s', service, '-a', `key_seed.${other}`, '-w'], { encoding: 'utf8' }).trim()).toBe('seed-from-node');
    expect(await ks.load('d'.repeat(64))).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('Windows 原生 koffi DPAPI 互通', () => {
  it('CryptProtectData / CryptUnprotectData 往返加解密并识别损坏载荷与错误熵', async () => {
    const plain = Buffer.from('0123456789abcdef'.repeat(4), 'utf8');
    const cipher = await dpapiProtect(plain, DPAPI_SEED_ENTROPY);
    expect(cipher).not.toBeNull();
    expect(cipher!.equals(plain)).toBe(false);

    const decrypted = await dpapiUnprotect(cipher!, DPAPI_SEED_ENTROPY);
    expect(decrypted?.equals(plain)).toBe(true);

    const wrongEntropy = await dpapiUnprotectDetailed(cipher!, Buffer.from('wrong-entropy', 'utf8'));
    expect(wrongEntropy).toMatchObject({ ok: false, failure: { kind: 'crypto' } });

    const corrupted = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const invalid = await dpapiUnprotectDetailed(corrupted, DPAPI_SEED_ENTROPY);
    expect(invalid).toMatchObject({ ok: false, failure: { kind: 'crypto' } });
  });

  it('与 PowerShell System.Security.Cryptography.ProtectedData 双向字节兼容', async () => {
    const seed = 'koffi-dpapi-interop-seed-v1';
    const psScript = [
      'Add-Type -AssemblyName System.Security',
      `$e = [Convert]::FromBase64String('${DPAPI_SEED_ENTROPY.toString('base64')}')`,
      `$d = [Text.Encoding]::UTF8.GetBytes('${seed}')`,
      '$c = [System.Security.Cryptography.ProtectedData]::Protect($d, $e, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Convert]::ToBase64String($c))',
    ].join('; ');
    const psB64 = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const psPlain = await dpapiUnprotect(Buffer.from(psB64, 'base64'), DPAPI_SEED_ENTROPY);
    expect(psPlain?.toString('utf8')).toBe(seed);

    const koffiCipher = await dpapiProtect(Buffer.from(seed, 'utf8'), DPAPI_SEED_ENTROPY);
    expect(koffiCipher).not.toBeNull();
    const psUnprotect = [
      'Add-Type -AssemblyName System.Security',
      `$e = [Convert]::FromBase64String('${DPAPI_SEED_ENTROPY.toString('base64')}')`,
      `$c = [Convert]::FromBase64String('${koffiCipher!.toString('base64')}')`,
      '$p = [System.Security.Cryptography.ProtectedData]::Unprotect($c, $e, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))',
    ].join('; ');
    const psDecoded = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psUnprotect], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    expect(psDecoded).toBe(seed);
  });
});
