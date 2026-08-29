import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * [R09-restore-ops] RESTORE-MATRIX-R07 运维缺口收口的锁定测试。
 *
 * 锁定三件事（都是"删掉也不会有编译错误、但会静默退化"的契约）：
 * - P2-1：用户指南 16 必须写明旧 .encryption-marker 被错密码设备
 *   抢先升级后的解锁步骤（人工删除/重写云端标记）；
 * - P2-2：云端 ZIP 下载断点续传——trait 默认实现 fail-closed、WebDAV
 *   声明支持、编排层保留断点并做整文件 SHA256 兜底；
 * - P3：加密全保真 ZIP 无密码导入必须在解压任何条目之前早失败
 *   （续传与非续传共用同一预检）。
 */

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('P2-1: user guide 16 documents the wrong-password marker takeover unlock', () => {
  const guide = read('docs/user-guide/16-数据管理与云同步.md');

  it('explains the takeover scenario for legacy markers without a verifier', () => {
    expect(guide).toContain('.encryption-marker');
    expect(guide).toContain('抢先');
    expect(guide).toContain('加密密码与该云端目录既有加密备份使用的密码不一致');
    // 恢复不受标记影响，是"先自证密码正确"步骤的前提，必须写明。
    expect(guide).toMatch(/下载与恢复不受标记影响|下载恢复不受影响/);
  });

  it('gives the concrete unlock steps: self-verify, delete marker, re-register, fix the bad device', () => {
    expect(guide).toContain('先自证密码正确');
    expect(guide).toContain('删除云端标记');
    expect(guide).toMatch(/删除根目录下的 `\.encryption-marker`/);
    // 只删标记这一个文件，绝不能引导用户去动备份对象。
    expect(guide).toMatch(/不要.*碰.*`backups\/`/);
    expect(guide).toContain('用正确密码重新登记');
    expect(guide).toContain('纠正配错密码的设备');
  });

  it('has an FAQ entry routing the exact error message to the unlock section', () => {
    expect(guide).toContain(
      '上传时提示「加密密码与该云端目录既有加密备份使用的密码不一致」',
    );
  });
});

describe('P2-2: resumable cloud ZIP download stays honest', () => {
  const traits = read('src-tauri/src/cloud_storage/traits.rs');
  const webdav = read('src-tauri/src/cloud_storage/webdav.rs');
  const s3 = read('src-tauri/src/cloud_storage/s3.rs');
  const syncManager = read('src-tauri/src/cloud_storage/sync_manager.rs');
  const repoCheck = read('src-tauri/src/cloud_storage/repo_check.rs');
  const resume = read('src-tauri/src/cloud_storage/resume.rs');
  const syncMod = read('src-tauri/src/data_governance/sync/mod.rs');
  const guide = read('docs/user-guide/16-数据管理与云同步.md');

  it('keeps the fail-closed default for providers without resume support', () => {
    expect(traits).toContain('RESUMABLE_DOWNLOAD_UNSUPPORTED');
    expect(traits).toContain('该云存储后端不支持断点续传下载（fail-closed）');
    expect(traits).toMatch(/fn supports_resumable_download\(&self\) -> bool \{\s*false\s*\}/);
  });

  it('WebDAV advertises resume support and refuses misaligned Content-Range', () => {
    expect(webdav).toMatch(/fn supports_resumable_download\(&self\) -> bool \{\s*true\s*\}/);
    expect(webdav).toContain('续传起点与请求不一致');
    // 服务端忽略 Range（HTTP 200）必须诚实从零重下，不冒充续传。
    expect(webdav).toContain('StatusCode::OK => 0');
    // 字节数不足即失败，禁止静默截断当成功。
    expect(webdav).toContain('written != total_size');
    expect(webdav).toContain('ensure_memory_get_matches_declared_len("WebDAV"');
    expect(webdav).toContain('WebDAV 内存对象下载停滞超过 90 秒');
  });

  it('desktop S3 advertises Range resume and refuses misaligned Content-Range', () => {
    expect(s3).toMatch(/fn supports_resumable_download\(&self\) -> bool \{\s*true\s*\}/);
    expect(s3).toContain('request.range(format!("bytes={resume_from}-"))');
    expect(s3).toContain('续传起点与请求不一致');
    expect(s3).toContain('written != total_size');
    expect(s3).toContain('upload_part_with_retry');
    expect(s3).toContain('ensure_memory_get_matches_declared_len("S3"');
    expect(s3).toContain('S3 内存对象下载停滞超过 90 秒');
    expect(s3).toContain('abort_stale_multipart_uploads');
    expect(s3).toContain('MULTIPART_STALE_SECS');
  });

  it('orchestration keeps the .part checkpoint and verifies the whole-file SHA256', () => {
    expect(syncManager).toContain('supports_resumable_download()');
    expect(syncManager).toMatch(/\.\{version_id\}\.zip\.part/);
    expect(syncManager).toContain('hash_file_sha256');
    expect(syncManager).toContain('SHA256 校验失败');
    // 失败保留断点是续传的前提：不能在错误路径清理 partial。
    expect(syncManager).toContain('失败时不清理断点文件');
  });

  it('repo check uses resumable download when the provider advertises it', () => {
    expect(repoCheck).toContain('download_object_for_check');
    expect(repoCheck).toContain('get_file_with_optional_resume');
    // 每个对象必须先清残留，续传路径会追加，复用同一 .partial 会串对象。
    expect(repoCheck).toContain('remove_file(&local_path)');
    expect(resume).toContain('get_file_resumable');
    expect(resume).toContain('RESUMABLE_GET_ATTEMPTS');
    expect(resume).toContain('dest_resume_len');
    expect(guide).toContain('巡检同一对象时支持**断点续传**');
    expect(guide).toContain('FTP 仍整包重下');
  });

  it('file-level objects resume beside dest, never appending onto the live file', () => {
    expect(syncMod).toContain('content_keyed_part_path');
    expect(syncMod).toContain('cleanup_stale_parts');
    expect(syncMod).toContain('.ds-dl.part');
    expect(syncMod).toContain('get_file_with_optional_resume');
    expect(syncMod).toContain('绝不能对已有 dest 追加');
    expect(syncMod).not.toContain('prefix("dsbk-dl-")');
    expect(resume).toContain('fn content_keyed_part_path');
    expect(guide).toContain('工作区 / blob / 资产');
    expect(guide).toContain('按内容哈希区分');
  });
});

describe('P3: encrypted ZIP import without password fails before extraction', () => {
  const zipExport = read('src-tauri/src/data_governance/backup/zip_export.rs');

  it('shares one precheck between the resumable and non-resumable paths', () => {
    expect(zipExport).toContain('fn precheck_sealed_payload_password');
    // 非续传公开入口 + 带进度实现各自都要调用预检。
    const calls = zipExport.match(/precheck_sealed_payload_password\(&mut archive/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the caller-visible error messages stable for both paths', () => {
    expect(zipExport).toContain(
      '这是加密全保真备份 ZIP：请提供导出时设置的备份密码后重试导入',
    );
    expect(zipExport).toContain(
      '这是加密全保真备份 ZIP：断点续传必须携带导出时设置的备份密码。请提供备份密码后重新恢复导入任务',
    );
  });
});
