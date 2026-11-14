/** 测试宿主提供 qbank 依赖的 L11/L13 仓储实现（真实实现，非替身）。 */
import type { DatabaseHandle } from '../../../../platform/storage/api.ts';
import type { QbankPorts } from '../../src/ports.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11/L13 的真实仓储实现，避免在 qbank 测试里复制对方 SQL
import { ExamRepo } from '../../../vfs-repos/repository/exams.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11 真实的题目仓储（D1 唯一写入方）
import { QuestionRepo } from '../../../vfs-repos/repository/questions.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L13 的真实索引状态写入，验证 qbank 只经其 api 触发失效
import { markPending } from '../../../vfs-index/repository/index-state.ts';
// boundary-allow cross-plugin-impl: 测试宿主使用 L11 真实的 blobs/files 仓储（便携包导入资产写入方）
import { BlobRepo } from '../../../vfs-repos/repository/blobs.ts';
// boundary-allow cross-plugin-impl: 同上，files 表唯一写入方
import { FileRepo } from '../../../vfs-repos/repository/files.ts';

export function vfsTestAssetRepos(): { blobs: BlobRepo; files: FileRepo } {
  return { blobs: new BlobRepo(), files: new FileRepo() };
}

export function vfsTestPorts(db: DatabaseHandle): QbankPorts {
  return {
    exams: new ExamRepo(),
    questions: new QuestionRepo(),
    indexing: { markResourcePending: (resourceId: string) => markPending(db, resourceId) },
  };
}

export function vfsTestServices(db: DatabaseHandle): Record<string, unknown> {
  return {
    vfsRepo: { exams: new ExamRepo(), questions: new QuestionRepo() },
    vfsIndex: { indexing: { markResourcePending: (resourceId: string) => markPending(db, resourceId) } },
  };
}
