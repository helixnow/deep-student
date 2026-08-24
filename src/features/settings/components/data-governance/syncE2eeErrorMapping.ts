/**
 * [R09-e2ee] 云同步端到端加密错误的“人话”分类器。
 *
 * 后端（Rust）的 E2EE fail-closed 错误目前是中文长文案且无稳定错误码
 * （与 `localizeCloudError` 处理 Android FTP 文案的处境相同）。这里按
 * 已知文案片段把三类最需要用户理解的失败归类，展示层再映射为 i18n 人话：
 *
 * - `plaintextLegacyRejected`：启用加密后遇到明文遗留对象/清单被拒收
 *   （`decode_payload` 的“缺少 DSBK 加密头”、文件级对象的“缺少 cipher_sha256”）；
 * - `wrongPassword`：加密密码与云端既有数据不一致
 *   （标记校验子不一致、DSBK AEAD 解密失败）；
 * - `markerCorrupted`：云端 `.encryption-marker` 损坏/异常导致 fail-closed。
 *
 * 匹配片段与 src-tauri 侧错误文案的对应关系由
 * `tests/vitest/data-governance/syncE2eeErrorMapping.test.ts` 用后端原文钉死；
 * 后端引入稳定错误码后应改为按 code 匹配。
 */

export type SyncE2eeErrorKind =
  | 'plaintextLegacyRejected'
  | 'wrongPassword'
  | 'markerCorrupted';

/** 三类错误对应的 i18n key（zh/en 均在 cloudStorage.json 的 errors 下）。 */
export const SYNC_E2EE_ERROR_I18N_KEYS = {
  plaintextLegacyRejected: 'cloudStorage:errors.e2eePlaintextLegacyRejected',
  wrongPassword: 'cloudStorage:errors.e2eeWrongPassword',
  markerCorrupted: 'cloudStorage:errors.e2eeMarkerCorrupted',
} as const;

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
    kind: 'wrongPassword',
    patterns: [
      // sync_manager.rs：“加密密码与该云端目录既有加密备份使用的密码不一致…”
      // sync/mod.rs：“解密 … 失败（密码不一致或数据损坏）”
      /密码不一致/,
      // backup_crypto.rs / sync/mod.rs：“…失败（密码错误或数据损坏）”
      /密码错误或数据损坏/,
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
    ],
  },
];

/**
 * 把后端错误原文归类为三类 E2EE 失败之一；无法归类返回 null（调用方回退原文）。
 */
export function classifySyncE2eeError(raw: string): SyncE2eeErrorKind | null {
  for (const { kind, patterns } of MATCHERS) {
    if (patterns.some((pattern) => pattern.test(raw))) {
      return kind;
    }
  }
  return null;
}
