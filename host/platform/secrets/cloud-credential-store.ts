import { JsonReader, rustTrim } from '../util/portable.ts';
import { CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE, SecureStoreError } from './errors.ts';
import type { CloudStorageCredentials, CloudStorageCredentialStatus } from './api.ts';

import {
  applyNonemptyUpdate,
  checkNewCloudEncryptionPassword,
  credentialStatus,
  hasAnySecret,
  parseStaged,
  parseU64,
  readCredentials,
  serializeCredentials,
  serializeStaged,
  U64_MAX,
  type StagedRecord,
} from './cloud-credentials.ts';

const CLOUD_STORAGE_KEY = 'cloud_storage_credentials';
const CLOUD_STORAGE_STAGED_KEY = 'cloud_storage_credentials_staged';
const CLOUD_STORAGE_GENERATION_KEY = 'cloud_storage_credentials_generation';

export abstract class CloudCredentialStore {
  abstract saveSecret(key: string, value: string): Promise<void>;
  abstract getSecret(key: string): Promise<string | null>;
  abstract deleteSecret(key: string): Promise<void>;
  protected abstract warnCloud(message: string): void;

  // ---------------- 云凭据

  async saveCloudCredentials(credentials: CloudStorageCredentials): Promise<void> {
    await this.saveSecret(CLOUD_STORAGE_KEY, JSON.stringify(serializeCredentials(credentials)));
  }

  async getCloudCredentials(): Promise<CloudStorageCredentials | null> {
    const json = await this.getSecret(CLOUD_STORAGE_KEY);
    if (json === null) return null;
    try {
      const r = new JsonReader(json);
      const credentials = readCredentials(r);
      r.end();
      return credentials;
    } catch (error) {
      throw new SecureStoreError('SerializationError', error instanceof Error ? error.message : String(error));
    }
  }

  async updateCloudCredentials(update: CloudStorageCredentials, encryptionPasswordIsPreexisting = false): Promise<CloudStorageCredentialStatus> {
    if (!encryptionPasswordIsPreexisting) checkNewCloudEncryptionPassword(update.encryptionPassword);
    const credentials = (await this.getCloudCredentials()) ?? {};
    applyNonemptyUpdate(credentials, update);
    if (hasAnySecret(credentials)) await this.saveCloudCredentials(credentials);
    else await this.deleteCloudCredentials();
    return credentialStatus(credentials);
  }

  async cloudCredentialStatus(): Promise<CloudStorageCredentialStatus> {
    return credentialStatus((await this.getCloudCredentials()) ?? {});
  }

  async clearCloudEncryptionPassword(): Promise<CloudStorageCredentialStatus> {
    const credentials = await this.getCloudCredentials();
    if (credentials === null) return credentialStatus({});
    delete credentials.encryptionPassword;
    if (hasAnySecret(credentials)) await this.saveCloudCredentials(credentials);
    else await this.deleteCloudCredentials();
    return credentialStatus(credentials);
  }

  deleteCloudCredentials(): Promise<void> {
    return this.deleteSecret(CLOUD_STORAGE_KEY);
  }

  async cloudCredentialsActiveGeneration(): Promise<bigint> {
    const raw = await this.getSecret(CLOUD_STORAGE_GENERATION_KEY);
    if (raw === null) return 0n;
    const v = parseU64(rustTrim(raw));
    if (typeof v === 'string') throw new SecureStoreError('SerializationError', `云凭据 generation pointer 内容非法: ${v}`);
    return v;
  }

  private async getStagedRecord(): Promise<StagedRecord | null> {
    const json = await this.getSecret(CLOUD_STORAGE_STAGED_KEY);
    if (json === null) return null;
    try {
      return parseStaged(json);
    } catch (error) {
      throw new SecureStoreError('SerializationError', `云凭据 staged 记录非法: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 测试/诊断用：读取 staged 记录（Rust `get_staged_cloud_credentials_record`）。 */
  getStagedCloudCredentialsRecord(): Promise<{ generation: bigint; credentials: CloudStorageCredentials } | null> {
    return this.getStagedRecord();
  }

  async writeStagedCloudCredentials(update: CloudStorageCredentials, encryptionPasswordIsPreexisting: boolean): Promise<bigint> {
    if (!encryptionPasswordIsPreexisting) checkNewCloudEncryptionPassword(update.encryptionPassword);
    const merged = (await this.getCloudCredentials()) ?? {};
    applyNonemptyUpdate(merged, update);
    const active = await this.cloudCredentialsActiveGeneration();
    if (active === U64_MAX) throw new SecureStoreError('Other', '云凭据 generation 溢出（u64::MAX）');
    const generation = active + 1n;
    await this.saveSecret(CLOUD_STORAGE_STAGED_KEY, serializeStaged({ generation, credentials: merged }));
    return generation;
  }

  async commitStagedCloudCredentials(expectedGeneration: bigint): Promise<void> {
    const active = await this.cloudCredentialsActiveGeneration();
    if (active === expectedGeneration) {
      const record = await this.getStagedRecord();
      if (record === null) return;
      if (record.generation === expectedGeneration) return this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
      throw new SecureStoreError(
        'CloudCredentialGenerationConflict',
        `[${CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE}] staged generation ${record.generation} 与已提交的 generation ${expectedGeneration} 不符，拒绝清理`,
      );
    }
    const staged = await this.getStagedRecord();
    if (staged === null) throw new SecureStoreError('KeyNotFound', `云凭据 staged 记录不存在，无法提交 generation ${expectedGeneration}`);
    if (staged.generation !== expectedGeneration || active === U64_MAX || active + 1n !== expectedGeneration) {
      throw new SecureStoreError(
        'CloudCredentialGenerationConflict',
        `[${CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE}] 期望提交 generation ${expectedGeneration}，但 active=${active}、staged=${staged.generation}；staged 基线已过期，请重读后重新 stage`,
      );
    }
    const previousActive = await this.getSecret(CLOUD_STORAGE_KEY);
    if (hasAnySecret(staged.credentials)) await this.saveCloudCredentials(staged.credentials);
    else await this.deleteSecret(CLOUD_STORAGE_KEY);
    try {
      await this.saveSecret(CLOUD_STORAGE_GENERATION_KEY, expectedGeneration.toString());
    } catch (error) {
      try {
        if (previousActive !== null) await this.saveSecret(CLOUD_STORAGE_KEY, previousActive);
        else await this.deleteSecret(CLOUD_STORAGE_KEY);
      } catch (restoreError) {
        this.warnCloud(
          `云凭据提交失败且回滚 active 也失败（staged 保留，可重放 commit 收敛）: pointer 错误=${String(error)}, 回滚错误=${String(restoreError)}`,
        );
      }
      throw error;
    }
    await this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
  }

  async abortStagedCloudCredentials(expectedGeneration: bigint): Promise<void> {
    const json = await this.getSecret(CLOUD_STORAGE_STAGED_KEY);
    if (json === null) return;
    let record: StagedRecord;
    try {
      record = parseStaged(json);
    } catch (parseError) {
      this.warnCloud(`清除无法解析的云凭据 staged 记录: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      return this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
    }
    if (record.generation === expectedGeneration) return this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
    throw new SecureStoreError(
      'CloudCredentialGenerationConflict',
      `[${CLOUD_CREDENTIALS_GENERATION_CONFLICT_CODE}] staged generation ${record.generation} 与期望 ${expectedGeneration} 不符，拒绝丢弃`,
    );
  }

  async deleteCloudCredentialsTransactional(): Promise<void> {
    const snapshotActive = await this.getSecret(CLOUD_STORAGE_KEY);
    const snapshotStaged = await this.getSecret(CLOUD_STORAGE_STAGED_KEY);
    const snapshotGeneration = await this.getSecret(CLOUD_STORAGE_GENERATION_KEY);
    try {
      await this.deleteSecret(CLOUD_STORAGE_STAGED_KEY);
      await this.deleteSecret(CLOUD_STORAGE_KEY);
      await this.deleteSecret(CLOUD_STORAGE_GENERATION_KEY);
    } catch (error) {
      for (const [key, snapshot] of [
        [CLOUD_STORAGE_KEY, snapshotActive],
        [CLOUD_STORAGE_STAGED_KEY, snapshotStaged],
        [CLOUD_STORAGE_GENERATION_KEY, snapshotGeneration],
      ] as const) {
        if (snapshot === null) continue;
        try {
          await this.saveSecret(key, snapshot);
        } catch (restoreError) {
          this.warnCloud(`事务化删除失败后写回快照 ${key} 也失败: ${String(restoreError)}`);
        }
      }
      throw error;
    }
  }
}
