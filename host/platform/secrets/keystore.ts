/**
 * 根种子的平台保护：
 * - macOS / Linux：`@napi-rs/keyring`（service `deep-student`，account `key_seed.<指纹>`），
 *   与 Rust keyring 3.6.3（apple-native / sync-secret-service）同一条目；Linux 固定 Secret Service，
 *   不使用 @napi-rs/keyring 的 keyutils 回退（Rust 侧没有该后端）。
 * - Windows：DPAPI（`crypt32.dll` `CryptProtectData` / `CryptUnprotectData`，当前用户、
 *   `CRYPTPROTECT_UI_FORBIDDEN`、熵 `deep-student.key_seed.dpapi.v1`）。通过 `koffi` 直接调用 Win32 API，
 *   避免启动 `powershell.exe` 子进程被 AppLocker / Constrained Language Mode 拦截，并与 Rust `win_dpapi`
 *   及 .NET `ProtectedData` 载荷完全字节兼容。
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { SeedKeystore } from './api.ts';

export const SERVICE_NAME = 'deep-student';
export const KEY_SEED_FILE_ONLY_ENV = 'DEEP_STUDENT_KEY_SEED_FILE_ONLY';
export const DPAPI_SEED_ENTROPY = Buffer.from('deep-student.key_seed.dpapi.v1', 'utf8');

type Env = Readonly<Record<string, string | undefined>>;

/** `keystore_disabled_by_env()`。 */
export function keystoreDisabledByEnv(env: Env = process.env): boolean {
  const raw = env[KEY_SEED_FILE_ONLY_ENV];
  if (raw === undefined) return false;
  const v = raw.trim();
  return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

interface KeyringModule {
  AsyncEntry: new (service: string, username: string, options?: { linux?: { store?: 'secret-service' | 'keyutils' } }) => {
    getPassword(): Promise<string | null>;
    setPassword(password: string): Promise<void>;
  };
}

let keyringModule: Promise<KeyringModule> | null = null;
function loadKeyring(): Promise<KeyringModule> {
  keyringModule ??= import('@napi-rs/keyring') as Promise<KeyringModule>;
  return keyringModule;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 平台密钥库（生产实现）。`service` 只在测试中改为隔离名称。 */
export class PlatformSeedKeystore implements SeedKeystore {
  readonly backendName: string;
  private readonly platform: NodeJS.Platform;
  private readonly service: string;

  constructor(
    platform: NodeJS.Platform,
    service: string = SERVICE_NAME,
  ) {
    this.platform = platform;
    this.service = service;
    this.backendName = platform === 'darwin' ? 'macOS Keychain' : 'Secret Service';
  }

  private async entry(fingerprint: string) {
    const { AsyncEntry } = await loadKeyring();
    const options = this.platform === 'linux' ? { linux: { store: 'secret-service' as const } } : undefined;
    return new AsyncEntry(this.service, `key_seed.${fingerprint}`, options);
  }

  async load(fingerprint: string): Promise<string | null> {
    try {
      return await (await this.entry(fingerprint)).getPassword();
    } catch (error) {
      throw new Error(errorText(error));
    }
  }

  async store(fingerprint: string, seed: string): Promise<void> {
    try {
      await (await this.entry(fingerprint)).setPassword(seed);
    } catch (error) {
      throw new Error(errorText(error));
    }
  }
}

/** `platform_seed_keystore()`：macOS/Linux 且未被环境变量禁用时返回真实实现。 */
export function platformSeedKeystore(platform: NodeJS.Platform = process.platform, env: Env = process.env): SeedKeystore | null {
  if (keystoreDisabledByEnv(env)) return null;
  return platform === 'darwin' || platform === 'linux' ? new PlatformSeedKeystore(platform) : null;
}

// ------------------------------------------------------------------ DPAPI（Windows）

const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$parts = [Console]::In.ReadToEnd().Trim().Split(" ")',
  '$data = [Convert]::FromBase64String($parts[1])',
  '$entropy = [Convert]::FromBase64String($parts[2])',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  "if ($parts[0] -eq 'protect') { $out = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) } else { $out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) }",
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('; ');

/**
 * DPAPI 调用失败的原因。Rust 直接调 Win32 API，只会遇到 `crypto`；经 PowerShell 调用多出
 * `blocked`（AppLocker / 软件限制策略禁止启动 powershell.exe，或受限语言模式禁止 Add-Type 与
 * 非核心类型方法调用）与 `unavailable`（其它无法归类的失败）。
 */
export type DpapiFailureKind = 'blocked' | 'crypto' | 'unavailable';
export interface DpapiFailure {
  readonly kind: DpapiFailureKind;
  readonly detail: string;
}
export type DpapiResult = { readonly ok: true; readonly data: Buffer } | { readonly ok: false; readonly failure: DpapiFailure };

export interface PowerShellOutcome {
  /** 进程未能启动时的 errno 名（`ENOENT`、`EACCES`、`UNKNOWN` 等）。 */
  readonly spawnError: string | null;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type PowerShellRunner = (script: string, stdin: string) => Promise<PowerShellOutcome>;

export const runPowerShell: PowerShellRunner = (script, stdin) => new Promise((resolve) => {
  const child = execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error === null) return resolve({ spawnError: null, exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
      const code: unknown = (error as { code?: unknown }).code;
      resolve({
        spawnError: typeof code === 'string' ? code : null,
        exitCode: typeof code === 'number' ? code : null,
        stdout: String(stdout),
        stderr: String(stderr).trim() === '' ? error.message : String(stderr),
      });
    },
  );
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(stdin);
});

const POLICY_BLOCK_PATTERNS = [
  /language mode/i,
  /ConstrainedLanguage/i,
  /Cannot invoke method/i,
  /Cannot add type/i,
  /blocked by (?:your )?(?:group policy|system administrator)/i,
  /AppLocker/i,
  /AuthorizationManager check failed/i,
  /running scripts is disabled/i,
];
const CRYPTO_FAILURE_PATTERNS = [
  /CryptographicException/i,
  /Key not valid for use in specified state/i,
  /The data is invalid/i,
  /The parameter is incorrect/i,
];

function firstLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 400);
}

/** 把一次 PowerShell 调用的结果归类；成功返回解出的字节。 */
export function classifyDpapiOutcome(outcome: PowerShellOutcome): DpapiResult {
  if (outcome.spawnError !== null) {
    const kind: DpapiFailureKind = outcome.spawnError === 'ENOENT' ? 'unavailable' : 'blocked';
    return { ok: false, failure: { kind, detail: `无法启动 powershell.exe（${outcome.spawnError}）: ${firstLines(outcome.stderr)}` } };
  }
  if (outcome.exitCode === 0) {
    const text = outcome.stdout.trim();
    if (text !== '') return { ok: true, data: Buffer.from(text, 'base64') };
    return { ok: false, failure: { kind: 'unavailable', detail: 'PowerShell 没有输出结果' } };
  }
  const detail = `PowerShell 退出码 ${String(outcome.exitCode)}: ${firstLines(outcome.stderr)}`;
  if (POLICY_BLOCK_PATTERNS.some((pattern) => pattern.test(outcome.stderr))) return { ok: false, failure: { kind: 'blocked', detail } };
  if (CRYPTO_FAILURE_PATTERNS.some((pattern) => pattern.test(outcome.stderr))) return { ok: false, failure: { kind: 'crypto', detail } };
  return { ok: false, failure: { kind: 'unavailable', detail } };
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

interface Win32DpapiBinding {
  protect(data: Uint8Array, entropy: Uint8Array): DpapiResult;
  unprotect(data: Uint8Array, entropy: Uint8Array): DpapiResult;
}

let win32DpapiBinding: Win32DpapiBinding | null = null;

function toDataBlob(bytes: Uint8Array): { cbData: number; pbData: Uint8Array } {
  // koffi 对 uint8 * 传空 Buffer 可能转为 NULL；1 字节占位配合 cbData=0 可安全处理空载荷。
  return { cbData: bytes.byteLength, pbData: bytes.byteLength > 0 ? bytes : Buffer.alloc(1) };
}

function classifyWin32DpapiFailure(op: 'protect' | 'unprotect', errorCode: number): DpapiResult {
  const hex = `0x${(errorCode >>> 0).toString(16).padStart(8, '0')}`;
  // ERROR_INVALID_DATA(13), ERROR_INVALID_PARAMETER(87), ERROR_FILE_NOT_FOUND(2),
  // ERROR_ACCESS_DENIED(5), ERROR_NO_SUCH_LOGON_SESSION(1312), NTE_*/CRYPT_E_*(0x8009xxxx), E_*(0x8007xxxx)
  const unsigned = errorCode >>> 0;
  const isCryptoCode = unsigned === 13 || unsigned === 87 || unsigned === 2 || unsigned === 5 || unsigned === 1312
    || (unsigned >= 0x80090000 && unsigned <= 0x8009ffff)
    || unsigned === 0x8007000d || unsigned === 0x80070057 || unsigned === 0x80070005;
  const kind: DpapiFailureKind = op === 'unprotect' && isCryptoCode ? 'crypto' : 'unavailable';
  return {
    ok: false,
    failure: {
      kind,
      detail: `Win32 Crypt${op === 'protect' ? 'Protect' : 'Unprotect'}Data 失败 (${hex}, code=${unsigned})`,
    },
  };
}

function loadWin32Dpapi(): Win32DpapiBinding {
  if (win32DpapiBinding) return win32DpapiBinding;
  const require = createRequire(import.meta.url);
  const koffi = require('koffi') as typeof import('koffi');
  const crypt32 = koffi.load('crypt32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  // 避免重复注册同名 koffi struct：仅在本函数懒初始化时定义一次。
  const DataBlobIn = koffi.struct('DS_DPAPI_DATA_BLOB_IN', { cbData: 'uint32', pbData: 'uint8 *' });
  const DataBlobOut = koffi.struct('DS_DPAPI_DATA_BLOB_OUT', { cbData: 'uint32', pbData: 'void *' });
  const CryptProtectData = crypt32.func(
    'bool __stdcall CryptProtectData(DS_DPAPI_DATA_BLOB_IN *pDataIn, const char16_t *szDataDescr, DS_DPAPI_DATA_BLOB_IN *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ DS_DPAPI_DATA_BLOB_OUT *pDataOut)',
  );
  const CryptUnprotectData = crypt32.func(
    'bool __stdcall CryptUnprotectData(DS_DPAPI_DATA_BLOB_IN *pDataIn, void *ppszDataDescr, DS_DPAPI_DATA_BLOB_IN *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ DS_DPAPI_DATA_BLOB_OUT *pDataOut)',
  );
  const LocalFree = kernel32.func('void * __stdcall LocalFree(void *hMem)');
  const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');

  const invoke = (op: 'protect' | 'unprotect', data: Uint8Array, entropy: Uint8Array): DpapiResult => {
    const inBlob = toDataBlob(data);
    const entropyBlob = entropy.byteLength > 0 ? toDataBlob(entropy) : null;
    const outBlob: { cbData?: number; pbData?: unknown } = {};
    const ok = op === 'protect'
      ? CryptProtectData(inBlob, null, entropyBlob, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob)
      : CryptUnprotectData(inBlob, null, entropyBlob, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob);
    if (!ok) {
      return classifyWin32DpapiFailure(op, Number(GetLastError()));
    }
    try {
      const size = Number(outBlob.cbData ?? 0);
      if (size === 0 || !outBlob.pbData) return { ok: true, data: Buffer.alloc(0) };
      return { ok: true, data: Buffer.from(koffi.decode(outBlob.pbData, 'uint8', size) as Uint8Array) };
    } finally {
      if (outBlob.pbData) LocalFree(outBlob.pbData);
    }
  };

  win32DpapiBinding = {
    protect: (data, entropy) => invoke('protect', data, entropy),
    unprotect: (data, entropy) => invoke('unprotect', data, entropy),
  };
  return win32DpapiBinding;
}

async function runNativeDpapi(op: 'protect' | 'unprotect', data: Uint8Array, entropy: Uint8Array): Promise<DpapiResult> {
  if (process.platform !== 'win32') {
    return { ok: false, failure: { kind: 'unavailable', detail: 'Windows DPAPI 仅在 win32 平台可用' } };
  }
  try {
    const binding = loadWin32Dpapi();
    return op === 'protect' ? binding.protect(data, entropy) : binding.unprotect(data, entropy);
  } catch (error) {
    return { ok: false, failure: { kind: 'unavailable', detail: `无法加载 crypt32.dll DPAPI: ${errorText(error)}` } };
  }
}

async function runDpapi(op: 'protect' | 'unprotect', data: Uint8Array, entropy: Uint8Array, run?: PowerShellRunner): Promise<DpapiResult> {
  if (run === undefined) return runNativeDpapi(op, data, entropy);
  const outcome = await run(DPAPI_SCRIPT, `${op} ${Buffer.from(data).toString('base64')} ${Buffer.from(entropy).toString('base64')}\n`);
  return classifyDpapiOutcome(outcome);
}

export function dpapiProtectDetailed(data: Uint8Array, entropy: Uint8Array = DPAPI_SEED_ENTROPY, run?: PowerShellRunner): Promise<DpapiResult> {
  return runDpapi('protect', data, entropy, run);
}

export function dpapiUnprotectDetailed(data: Uint8Array, entropy: Uint8Array = DPAPI_SEED_ENTROPY, run?: PowerShellRunner): Promise<DpapiResult> {
  return runDpapi('unprotect', data, entropy, run);
}

/** Rust `win_dpapi::{protect,unprotect}` 的形状：失败统一为 null。 */
export async function dpapiProtect(data: Uint8Array, entropy: Uint8Array = DPAPI_SEED_ENTROPY): Promise<Buffer | null> {
  const result = await dpapiProtectDetailed(data, entropy);
  return result.ok ? result.data : null;
}

export async function dpapiUnprotect(data: Uint8Array, entropy: Uint8Array = DPAPI_SEED_ENTROPY): Promise<Buffer | null> {
  const result = await dpapiUnprotectDetailed(data, entropy);
  return result.ok ? result.data : null;
}

/** Windows 种子保护端口；SecureStore 通过它调用 DPAPI，测试可注入。 */
export interface DpapiPort {
  protect(data: Uint8Array, entropy: Uint8Array): Promise<DpapiResult>;
  unprotect(data: Uint8Array, entropy: Uint8Array): Promise<DpapiResult>;
}

/** Windows 原生 koffi DPAPI（`crypt32.dll`，无 PowerShell 子进程依赖）。 */
export const NATIVE_DPAPI: DpapiPort = {
  protect: (data, entropy) => dpapiProtectDetailed(data, entropy),
  unprotect: (data, entropy) => dpapiUnprotectDetailed(data, entropy),
};

/** 兼容旧引用：现直接委派给原生 `NATIVE_DPAPI`。 */
export const POWERSHELL_DPAPI: DpapiPort = NATIVE_DPAPI;
