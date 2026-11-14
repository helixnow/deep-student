/**
 * `src/chat_v2/tools/xlsx_executor.rs`: `xlsx_read_structured`, `xlsx_extract_tables`,
 * `xlsx_get_metadata`, `xlsx_to_spec`, `xlsx_create`, `xlsx_edit_cells`,
 * `xlsx_replace_text`. `xlsx_edit_cells` enforces the fidelity preflight and
 * reports formula cells it overwrites.
 */
import type { ToolCall, ToolConcurrency, ToolResultInfo } from '../../../chat/api.ts';
import { stripToolNamespace } from '../document-processing.ts';
import { XLSX_EDIT_GATE_WORDING, canHandle, sensitivityLevel } from '../office-executors.ts';
import { buildEditFidelityWarning, enforceEditPreflight, preflightForEdit } from '../office-fidelity.ts';
import { collectOverwrittenFormulaCells } from '../xlsx-formulas.ts';
import { deliverOfficeBytes } from './office-delivery.ts';
import { checkParseSize, withPrefix, type OfficeToolDeps } from './office-common.ts';
import {
  argumentsOf, replacementPairs, requiredStringArg, runToolCall, stringArg, utf8Length,
  type MediaToolContext,
} from './runtime.ts';
import { loadVfsFileBytes } from './vfs-source.ts';

const NAME = 'XlsxToolExecutor';
const MISSING_RESOURCE = "Missing 'resource_id' parameter";

/** `{sheet, cell, value}`：sheet 缺省 `Sheet1`，非字符串 value 按 Rust `as_str().unwrap_or("")` 记空串。 */
function cellEdits(args: Record<string, unknown>): Array<[string, string, string]> {
  const value = args.edits;
  if (!Array.isArray(value)) throw new Error("Missing 'edits' parameter (array of {sheet, cell, value})");
  return value.map(item => {
    const entry = argumentsOf(item);
    const cell = stringArg(entry, 'cell');
    if (cell === null) throw new Error("Each edit must have a 'cell' field (e.g. 'A1')");
    return [stringArg(entry, 'sheet') ?? 'Sheet1', cell, stringArg(entry, 'value') ?? ''];
  });
}

export class XlsxToolExecutor {
  private readonly deps: OfficeToolDeps;

  constructor(deps: OfficeToolDeps) { this.deps = deps; }

  name(): string { return NAME; }

  canHandle(toolName: string): boolean { return canHandle('xlsx', toolName); }

  sensitivityLevel(toolName: string): 'low' | 'medium' { return sensitivityLevel('xlsx', toolName); }

  concurrencyClass(toolName: string): ToolConcurrency {
    switch (stripToolNamespace(toolName)) {
      case 'xlsx_read_structured':
      case 'xlsx_extract_tables':
      case 'xlsx_get_metadata':
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
      case 'xlsx_read_structured': return this.readStructured(args, context);
      case 'xlsx_extract_tables': return this.extractTables(args, context);
      case 'xlsx_get_metadata': return this.getMetadata(args, context);
      case 'xlsx_create': return this.create(args, context);
      case 'xlsx_to_spec': return this.toSpec(args, context);
      case 'xlsx_edit_cells': return this.editCells(args, context);
      case 'xlsx_replace_text': return this.replaceText(args, context);
      default: throw new Error(`Unknown xlsx tool: ${toolName}`);
    }
  }

  private async load(context: MediaToolContext, resourceId: string): Promise<Buffer> {
    return await loadVfsFileBytes(context.vfs_db, this.deps.repos(), resourceId, NAME, this.deps.log);
  }

  private async readStructured(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    checkParseSize('XLSX', bytes);
    const content = await withPrefix('XLSX 结构化提取失败',
      () => this.deps.parser().extractTextFromBytes('spreadsheet.xlsx', bytes));
    return {
      success: true, resource_id: resourceId, format: 'text',
      content, contentLength: utf8Length(content),
    };
  }

  private async extractTables(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const tables = await withPrefix('XLSX 表格提取失败', () => this.deps.parser().extractXlsxTables(bytes));
    return { success: true, resource_id: resourceId, sheet_count: tables.length, tables };
  }

  private async getMetadata(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const metadata = await withPrefix('XLSX 元数据读取失败', () => this.deps.parser().extractXlsxMetadata(bytes));
    return { success: true, resource_id: resourceId, metadata };
  }

  private async toSpec(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const spec = await withPrefix('XLSX → spec 转换失败', () => this.deps.parser().extractXlsxAsSpec(bytes));
    return {
      success: true, resource_id: resourceId, spec,
      message: '已将 XLSX 转换为 JSON spec。你可以修改 spec 后使用 xlsx_create 生成新文件。',
    };
  }

  private async editCells(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const edits = cellEdits(args);
    const fileName = stringArg(args, 'file_name') ?? 'edited.xlsx';
    const folderId = stringArg(args, 'folder_id');
    const bytes = await this.load(context, resourceId);
    const preflight = preflightForEdit(bytes);
    enforceEditPreflight(preflight, XLSX_EDIT_GATE_WORDING);
    const overwritten = collectOverwrittenFormulaCells(bytes, edits);
    const [newBytes, editCount] = await withPrefix('XLSX 编辑失败',
      () => this.deps.parser().editXlsxCells(bytes, edits));
    if (editCount === 0) {
      return { success: true, resource_id: resourceId, edits_made: 0, message: '未执行任何编辑操作。' };
    }
    const output = deliverOfficeBytes(context, this.deps, args, {
      bytes: newBytes, format: 'xlsx', fileName, folderId,
      operation: 'edit_cells', sourceResourceId: resourceId,
    });
    output.edits_made = editCount;
    if (overwritten.length > 0) output.overwritten_formula_cells = overwritten;
    const warning = buildEditFidelityWarning(preflight, XLSX_EDIT_GATE_WORDING,
      [['overwritten_formula_cells', overwritten]]);
    if (warning !== null) output.fidelity_warning = warning;
    output.message = `已编辑 ${editCount} 个单元格，保存为「${fileName}」`;
    return output;
  }

  private async replaceText(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const replacements = replacementPairs(args);
    const fileName = stringArg(args, 'file_name') ?? 'edited.xlsx';
    const bytes = await this.load(context, resourceId);
    const [newBytes, total] = await withPrefix('XLSX 替换失败',
      () => this.deps.parser().replaceTextInXlsx(bytes, replacements));
    if (total === 0) {
      return {
        success: true, resource_id: resourceId, replacements_made: 0,
        message: '未找到任何匹配项，表格未修改。',
      };
    }
    const output = deliverOfficeBytes(context, this.deps, args, {
      bytes: newBytes, format: 'xlsx', fileName, folderId: null,
      operation: 'replace_text', sourceResourceId: resourceId,
    });
    output.replacements_made = total;
    output.message = `已完成 ${total} 个单元格替换，保存为「${fileName}」`;
    return output;
  }

  private async create(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    if (args.spec === undefined) throw new Error("Missing 'spec' parameter");
    const fileName = stringArg(args, 'file_name') ?? 'generated.xlsx';
    const folderId = stringArg(args, 'folder_id');
    const bytes = await withPrefix('XLSX 生成失败', () => this.deps.parser().generateXlsxFromSpec(args.spec));
    const output = deliverOfficeBytes(context, this.deps, args, {
      bytes, format: 'xlsx', fileName, folderId, operation: 'create', sourceResourceId: null,
    });
    output.message = `已生成 XLSX 文件「${fileName}」(${Math.trunc(bytes.length / 1024)}KB)`;
    return output;
  }
}
