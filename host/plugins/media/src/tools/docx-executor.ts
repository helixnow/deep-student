/**
 * `src/chat_v2/tools/docx_executor.rs`: `docx_read_structured`, `docx_extract_tables`,
 * `docx_get_metadata`, `docx_to_spec`, `docx_create`, `docx_replace_text`.
 * Sources are VFS files; writes go through the shared Office delivery channel.
 */
import type { ToolCall, ToolConcurrency, ToolResultInfo } from '../../../chat/api.ts';
import { stripToolNamespace } from '../document-processing.ts';
import { DOCX_EDIT_GATE_WORDING, canHandle, sensitivityLevel } from '../office-executors.ts';
import { buildEditFidelityWarning, enforceEditPreflight, preflightForEdit } from '../office-fidelity.ts';
import { deliverOfficeBytes } from './office-delivery.ts';
import { checkParseSize, withPrefix, type OfficeToolDeps } from './office-common.ts';
import {
  argumentsOf, replacementPairs, requiredStringArg, runToolCall, stringArg, utf8Length,
  type MediaToolContext,
} from './runtime.ts';
import { loadVfsFileBytes } from './vfs-source.ts';

const NAME = 'DocxToolExecutor';
const MISSING_RESOURCE = "Missing 'resource_id' parameter";

export class DocxToolExecutor {
  private readonly deps: OfficeToolDeps;

  constructor(deps: OfficeToolDeps) { this.deps = deps; }

  name(): string { return NAME; }

  canHandle(toolName: string): boolean { return canHandle('docx', toolName); }

  sensitivityLevel(toolName: string): 'low' | 'medium' { return sensitivityLevel('docx', toolName); }

  concurrencyClass(toolName: string): ToolConcurrency {
    switch (stripToolNamespace(toolName)) {
      case 'docx_read_structured':
      case 'docx_extract_tables':
      case 'docx_get_metadata':
        return 'read_only';
      default:
        return 'serial';
    }
  }

  async execute(call: ToolCall, context: MediaToolContext): Promise<ToolResultInfo> {
    const toolName = stripToolNamespace(call.name);
    this.deps.log.debug(`[${NAME}] Executing: ${toolName} (full: ${call.name})`);
    return runToolCall(NAME, call, context, this.deps.log, () => this.dispatch(toolName, call, context));
  }

  private async dispatch(toolName: string, call: ToolCall, context: MediaToolContext): Promise<unknown> {
    const args = argumentsOf(call.arguments);
    switch (toolName) {
      case 'docx_read_structured': return this.readStructured(args, context);
      case 'docx_extract_tables': return this.extractTables(args, context);
      case 'docx_get_metadata': return this.getMetadata(args, context);
      case 'docx_create': return this.create(args, context);
      case 'docx_to_spec': return this.toSpec(args, context);
      case 'docx_replace_text': return this.replaceText(args, context);
      default: throw new Error(`Unknown docx tool: ${toolName}`);
    }
  }

  private async load(context: MediaToolContext, resourceId: string): Promise<Buffer> {
    return await loadVfsFileBytes(context.vfs_db, this.deps.repos(), resourceId, NAME, this.deps.log);
  }

  private async readStructured(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    checkParseSize('DOCX', bytes);
    const structured = await withPrefix('DOCX 结构化提取失败',
      () => this.deps.parser().extractDocxStructured(bytes));
    return {
      success: true, resource_id: resourceId, format: 'markdown',
      content: structured, contentLength: utf8Length(structured),
    };
  }

  private async extractTables(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const tables = await withPrefix('DOCX 表格提取失败', () => this.deps.parser().extractDocxTables(bytes));
    return { success: true, resource_id: resourceId, table_count: tables.length, tables };
  }

  private async getMetadata(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const metadata = await withPrefix('DOCX 元数据读取失败', () => this.deps.parser().extractDocxMetadata(bytes));
    return { success: true, resource_id: resourceId, metadata };
  }

  private async toSpec(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const spec = await withPrefix('DOCX → spec 转换失败', () => this.deps.parser().extractDocxAsSpec(bytes));
    return {
      success: true, resource_id: resourceId, spec,
      message: '已将 DOCX 转换为 JSON spec。你可以修改 spec 后使用 docx_create 生成新文件。',
    };
  }

  private async replaceText(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const replacements = replacementPairs(args);
    const fileName = stringArg(args, 'file_name') ?? 'edited.docx';
    const bytes = await this.load(context, resourceId);
    const preflight = preflightForEdit(bytes);
    enforceEditPreflight(preflight, DOCX_EDIT_GATE_WORDING);
    const [newBytes, total] = await withPrefix('DOCX 替换失败',
      () => this.deps.parser().replaceTextInDocx(bytes, replacements));
    if (total === 0) {
      return {
        success: true, resource_id: resourceId, replacements_made: 0,
        message: '未找到任何匹配项，文档未修改。',
      };
    }
    const output = deliverOfficeBytes(context, this.deps, args, {
      bytes: newBytes, format: 'docx', fileName, folderId: null,
      operation: 'replace_text', sourceResourceId: resourceId,
    });
    output.replacements_made = total;
    const warning = buildEditFidelityWarning(preflight, DOCX_EDIT_GATE_WORDING, []);
    if (warning !== null) output.fidelity_warning = warning;
    output.message = `已完成 ${total} 处替换，保存为「${fileName}」`;
    return output;
  }

  private async create(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    if (args.spec === undefined) throw new Error("Missing 'spec' parameter");
    const fileName = stringArg(args, 'file_name') ?? 'generated.docx';
    const folderId = stringArg(args, 'folder_id');
    const bytes = await withPrefix('DOCX 生成失败', () => this.deps.parser().generateDocxFromSpec(args.spec));
    const output = deliverOfficeBytes(context, this.deps, args, {
      bytes, format: 'docx', fileName, folderId, operation: 'create', sourceResourceId: null,
    });
    output.message = `已生成 DOCX 文件「${fileName}」(${Math.trunc(bytes.length / 1024)}KB)`;
    return output;
  }
}
