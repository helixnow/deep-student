// ------------------------------------------------------------------ 错误

/** `SecureStoreError` 的变体名（与 Rust enum 变体一一对应）。 */
export type SecureStoreErrorKind =
  | 'KeychainUnavailable'
  | 'KeyNotFound'
  | 'AccessDenied'
  | 'PlatformUnsupported'
  | 'SerializationError'
  | 'EncryptionError'
  | 'Other'
  | 'CloudEncryptionPasswordTooShort'
  | 'CloudEncryptionPasswordTooWeak'
  | 'CloudCredentialGenerationConflict';

/** 云端 E2EE 新设口令过短的稳定 IPC code。 */
export const CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE = 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT';
/** 云端 E2EE 新设口令过弱的稳定 IPC code。 */
export const CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE = 'E_CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK';
/** staged generation 冲突的稳定 IPC code。 */
export const CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE = 'E_CLOUD_CREDENTIALS_GENERATION_CONFLICT';
/** 与 ZIP 全保真导出 `MIN_ENCRYPTION_PASSWORD_CHARS` 对齐。 */
export const MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS = 8;
/** 新设口令最少需要的不同 Unicode 码点数。 */
export const MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS = 4;

const ERROR_PREFIX: Record<SecureStoreErrorKind, string> = {
  KeychainUnavailable: 'Keychain不可用: ',
  KeyNotFound: '密钥不存在: ',
  AccessDenied: '访问被拒绝: ',
  PlatformUnsupported: '平台不支持: ',
  SerializationError: '序列化错误: ',
  EncryptionError: '加密错误: ',
  Other: '其他错误: ',
  CloudEncryptionPasswordTooShort: '',
  CloudEncryptionPasswordTooWeak: '',
  CloudCredentialGenerationConflict: '',
};

const STABLE_CODE: Record<SecureStoreErrorKind, string> = {
  KeychainUnavailable: 'SECURE_STORE_UNAVAILABLE',
  PlatformUnsupported: 'SECURE_STORE_UNAVAILABLE',
  KeyNotFound: 'SECURE_STORE_KEY_NOT_FOUND',
  AccessDenied: 'SECURE_STORE_ACCESS_DENIED',
  SerializationError: 'SECURE_STORE_DATA_INVALID',
  EncryptionError: 'SECURE_STORE_CRYPTO_ERROR',
  CloudEncryptionPasswordTooShort: CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
  CloudEncryptionPasswordTooWeak: CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE,
  CloudCredentialGenerationConflict: CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE,
  Other: 'SECURE_STORE_INTERNAL',
};

/** dstu-core `CommandError` 的 serde 形状（camelCase，`data`/`traceId` 缺省时省略）。 */
export interface CommandErrorEnvelope {
  code: string;
  message: string;
  data?: unknown;
  traceId?: string;
}

/**
 * 对应 Rust `SecureStoreError`。`message` = thiserror 的 Display（中文前缀 + 详情），
 * `detail` = 变体携带的字符串。
 */
export class SecureStoreError extends Error {
  readonly kind: SecureStoreErrorKind;
  readonly detail: string;
  constructor(kind: SecureStoreErrorKind, detail: string) {
    super(ERROR_PREFIX[kind] + detail);
    this.name = 'SecureStoreError';
    this.kind = kind;
    this.detail = detail;
  }
  /** IPC 稳定错误码（`stable_code()`）。 */
  get stableCode(): string {
    return STABLE_CODE[this.kind];
  }
  /** `retryable` 字段：仅 KeychainUnavailable / AccessDenied / PlatformUnsupported。 */
  get retryable(): boolean {
    return this.kind === 'KeychainUnavailable' || this.kind === 'AccessDenied' || this.kind === 'PlatformUnsupported';
  }
  /** `to_command_error(operation)`：`{code, message, data:{operation, retryable}}`。 */
  toCommandError(operation: string): CommandErrorEnvelope {
    return { code: this.stableCode, message: this.message, data: { operation, retryable: this.retryable } };
  }
}
