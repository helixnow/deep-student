/**
 * 本 lane 需要借用的其他插件能力（只经对方 api.ts）。
 *
 * qbank 只写自己的表；`exam_sheets` 属于 L11 vfs-repos、`resources.index_state` 属于
 * L13 vfs-index。这里保存对方 api.ts 的方法形状，接线时从 Cordis 服务取得实现。
 */
import type { Logger } from '../../../platform/log/api.ts';
import type { ExamRepository, QuestionRepository } from '../../vfs-repos/api.ts';
import type { VfsIndexingApi } from '../../vfs-index/api.ts';

export type QbankLogger = Pick<Logger, 'warn' | 'error' | 'debug'> & {
  /** 成功路径的诊断日志；测试替身可省略。 */
  readonly info?: Logger['info'];
};
export type ResourceIndexPort = Pick<VfsIndexingApi, 'markResourcePending'>;
export type ExamSheetsPort = Pick<ExamRepository,
  'getExamSheet' | 'getImportState' | 'updatePreviewJson' | 'updateImportState'
  | 'clearImportState' | 'updateStatus' | 'upsertExamSheet' | 'markQuestionDocumentCompleted'>;

export interface QbankPorts {
  readonly exams?: ExamSheetsPort;
  /** L11 的题目/历史/作答/统计唯一写入方；生产组合由 `vfsRepo.questions` 提供。 */
  readonly questions?: QuestionRepository;
  readonly indexing?: ResourceIndexPort;
  readonly log?: QbankLogger;
}

export function requireQuestions(ports: QbankPorts): QuestionRepository {
  if (ports.questions === undefined) {
    throw new Error('vfsRepo.questions is required: L11 owns question/history/submission/stats writes');
  }
  return ports.questions;
}
