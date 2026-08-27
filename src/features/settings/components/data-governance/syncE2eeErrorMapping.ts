/**
 * [R09-e2ee] 云同步端到端加密错误的“人话”分类器。
 *
 * 后端（Rust）的 E2EE fail-closed 错误已带稳定 `[E_SYNC_E2EE_*]` 前缀；
 * 分类器先认 code，旧中文长文案仍作兜底（接线前 / 旧客户端）。
 *
 * - `plaintextLegacyRejected`：启用加密后遇到明文遗留对象/清单被拒收
 *   （`decode_payload` 的“缺少 DSBK 加密头”、文件级对象的“缺少 cipher_sha256”）；
 * - `wrongPassword`：加密密码与云端既有数据不一致
 *   （标记校验子不一致、DSBK AEAD 解密失败）；
 * - `markerCorrupted`：云端 `.encryption-marker` 损坏/异常导致 fail-closed；
 * - `passwordRequired`：云端已加密，但本机未提供 / 未配置解密密码；
 * - `downgradeRejected`：[R4-antidegrade] 云端有加密标记但下载对象不是 DSBK
 *   密文，疑似密文被明文替换（降级攻击），下载侧默认拒收；
 * - `claimConflict`：[R4-e2ee-cas] 加密标记认领租约被其他设备持有 / 标记被
 *   并发创建或改动，本次操作已安全中止，重试即可。
 *
 * 匹配片段与 src-tauri 侧错误文案的对应关系由
 * `tests/vitest/data-governance/syncE2eeErrorMapping.test.ts` 用后端原文钉死。
 */

export type SyncE2eeErrorKind =
  | 'plaintextLegacyRejected'
  | 'wrongPassword'
  | 'markerCorrupted'
  | 'passwordRequired'
  | 'downgradeRejected'
  | 'claimConflict';

/** 与 `src-tauri/src/cloud_storage/mod.rs` 同名常量对齐。 */
export const SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE =
  'E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED';
export const SYNC_E2EE_WRONG_PASSWORD_CODE = 'E_SYNC_E2EE_WRONG_PASSWORD';
export const SYNC_E2EE_MARKER_CORRUPTED_CODE = 'E_SYNC_E2EE_MARKER_CORRUPTED';
export const SYNC_E2EE_PASSWORD_REQUIRED_CODE = 'E_SYNC_E2EE_PASSWORD_REQUIRED';
export const SYNC_E2EE_DOWNGRADE_REJECTED_CODE = 'E_SYNC_E2EE_DOWNGRADE_REJECTED';
/** 与 `src-tauri/src/cloud_storage/e2ee_claim.rs` 同名常量对齐。 */
export const SYNC_E2EE_CLAIM_CONFLICT_CODE = 'E_SYNC_E2EE_CLAIM_CONFLICT';

/** 各类错误对应的 i18n key（zh/en 均在 cloudStorage.json 的 errors 下）。 */
export const SYNC_E2EE_ERROR_I18N_KEYS = {
  plaintextLegacyRejected: 'cloudStorage:errors.e2eePlaintextLegacyRejected',
  wrongPassword: 'cloudStorage:errors.e2eeWrongPassword',
  markerCorrupted: 'cloudStorage:errors.e2eeMarkerCorrupted',
  passwordRequired: 'cloudStorage:errors.e2eePasswordRequired',
  downgradeRejected: 'cloudStorage:errors.e2eeDowngradeRejected',
  claimConflict: 'cloudStorage:errors.e2eeClaimConflict',
} as const;

const CODE_KINDS: readonly { code: string; kind: SyncE2eeErrorKind }[] = [
  // 标记损坏文案里也含“密码”“损坏”，code 与正则都先判这一类。
  { code: SYNC_E2EE_MARKER_CORRUPTED_CODE, kind: 'markerCorrupted' },
  { code: SYNC_E2EE_WRONG_PASSWORD_CODE, kind: 'wrongPassword' },
  {
    code: SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
    kind: 'plaintextLegacyRejected',
  },
  { code: SYNC_E2EE_PASSWORD_REQUIRED_CODE, kind: 'passwordRequired' },
  { code: SYNC_E2EE_DOWNGRADE_REJECTED_CODE, kind: 'downgradeRejected' },
  { code: SYNC_E2EE_CLAIM_CONFLICT_CODE, kind: 'claimConflict' },
];

interface SyncE2eeErrorMatcher {
  kind: SyncE2eeErrorKind;
  patterns: readonly RegExp[];
}

/**
 * 顺序重要：标记损坏的后端文案里也含“密码”“损坏”等字样
 * （如“无法确认加密密码与既有备份一致”），必须先于错密码类判定。
 */
const MATCHERS: readonly SyncE2eeErrorMatcher[] = [
  {
    kind: 'markerCorrupted',
    patterns: [
      // sync_manager.rs：“云端加密标记（.encryption-marker）内容已损坏…”
      /encryption-marker[^]{0,40}损坏/,
      // sync_manager.rs：“…版本为 N 却缺少密码校验子，疑似损坏或被篡改…”
      /缺少密码校验子/,
      // sync_manager.rs：“无法校验云端加密标记的密码校验子（fail-closed…”
      /无法校验云端加密标记/,
    ],
  },
  {
    // 防降级文案含“明文替换”，须先于 plaintextLegacyRejected 判定。
    kind: 'downgradeRejected',
    patterns: [
      // cloud_storage/mod.rs ensure_download_not_degraded：“…疑似密文被明文替换（降级攻击）…”
      /疑似密文被明文替换/,
    ],
  },
  {
    kind: 'claimConflict',
    patterns: [
      // e2ee_claim.rs claim_conflict 系列 / sync_manager.rs 发布前复验：
      // “…（认领竞态或标记被并发改动）…”“…认领租约…”“认领对象 … 超过 … 上限”
      /认领/,
    ],
  },
  {
    kind: 'wrongPassword',
    patterns: [
      // sync_manager.rs：“加密密码与该云端目录既有加密备份使用的密码不一致…”
      // sync/mod.rs：“解密 … 失败（密码不一致或数据损坏）”
      /密码不一致/,
      // backup_crypto.rs / sync/mod.rs：“…失败（密码错误或数据损坏）”
      // cloud_sync_download：“解密备份失败（密码错或数据损坏）”
      /密码错(误)?或数据损坏/,
    ],
  },
  {
    kind: 'plaintextLegacyRejected',
    patterns: [
      // sync/mod.rs decode_payload：“…缺少 DSBK 加密头（明文数据）…”
      /缺少\s*DSBK\s*加密头/,
      // sync/mod.rs download_file_object：“…明文对象（缺少 cipher_sha256）…”
      /缺少\s*cipher_sha256/,
      // sync/mod.rs blob 下载：“…（明文遗留对象，本端已启用端到端加密）…”
      /明文遗留对象/,
      // sync_manager.rs：“…为避免明文/密文混布，已拒绝未加密上传…”
      /已拒绝未加密上传/,
      // sync_manager.rs 本机「曾加密」记忆：标记已缺失仍拒明文上传
      /本机记录显示该云端目录曾启用/,
      // sync/mod.rs：有加密标记却未配置密码，拒文件级明文上传
      /已拒绝文件级明文上传/,
    ],
  },
  {
    kind: 'passwordRequired',
    patterns: [
      // decode_payload / download_file_object / autosync 半配置
      /未配置加密密码/,
      // cloud_sync_download：整包已加密但本机没给密码
      /未提供解密密码/,
    ],
  },
];

export function classifySyncE2eeErrorCode(
  code: string | undefined | null,
): SyncE2eeErrorKind | null {
  if (!code) return null;
  for (const { code: expected, kind } of CODE_KINDS) {
    if (code === expected || code.includes(expected)) return kind;
  }
  return null;
}

/**
 * 把后端错误原文归类为四类 E2EE 失败之一；无法归类返回 null（调用方回退原文）。
 * 稳定 code 优先；旧中文诊断走正则兜底。
 */
export function classifySyncE2eeError(raw: string): SyncE2eeErrorKind | null {
  const fromCode = classifySyncE2eeErrorCode(raw);
  if (fromCode) return fromCode;
  for (const { kind, patterns } of MATCHERS) {
    if (patterns.some((pattern) => pattern.test(raw))) {
      return kind;
    }
  }
  return null;
}
