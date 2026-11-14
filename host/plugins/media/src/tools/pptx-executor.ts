/**
 * `src/chat_v2/tools/pptx_executor.rs`: `pptx_read_structured`, `pptx_get_metadata`,
 * `pptx_extract_tables`, `pptx_to_spec`, `pptx_create`, `pptx_replace_text`
 * (spec round-trip over title / subtitle / bullets / table headers and rows).
 */
import type { ToolCall, ToolConcurrency, ToolResultInfo } from '../../../chat/api.ts';
import { stripToolNamespace } from '../document-processing.ts';
import { PPTX_EDIT_GATE_WORDING, canHandle, sensitivityLevel } from '../office-executors.ts';
import { buildEditFidelityWarning, enforceEditPreflight, preflightForEdit } from '../office-fidelity.ts';
import { deliverOfficeBytes } from './office-delivery.ts';
import { checkParseSize, withPrefix, type OfficeToolDeps } from './office-common.ts';
import {
  argumentsOf, replacementPairs, requiredStringArg, runToolCall, stringArg, utf8Length,
  type MediaToolContext,
} from './runtime.ts';
import { loadVfsFileBytes } from './vfs-source.ts';

const NAME = 'PptxToolExecutor';
const MISSING_RESOURCE = "Missing 'resource_id' parameter";

/** `apply_replacements`: every pair in order (Rust `str::replace`), `null` when unchanged. */
function applyReplacements(original: string, replacements: ReadonlyArray<readonly [string, string]>): string | null {
  let result = original;
  for (const [find, replace] of replacements) result = result.replaceAll(find, () => replace);
  return result !== original ? result : null;
}

/** Replaces string items of `list` in place and returns how many changed. */
function replaceStrings(list: unknown, replacements: ReadonlyArray<readonly [string, string]>): number {
  if (!Array.isArray(list)) return 0;
  let count = 0;
  list.forEach((item: unknown, index: number) => {
    if (typeof item !== 'string') return;
    const next = applyReplacements(item, replacements);
    if (next !== null) {
      list[index] = next;
      count += 1;
    }
  });
  return count;
}

function replaceField(
  object: Record<string, unknown>, key: string, replacements: ReadonlyArray<readonly [string, string]>,
): number {
  const value = object[key];
  if (typeof value !== 'string') return 0;
  const next = applyReplacements(value, replacements);
  if (next === null) return 0;
  object[key] = next;
  return 1;
}

export class PptxToolExecutor {
  private readonly deps: OfficeToolDeps;

  constructor(deps: OfficeToolDeps) { this.deps = deps; }

  name(): string { return NAME; }

  canHandle(toolName: string): boolean { return canHandle('pptx', toolName); }

  sensitivityLevel(toolName: string): 'low' | 'medium' { return sensitivityLevel('pptx', toolName); }

  concurrencyClass(toolName: string): ToolConcurrency {
    switch (stripToolNamespace(toolName)) {
      case 'pptx_read_structured':
      case 'pptx_extract_tables':
      case 'pptx_get_metadata':
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
      case 'pptx_read_structured': return this.readStructured(args, context);
      case 'pptx_get_metadata': return this.getMetadata(args, context);
      case 'pptx_extract_tables': return this.extractTables(args, context);
      case 'pptx_create': return this.create(args, context);
      case 'pptx_to_spec': return this.toSpec(args, context);
      case 'pptx_replace_text': return this.replaceText(args, context);
      default: throw new Error(`Unknown pptx tool: ${toolName}`);
    }
  }

  private async load(context: MediaToolContext, resourceId: string): Promise<Buffer> {
    return await loadVfsFileBytes(context.vfs_db, this.deps.repos(), resourceId, NAME, this.deps.log);
  }

  private async readStructured(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    checkParseSize('PPTX', bytes);
    const markdown = await withPrefix('PPTX 结构化提取失败',
      () => this.deps.parser().extractTextFromBytes('presentation.pptx', bytes));
    return {
      success: true, resource_id: resourceId, format: 'markdown',
      content: markdown, contentLength: utf8Length(markdown),
    };
  }

  private async getMetadata(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const metadata = await withPrefix('PPTX 元数据读取失败', () => this.deps.parser().extractPptxMetadata(bytes));
    return { success: true, resource_id: resourceId, metadata };
  }

  private async extractTables(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const tables = await withPrefix('PPTX 表格提取失败', () => this.deps.parser().extractPptxTables(bytes));
    return { success: true, resource_id: resourceId, table_count: tables.length, tables };
  }

  private async toSpec(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const bytes = await this.load(context, resourceId);
    const spec = await withPrefix('PPTX → spec 转换失败', () => this.deps.parser().extractPptxAsSpec(bytes));
    return {
      success: true, resource_id: resourceId, spec,
      message: '已将 PPTX 转换为 JSON spec。你可以修改 spec 后使用 pptx_create 生成新文件。',
    };
  }

  private async replaceText(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    const resourceId = requiredStringArg(args, 'resource_id', MISSING_RESOURCE);
    const replacements = replacementPairs(args);
    const fileName = stringArg(args, 'file_name') ?? 'edited.pptx';
    const bytes = await this.load(context, resourceId);
    const preflight = preflightForEdit(bytes);
    enforceEditPreflight(preflight, PPTX_EDIT_GATE_WORDING);
    const spec = await withPrefix('PPTX 读取失败', () => this.deps.parser().extractPptxAsSpec(bytes));
    let total = replaceField(spec, 'title', replacements);
    const slides = spec.slides;
    if (Array.isArray(slides)) {
      for (const slide of slides as unknown[]) {
        if (slide === null || typeof slide !== 'object' || Array.isArray(slide)) continue;
        const entry = slide as Record<string, unknown>;
        total += replaceField(entry, 'title', replacements);
        total += replaceField(entry, 'subtitle', replacements);
        total += replaceStrings(entry.bullets, replacements);
        total += replaceStrings(entry.headers, replacements);
        if (Array.isArray(entry.rows)) {
          for (const row of entry.rows as unknown[]) total += replaceStrings(row, replacements);
        }
      }
    }
    if (total === 0) {
      return {
        success: true, resource_id: resourceId, replacements_made: 0,
        message: '未找到任何匹配项，演示文稿未修改。',
      };
    }
    const newBytes = await withPrefix('PPTX 重新生成失败', () => this.deps.parser().generatePptxFromSpec(spec));
    const output = deliverOfficeBytes(context, this.deps, args, {
      bytes: newBytes, format: 'pptx', fileName, folderId: null,
      operation: 'replace_text', sourceResourceId: resourceId,
    });
    output.replacements_made = total;
    const warning = buildEditFidelityWarning(preflight, PPTX_EDIT_GATE_WORDING, []);
    if (warning !== null) output.fidelity_warning = warning;
    output.message = `已完成 ${total} 处替换，保存为「${fileName}」`;
    return output;
  }

  private async create(args: Record<string, unknown>, context: MediaToolContext): Promise<unknown> {
    if (args.spec === undefined) throw new Error("Missing 'spec' parameter");
    const fileName = stringArg(args, 'file_name') ?? 'generated.pptx';
    const folderId = stringArg(args, 'folder_id');
    const bytes = await withPrefix('PPTX 生成失败', () => this.deps.parser().generatePptxFromSpec(args.spec));
    const output = deliverOfficeBytes(context, this.deps, args, {
      bytes, format: 'pptx', fileName, folderId, operation: 'create', sourceResourceId: null,
    });
    output.message = `已生成 PPTX 文件「${fileName}」(${Math.trunc(bytes.length / 1024)}KB)`;
    return output;
  }
}
