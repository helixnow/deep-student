/**
 * `src/chat_v2/tools/document_processing_executor.rs`: `document_parse` starts the
 * VFS PDF/image processing pipeline in the background and returns immediately;
 * `document_parse_status` reports stage, progress and text availability.
 */
import type { ToolCall, ToolResultInfo } from '../../../chat/api.ts';
import type { PdfProcessingService } from '../../../vfs-index/api.ts';
import {
  canHandle, checkMediaSupported, parseStage, resolveFile, sensitivityLevel, stripToolNamespace,
} from '../document-processing.ts';
import {
  argumentsOf, errorText, requiredStringArg, runToolCall, type MediaToolContext, type ToolLogger,
} from './runtime.ts';

const NAME = 'DocumentProcessingExecutor';
const MISSING_RESOURCE = "Missing 'resource_id' parameter（file_* 或 res_* 开头的文件类资源 ID）";
const TERMINAL_STAGES = ['completed', 'completed_with_issues', 'error'];

export interface DocumentProcessingDeps {
  /** `ctx.pdf_processing_service`（vfs-index `vfsIndex.pdf`）。 */
  pdf(): PdfProcessingService | null;
  log: ToolLogger & { error(message: string): void };
}

/** i64 millisecond columns may arrive as bigint from safe-integer reads. */
function millis(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

export class DocumentProcessingExecutor {
  private readonly deps: DocumentProcessingDeps;

  constructor(deps: DocumentProcessingDeps) { this.deps = deps; }

  name(): string { return NAME; }

  canHandle(toolName: string): boolean { return canHandle(toolName); }

  sensitivityLevel(toolName: string): 'low' | 'medium' { return sensitivityLevel(toolName); }

  async execute(call: ToolCall, context: MediaToolContext): Promise<ToolResultInfo> {
    const toolName = stripToolNamespace(call.name);
    this.deps.log.debug(`[${NAME}] Executing tool: ${toolName}`);
    const result = await runToolCall(NAME, call, context, this.deps.log, async () => {
      const args = argumentsOf(call.arguments);
      switch (toolName) {
        case 'document_parse': return this.parse(args, context);
        case 'document_parse_status': return this.status(args, context);
        default: throw new Error(`Unknown document tool: ${toolName}`);
      }
    });
    if (!result.success) this.deps.log.error(`[${NAME}] Tool ${toolName} failed: ${result.error ?? ''}`);
    return result;
  }

  private dependencies(args: Record<string, unknown>, context: MediaToolContext) {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const database = context.vfs_db;
    if (database === null) throw new Error('VFS database not available');
    const service = this.deps.pdf();
    if (service === null) throw new Error('PDF processing service not available');
    return { file: resolveFile(database, resourceId), service };
  }

  private async parse(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const { file, service } = this.dependencies(args, context);
    checkMediaSupported(file);
    if (service.isRunning(file.id)) {
      let stage: string | null = null;
      try { stage = service.getStatus(file.id)?.stage ?? null; }
      catch { stage = null; }
      return {
        status: 'already_running',
        file_id: file.id,
        file_name: file.fileName,
        current_stage: stage,
        message: '该文件的解析管线已在运行中，无需重复发起',
        hint: '用 document_parse_status 轮询进度。',
      };
    }
    const startStage = parseStage(args);
    try { await service.startPipeline(file.id, startStage); }
    catch (error) { throw new Error(`发起解析管线失败: ${errorText(error)}`); }
    return {
      status: 'started',
      file_id: file.id,
      resource_id: file.resourceId,
      file_name: file.fileName,
      mime_type: file.mimeType,
      page_count: file.pageCount,
      message: '解析/OCR 管线已在后台启动',
      hint: 'OCR 可能需要数分钟，请稍后用 document_parse_status 轮询。完成后可用 resource_read 读取全文。'
        + '导入题库无需等待 OCR：直接用同一 resource_id 调用 qbank_import_document。',
    };
  }

  private status(args: Record<string, unknown>, context: MediaToolContext): unknown {
    const { file, service } = this.dependencies(args, context);
    let status;
    try { status = service.getStatus(file.id); }
    catch (error) { throw new Error(`查询处理状态失败: ${errorText(error)}`); }
    const payload: Record<string, unknown> = {
      file_id: file.id,
      resource_id: file.resourceId,
      file_name: file.fileName,
      mime_type: file.mimeType,
      page_count: file.pageCount,
      is_running: service.isRunning(file.id),
      extracted_text_chars: file.extractedTextChars,
    };
    if (status === null) {
      payload.stage = 'unknown';
      payload.hint = '尚无处理状态记录（可能从未发起过解析）。可用 document_parse 发起解析/OCR。';
      return payload;
    }
    payload.stage = status.stage;
    payload.progress = status.progress;
    if (status.error != null) payload.error = status.error;
    if (status.startedAt != null) payload.started_at_ms = millis(status.startedAt);
    if (status.completedAt != null) payload.completed_at_ms = millis(status.completedAt);
    if (!TERMINAL_STAGES.includes(status.stage)) {
      payload.hint = '仍在处理中，请稍后再次调用 document_parse_status。';
    } else if (status.stage === 'error') {
      payload.hint = '解析失败。可用 document_parse 重新发起（stage=full 重跑完整管线）。';
    } else {
      payload.hint = '解析完成。可用 resource_read 读取全文；如需入题库，用同一 resource_id 调用 qbank_import_document；'
        + '入库题目可再用 review_schedule 安排复习。';
    }
    return payload;
  }
}
