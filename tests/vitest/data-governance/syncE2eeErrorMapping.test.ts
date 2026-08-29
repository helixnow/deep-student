/**
 * [R09-e2ee] 云同步 E2EE 错误人话映射契约。
 *
 * 1. 分类器必须能命中 src-tauri 侧的真实错误文案（下方样本逐字取自 Rust 源码，
 *    后端改文案时本测试会失败，提醒同步更新映射）；
 * 2. 三个 i18n key 必须在 zh/en 两个 locale 中都存在；
 * 3. SyncTab / CloudStorageSection 必须实际接入分类器（否则映射形同虚设）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifySyncE2eeError,
  SYNC_E2EE_CLAIM_CONFLICT_CODE,
  SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
  SYNC_E2EE_ERROR_I18N_KEYS,
  SYNC_E2EE_MARKER_CORRUPTED_CODE,
  SYNC_E2EE_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
} from '@/features/settings/components/data-governance/syncE2eeErrorMapping';

// ---------------------------------------------------------------------------
// 后端真实错误文案样本（逐字摘自 src-tauri 源码）
// ---------------------------------------------------------------------------

/** sync/mod.rs `decode_payload`：本端启用加密但云端 payload 是明文 */
const PLAINTEXT_PAYLOAD_ERROR =
  '本机已启用同步加密，但云端 payload 缺少 DSBK 加密头（明文数据）。' +
  '为防止端到端加密被静默降级，已拒绝读取该数据。';

/** sync/mod.rs `download_file_object`：明文遗留文件级对象被拒收 */
const PLAINTEXT_FILE_OBJECT_ERROR =
  '工作区数据库 ws_x 的云端条目是启用加密前的明文对象（缺少 cipher_sha256），' +
  '本端已启用端到端加密，为防止密文被明文静默替换已拒绝下载。';

/** sync/mod.rs blob 下载：明文遗留 blob 被拒收（tracing::error 同款文案进入失败列表时的形态） */
const PLAINTEXT_BLOB_ERROR =
  'blob 下载被拒绝（明文遗留对象，本端已启用端到端加密）: abc123。';

/** sync_manager.rs `ensure_plaintext_upload_allowed`：有标记时拒绝明文上传 */
const PLAINTEXT_UPLOAD_BLOCKED_ERROR =
  '该云端目录已存在端到端加密备份，为避免明文/密文混布，已拒绝未加密上传。' +
  '请在云存储配置里填写相同的加密密码后重试。';

/** sync_manager.rs `verify_encryption_password_before_upload`：校验子不一致 */
const WRONG_PASSWORD_MARKER_ERROR =
  '加密密码与该云端目录既有加密备份使用的密码不一致，已在上传前中止，' +
  '未写入任何备份对象。请核对加密密码后重试，或改用新的云端目录。';

/** sync/mod.rs `decode_payload`：DSBK 解密失败 */
const WRONG_PASSWORD_PAYLOAD_ERROR =
  '解密 sync payload 失败（密码错误或数据损坏）: aead::Error';

/** sync/mod.rs `download_file_object`：文件级对象解密失败 */
const WRONG_PASSWORD_FILE_OBJECT_ERROR =
  '解密 工作区数据库 ws_x 失败（密码不一致或数据损坏）: 备份解密失败';

/** sync_manager.rs：标记内容损坏 fail-closed */
const MARKER_CORRUPTED_ERROR =
  '云端加密标记（.encryption-marker）内容已损坏，无法确认加密密码与既有备份' +
  '一致，已在上传前中止（fail-closed）。请人工检查该云端目录后重试。';

/** sync_manager.rs：v2 标记缺校验子 */
const MARKER_MISSING_VERIFIER_ERROR =
  '云端加密标记版本为 2 却缺少密码校验子，疑似损坏或被篡改，已在上传前中止（fail-closed）。';

/** sync_manager.rs：未知 KDF 无法校验 */
const MARKER_UNKNOWN_KDF_ERROR =
  '无法校验云端加密标记的密码校验子（fail-closed，已在上传前中止）：未知的加密标记校验子 KDF: quantum。';

/** cloud_storage/mod.rs `ensure_download_not_degraded`：[R4-antidegrade] 下载防降级拒收 */
const DOWNGRADE_REJECTED_ERROR =
  '云端已登记端到端加密标记，但下载到的备份对象不是 DSBK 密文，疑似密文被明文替换' +
  '（降级攻击）或云端目录被篡改，已拒绝还原该对象。请人工核查云端目录完整性后重试。';

/** sync_manager.rs `ensure_marker_unchanged_before_publish`：[R4-e2ee-cas] 发布前复验冲突 */
const CLAIM_CONFLICT_PUBLISH_ERROR =
  '发布备份前复验发现云端加密标记已与上传前校验时不一致（认领竞态或标记被并发' +
  '改动），已回滚本次上传、未发布任何版本。请重试上传以重新校验加密密码。';

describe('classifySyncE2eeError', () => {
  it('classifies plaintext-legacy rejections (payload / file object / blob / upload)', () => {
    expect(classifySyncE2eeError(PLAINTEXT_PAYLOAD_ERROR)).toBe(
      'plaintextLegacyRejected',
    );
    expect(classifySyncE2eeError(PLAINTEXT_FILE_OBJECT_ERROR)).toBe(
      'plaintextLegacyRejected',
    );
    expect(classifySyncE2eeError(PLAINTEXT_BLOB_ERROR)).toBe(
      'plaintextLegacyRejected',
    );
    expect(classifySyncE2eeError(PLAINTEXT_UPLOAD_BLOCKED_ERROR)).toBe(
      'plaintextLegacyRejected',
    );
  });

  it('classifies wrong-password failures (marker verifier / payload / file object)', () => {
    expect(classifySyncE2eeError(WRONG_PASSWORD_MARKER_ERROR)).toBe(
      'wrongPassword',
    );
    expect(classifySyncE2eeError(WRONG_PASSWORD_PAYLOAD_ERROR)).toBe(
      'wrongPassword',
    );
    expect(classifySyncE2eeError(WRONG_PASSWORD_FILE_OBJECT_ERROR)).toBe(
      'wrongPassword',
    );
  });

  it('classifies corrupted-marker failures ahead of the wrong-password bucket', () => {
    expect(classifySyncE2eeError(MARKER_CORRUPTED_ERROR)).toBe(
      'markerCorrupted',
    );
    expect(classifySyncE2eeError(MARKER_MISSING_VERIFIER_ERROR)).toBe(
      'markerCorrupted',
    );
    expect(classifySyncE2eeError(MARKER_UNKNOWN_KDF_ERROR)).toBe(
      'markerCorrupted',
    );
  });

  it('classifies R4 anti-downgrade rejections ahead of the plaintext-legacy bucket', () => {
    expect(classifySyncE2eeError(DOWNGRADE_REJECTED_ERROR)).toBe(
      'downgradeRejected',
    );
  });

  it('classifies R4 claim-lease conflicts', () => {
    expect(classifySyncE2eeError(CLAIM_CONFLICT_PUBLISH_ERROR)).toBe(
      'claimConflict',
    );
  });

  it('returns null for unrelated errors (falls back to the raw message)', () => {
    expect(classifySyncE2eeError('网络错误: connection refused')).toBeNull();
    expect(classifySyncE2eeError('manifest 损坏: unexpected EOF')).toBeNull();
    expect(classifySyncE2eeError('磁盘空间不足')).toBeNull();
    expect(classifySyncE2eeError('')).toBeNull();
  });

  it('classifies missing-password refusals (payload / file object / zip download)', () => {
    expect(
      classifySyncE2eeError(
        '检测到加密的 sync payload 但本端未配置加密密码。请在云同步设置里填入正确的密码后重试。',
      ),
    ).toBe('passwordRequired');
    expect(
      classifySyncE2eeError(
        '工作区数据库 ws_x 的云端对象已端到端加密（存在 cipher_sha256），但本端未配置加密密码，无法解密。',
      ),
    ).toBe('passwordRequired');
    expect(
      classifySyncE2eeError(
        '云端备份已加密，但未提供解密密码。请在云存储配置里填写相同的加密密码后重试。',
      ),
    ).toBe('passwordRequired');
  });

  it('classifies rewritten messages by stable code', () => {
    expect(
      classifySyncE2eeError(
        `[${SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE}] rewritten plaintext`,
      ),
    ).toBe('plaintextLegacyRejected');
    expect(
      classifySyncE2eeError(`[${SYNC_E2EE_WRONG_PASSWORD_CODE}] rewritten password`),
    ).toBe('wrongPassword');
    expect(
      classifySyncE2eeError(`[${SYNC_E2EE_MARKER_CORRUPTED_CODE}] rewritten marker`),
    ).toBe('markerCorrupted');
    expect(
      classifySyncE2eeError(
        `[${SYNC_E2EE_PASSWORD_REQUIRED_CODE}] rewritten missing password`,
      ),
    ).toBe('passwordRequired');
    expect(
      classifySyncE2eeError(
        `[${SYNC_E2EE_DOWNGRADE_REJECTED_CODE}] rewritten downgrade`,
      ),
    ).toBe('downgradeRejected');
    expect(
      classifySyncE2eeError(`[${SYNC_E2EE_CLAIM_CONFLICT_CODE}] rewritten claim`),
    ).toBe('claimConflict');
  });

  it('prefers marker-corrupted code when a rewritten message also looks like a password error', () => {
    expect(
      classifySyncE2eeError(
        `[${SYNC_E2EE_MARKER_CORRUPTED_CODE}] 密码不一致且密码错误或数据损坏`,
      ),
    ).toBe('markerCorrupted');
  });
});

describe('E2EE 稳定 code 跨层契约', () => {
  it('Rust 与 TypeScript 使用同一组 code', () => {
    const rust = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/cloud_storage/mod.rs'),
      'utf8',
    );
    const rustClaim = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/cloud_storage/e2ee_claim.rs'),
      'utf8',
    );
    const api = readFileSync(
      resolve(process.cwd(), 'src/utils/cloudStorageApi.ts'),
      'utf8',
    );
    for (const code of [
      SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
      SYNC_E2EE_WRONG_PASSWORD_CODE,
      SYNC_E2EE_MARKER_CORRUPTED_CODE,
      SYNC_E2EE_PASSWORD_REQUIRED_CODE,
      SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
    ]) {
      expect(rust).toContain(`"${code}"`);
      expect(api).toContain(`'${code}'`);
    }
    expect(rustClaim).toContain(`"${SYNC_E2EE_CLAIM_CONFLICT_CODE}"`);
    expect(api).toContain(`'${SYNC_E2EE_CLAIM_CONFLICT_CODE}'`);
  });
});

describe('sync E2EE error i18n keys', () => {
  const kinds = Object.keys(SYNC_E2EE_ERROR_I18N_KEYS) as Array<
    keyof typeof SYNC_E2EE_ERROR_I18N_KEYS
  >;

  it.each(['zh-CN', 'en-US'] as const)(
    'defines all mapped keys in %s cloudStorage.json',
    (locale) => {
      const json = JSON.parse(
        readFileSync(
          resolve(process.cwd(), `src/locales/${locale}/cloudStorage.json`),
          'utf8',
        ),
      ) as { errors?: Record<string, string> };
      for (const kind of kinds) {
        const key = SYNC_E2EE_ERROR_I18N_KEYS[kind];
        const suffix = key.replace('cloudStorage:errors.', '');
        expect(
          json.errors?.[suffix],
          `${locale} 缺少 errors.${suffix}`,
        ).toBeTruthy();
      }
    },
  );
});

describe('display-layer wiring (source contract)', () => {
  const syncTab = readFileSync(
    resolve(
      process.cwd(),
      'src/features/settings/components/data-governance/SyncTab.tsx',
    ),
    'utf8',
  );
  const cloudSection = readFileSync(
    resolve(
      process.cwd(),
      'src/features/settings/components/CloudStorageSection.tsx',
    ),
    'utf8',
  );

  it('SyncTab classifies the sync error and renders the mapped message', () => {
    expect(syncTab).toContain('classifySyncE2eeError');
    expect(syncTab).toContain('SYNC_E2EE_ERROR_I18N_KEYS');
    // 原文必须仍然可见（排查/搜索用），不能被人话完全吞掉
    expect(syncTab).toMatch(/syncErrorE2eeKind\s*&&/);
  });

  it('CloudStorageSection routes cloud errors through the classifier', () => {
    expect(cloudSection).toContain('localizeCloudStorageError');
    const shared = readFileSync(
      resolve(
        process.cwd(),
        'src/features/settings/components/data-governance/localizeCloudError.ts',
      ),
      'utf8',
    );
    expect(shared).toContain('classifySyncE2eeError');
    expect(shared).toContain('SYNC_E2EE_ERROR_I18N_KEYS');
  });
});
