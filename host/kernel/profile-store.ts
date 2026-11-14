/**
 * 用户 profile 的可信写入口（插件管理命令用）：带修订号（文件字节的 SHA256）的读-改-写，
 * 只动被请求的条目，保留其它条目、`extends` 与注释键（`$schema` / `$comment`）。
 *
 * 为什么需要修订号：W35 的配置/启停界面与安装流程都会写同一个 `<dataDir>/plugins/user.profile.json`，
 * 界面上读到的内容可能已经过期。保存时提交读到的 revision，与当前文件不一致即以 PROFILE_CONFLICT 拒绝，
 * 不覆盖别人（或另一个窗口）刚写入的条目。
 *
 * 原子性：同目录临时文件 + fsync + rename；写失败保留原文件。同一进程内的写入按解析后的路径串行。
 * 位置与格式由 `profile.ts` 决定（`extends: "official"`、条目字段），本模块不另写一份 schema。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateProfileFile, type ProfileEntry, type ProfileFile } from './profile.ts';

/** 用户 profile 不存在时的修订号（首次写入的 CAS 期望值）。 */
export const ABSENT_PROFILE_REVISION = 'no-user-profile';

export class ProfileConflictError extends Error {
  override name = 'ProfileConflictError';
  /** 调用方提交的修订号。 */
  readonly expected: string;
  /** 文件当前修订号。 */
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`PROFILE_CONFLICT: profile changed since revision ${JSON.stringify(expected)} (current ${JSON.stringify(actual)})`);
    this.expected = expected;
    this.actual = actual;
  }
}

export class ProfileStoreError extends Error {
  override name = 'ProfileStoreError';
}

export interface ProfileDocument {
  /** 磁盘上的原始 JSON；文件不存在时为 `null`。 */
  readonly text: string | null;
  /** 解析并校验后的 profile；文件不存在时为 `{ extends: 'official', plugins: [] }`（内存值，不落盘）。 */
  readonly file: ProfileFile;
  readonly revision: string;
  readonly exists: boolean;
}

/** 文件字节的 SHA256（十六进制）；缺失文件用 {@link ABSENT_PROFILE_REVISION}。 */
export function profileRevision(text: string | null): string {
  return text === null ? ABSENT_PROFILE_REVISION : createHash('sha256').update(text).digest('hex');
}

const writes = new Map<string, Promise<unknown>>();

export class UserProfileStore {
  readonly path: string;
  /** `extends: "official"` 的目标（诊断用；实际解析由 profile.ts 完成）。 */
  readonly official: string;

  constructor(path: string, official: string) {
    this.path = resolve(path);
    this.official = official;
  }

  async read(): Promise<ProfileDocument> {
    let text: string | null;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { text: null, file: { extends: 'official', plugins: [] }, revision: ABSENT_PROFILE_REVISION, exists: false };
      }
      throw new ProfileStoreError(`cannot read user profile ${this.path}: ${(error as Error).message}`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProfileStoreError(`user profile ${this.path} is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
    return { text, file: validateProfileFile(parsed, this.path), revision: profileRevision(text), exists: true };
  }

  /**
   * 读-改-写：`change` 收到当前文件的深拷贝并可原地修改；返回它的结果。
   * 期望修订号与磁盘不一致时抛 {@link ProfileConflictError}，不写文件。
   */
  async mutate<T>(expectedRevision: string, change: (file: ProfileFile) => T): Promise<{ revision: string; value: T }> {
    const step = async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new ProfileConflictError(expectedRevision, current.revision);
      const file = structuredClone(current.file) as ProfileFile;
      const value = change(file);
      const validated = validateProfileFile(file, this.path);
      const text = `${JSON.stringify(validated, null, 2)}\n`;
      await this.write(text);
      return { revision: profileRevision(text), value };
    };
    // Run after the previous write settles, whether it succeeded or failed.
    const pending = (writes.get(this.path) ?? Promise.resolve()).then(step, step);
    writes.set(this.path, pending);
    try {
      return await pending;
    } finally {
      if (writes.get(this.path) === pending) writes.delete(this.path);
    }
  }

  private async write(text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(text, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      throw new ProfileStoreError(`cannot write user profile ${this.path}: ${(error as Error).message}`, { cause: error });
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
}

/** 在文件里找同 id 条目（保留它的位置）；没有时 `-1`。 */
export function entryIndex(file: ProfileFile, id: string): number {
  return file.plugins.findIndex((entry) => entry.id === id);
}

/** 替换同 id 条目（保留位置）或追加到末尾；返回写入的条目。 */
export function writeEntry(file: ProfileFile, entry: ProfileEntry): ProfileEntry {
  const index = entryIndex(file, entry.id);
  if (index >= 0) file.plugins[index] = entry;
  else file.plugins.push(entry);
  return entry;
}

/** 删除同 id 的全部条目；返回被删除的条目数。 */
export function removeEntries(file: ProfileFile, id: string): number {
  const before = file.plugins.length;
  file.plugins = file.plugins.filter((entry) => entry.id !== id);
  return before - file.plugins.length;
}

/** 用户层里被 `disabled: true` 标记的插件 id。 */
export function disabledIds(file: ProfileFile): Set<string> {
  const ids = new Set<string>();
  for (const entry of file.plugins) if (entry.disabled === true) ids.add(entry.id);
  return ids;
}
