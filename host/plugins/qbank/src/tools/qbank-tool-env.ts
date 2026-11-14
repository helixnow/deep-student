/** Per-call environment shared by the qbank tool bodies (Rust `&self` + `call` + `ctx`). */
import type { ExecutionContext, ToolCall } from '../../../chat/api.ts';
import type { DatabaseHandle } from '../../../../platform/storage/api.ts';
import type { VfsReposService } from '../../../vfs-repos/api.ts';
import type { AuthoringHost } from '../authoring-service.ts';
import type { CryptoService } from '../../../../platform/crypto/api.ts';
import type { FilesService } from '../../../../platform/files/api.ts';
import type { NativeOfficeWriter } from '../../../../platform/native/office/api.ts';
import type { ExportHost } from '../export-service.ts';
import type { GenerationCommandHost } from '../generation-command.ts';
import type { PracticeServiceHost } from '../practice-service.ts';
import type { ImportServiceHost } from '../question-import-service.ts';
import type { DocsService } from '../../../media/api.ts';
import type { NoteRepository } from '../../../notes/api.ts';
import type { VfsRefTextService } from '../../../vfs-handlers/api.ts';
import type { ManagementHost } from '../management-service.ts';
import type { QuestionServiceHost } from '../question-service.ts';
import type { StatisticsServiceHost } from '../statistics-service.ts';
import type { GeneratedPaper, QbankGradingRequest, QbankGradingResponse } from '../../api.ts';
import { qbankFailure, type Args } from './qbank-tool-args.ts';
import type { ToolLog, WriteLock } from './tool-execution.ts';

export const QBANK_CHANGED_EVENT = 'qbank://changed';

export interface QbankToolDeps {
  /** L11 repositories; `null` ⇔ Rust `ctx.vfs_db == None` (nothing to read the VFS through). */
  repos(): VfsReposService | null;
  db(): DatabaseHandle;
  questionHost(): QuestionServiceHost;
  statisticsHost(): StatisticsServiceHost;
  managementHost(): ManagementHost;
  authoringHost(): AuthoringHost;
  /** `run_qbank_grading` + `llm.request_cancel_stream`; `null` ⇔ Rust `ctx.llm_manager == None`. */
  aiGrading(): QbankAiGrading | null;
  /** Background generation host; `null` ⇔ Rust `ctx.llm_manager == None`. */
  generation(): GenerationCommandHost | null;
  practiceHost(): Promise<PracticeServiceHost>;
  /** `qbank_practice::export_bridge::export_for_tool` (frontend renders, host writes the file). */
  exportPaper(paper: GeneratedPaper, format: string, includeAnswers: boolean, includeExplanations: boolean):
    Promise<{ ok: true; value: string } | { ok: false; error: string }>;
  exportHost(): ExportHost;
  /** App data dir (`app_handle().path().app_data_dir()`). */
  exportDir(): string;
  /** `ctx.files`（桌面）；`null` 时文件导出失败。 */
  files(): FilesService | null;
  /** `ctx.crypto`. */
  crypto(): CryptoService;
  /** F7 `DocumentParser::generate_docx_from_spec`. */
  officeWriter(): NativeOfficeWriter | null;
  /** `QuestionImportService`; `null` ⇔ Rust `ctx.llm_manager == None`. */
  documentImport(): ImportServiceHost | null;
  /** `<active>/vfs_blobs`. */
  blobsDir(): string;
  /** L18 `docs` (`DocumentProcessingExecutor::resolve_file`). */
  docs(): Pick<DocsService, 'resolveFile'> | null;
  /** L10 note repository. */
  notes(): Pick<NoteRepository, 'getNote' | 'getNoteContent'> | null;
  /** `ref_handlers::extract_file_text_with_strategy`. */
  refText(): VfsRefTextService | null;
  /** `PdfProcessingService::is_running`; `false` when the service is absent. */
  isParseRunning(fileId: string): boolean;
  /** Tauri `Emitter::emit` (broadcast). */
  emit(event: string, payload: unknown): void;
  log: ToolLog;
}

export interface QbankAiGrading {
  run(request: QbankGradingRequest): Promise<QbankGradingResponse | null>;
  cancelStream(streamEvent: string): Promise<void>;
}

export class QbankToolEnv {
  readonly deps: QbankToolDeps;
  readonly ctx: ExecutionContext;
  readonly call: ToolCall;
  readonly args: Args;
  readonly toolName: string;
  readonly lock: WriteLock;

  constructor(deps: QbankToolDeps, ctx: ExecutionContext, call: ToolCall, args: Args, toolName: string,
    lock: WriteLock) {
    this.deps = deps; this.ctx = ctx; this.call = call; this.args = args; this.toolName = toolName; this.lock = lock;
  }

  /** `ctx.vfs_db.as_ref().ok_or("VFS database not available")`. */
  vfs(): { db: DatabaseHandle; repos: VfsReposService } {
    const repos = this.deps.repos();
    if (repos === null) throw new Error('VFS database not available');
    return { db: this.deps.db(), repos };
  }

  /** `ctx.services.get::<QuestionBankService>()`. */
  service(): QuestionServiceHost | null {
    return this.deps.repos() === null ? null : this.deps.questionHost();
  }

  /** qbank_executor.rs:1505 `require_service`. */
  requireService(): QuestionServiceHost {
    const service = this.service();
    if (service === null) {
      throw qbankFailure('QBANK_SERVICE_UNAVAILABLE', 'QuestionBankService 未初始化且 VFS 数据库不可用', '重新打开应用后重试');
    }
    return service;
  }

  /** qbank_executor.rs:1423 `emit_qbank_changed`: skipped without a window, failures only logged. */
  emitChanged(action: string, entityIds: readonly string[]): void {
    if (this.ctx.tryWindow() === null) return;
    try {
      this.deps.emit(QBANK_CHANGED_EVENT, { source: 'agent', action, entityIds: [...entityIds], runId: this.ctx.runId() });
    } catch (error) {
      this.deps.log.debug(`[QBankExecutor] Failed to emit qbank://changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
