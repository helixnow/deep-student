// chat_v2/tools/notes_import_executor.rs: tool-name routing, staged ZIP path
// validation and execution for the `notes_import` Agent tool. The importer
// itself is the same `NotesImporter` used by the settings-page UI.
import { isAbsolute, join, normalize, relative, sep } from '../../../platform/util/path.ts';
import {
  executeAgentToolWithLifecycle,
  type AgentToolCall, type AgentToolResultInfo, type ExecutionContext,
} from '../../../kernel/agent-api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { notesLog } from '../repository/log.ts';
import { notesLocalRuntime } from './local-runtime.ts';
import {
  importNotes, type ImportConflictStrategy, type ImportSummary,
} from '../repository/exporter.ts';
import { stripToolNamespace, type CanvasToolSensitivity } from './canvas-tool.ts';

const LOG_PREFIX = '[NotesImportExecutor]';

export function canHandleNotesImport(toolName: string): boolean {
  return stripToolNamespace(toolName) === 'notes_import';
}

export function notesImportSensitivity(toolName: string): CanvasToolSensitivity {
  return canHandleNotesImport(toolName) ? 'medium' : 'low';
}

export interface NotesImportExecutorPorts {
  readonly conn: () => SqlExecutor;
  /** Resolved lazily: test hosts may omit the settings service. */
  readonly settings: () => SettingsStore;
  readonly baseDir: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function argsObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

/** runtime_roots.rs::normalize_runtime_relative_path. */
export function normalizeRuntimeRelativePath(raw: string | null | undefined): string {
  const trimmed = rustTrim(raw ?? '');
  if (trimmed.length === 0 || trimmed === '.') return '';
  if (isAbsolute(trimmed)) {
    throw new Error('Path must be relative to the selected runtime root');
  }
  const components = trimmed.split(sep);
  if (components.includes('..')) {
    throw new Error('Parent directory traversal is not allowed');
  }
  const normalized = normalize(trimmed);
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith(sep)) {
    throw new Error('Path must be relative to the selected runtime root');
  }
  return normalized;
}

/** attachment_stage_executor.rs::resolve_staged_file_in_temp_root. */
export function resolveStagedFileInTempRoot(tempRoot: string, relativePath: string): string {
  const relativeNormalized = normalizeRuntimeRelativePath(relativePath);
  let rootCanonical: string;
  try {
    rootCanonical = notesLocalRuntime().realpathNative(tempRoot);
  } catch (error) {
    throw new Error(`Failed to canonicalize temp root: ${errorText(error)}`);
  }
  const target = join(tempRoot, relativeNormalized);
  let info;
  try {
    info = notesLocalRuntime().lstat(target);
  } catch {
    throw new Error(`Staged file not found: ${relativePath}`);
  }
  if (info.kind !== 'file') {
    throw new Error('Staged path must be a regular file');
  }
  let targetCanonical: string;
  try {
    targetCanonical = notesLocalRuntime().realpathNative(target);
  } catch (error) {
    throw new Error(`Failed to resolve staged file path: ${errorText(error)}`);
  }
  const rel = relative(rootCanonical, targetCanonical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Staged path escapes the session temp root');
  }
  return targetCanonical;
}

/** `notes_import` Agent tool (chat_v2/tools/notes_import_executor.rs). */
export class NotesImportExecutor {
  private readonly ports: NotesImportExecutorPorts | null;

  constructor(ports?: NotesImportExecutorPorts) {
    this.ports = ports ?? null;
  }

  canHandle(toolName: string): boolean {
    return canHandleNotesImport(toolName);
  }

  sensitivityLevel(toolName: string): CanvasToolSensitivity {
    return notesImportSensitivity(toolName);
  }

  name(): string {
    return 'NotesImportExecutor';
  }

  async execute(call: AgentToolCall, ctx: ExecutionContext): Promise<AgentToolResultInfo> {
    return executeAgentToolWithLifecycle(call, ctx, () => this.executeImport(call, ctx), {
      formatError: errorText,
      warn: message => notesLog.warn(`${LOG_PREFIX} ${message}`),
    });
  }

  private requirePorts(): NotesImportExecutorPorts {
    if (this.ports === null) throw new Error('Notes database not available');
    return this.ports;
  }

  private async executeImport(
    call: AgentToolCall,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const ports = this.requirePorts();
    const args = argsObject(call.arguments);
    const rawRootId = stringArg(args, 'root_id');
    const rootId = rawRootId === null ? 'temp' : rustTrim(rawRootId);
    const normalizedRootId = rootId.length === 0 ? 'temp' : rootId;
    if (normalizedRootId.toLowerCase() !== 'temp') {
      throw new Error(
        `notes_import only accepts root_id=temp (staged attachments), got '${normalizedRootId}'`,
      );
    }
    const rawRelative = stringArg(args, 'relative_path');
    const relativePath = rawRelative === null ? '' : rustTrim(rawRelative);
    if (relativePath.length === 0) {
      throw new Error(
        "Missing 'relative_path' parameter (use the path returned by attachment_stage)",
      );
    }
    const rawStrategy = stringArg(args, 'conflict_strategy');
    const strategyRaw = rawStrategy === null ? 'skip' : rustTrim(rawStrategy);
    const conflictStrategyRaw = strategyRaw.length === 0 ? 'skip' : strategyRaw;
    let conflictStrategy: ImportConflictStrategy;
    switch (conflictStrategyRaw) {
      case 'skip': conflictStrategy = 'skip'; break;
      case 'overwrite': conflictStrategy = 'overwrite'; break;
      case 'merge_keep_newer': conflictStrategy = 'merge_keep_newer'; break;
      default:
        throw new Error(
          `Invalid conflict_strategy '${conflictStrategyRaw}': expected skip, overwrite or merge_keep_newer`,
        );
    }

    const zipPath = resolveStagedFileInTempRoot(ctx.runtimeRoots.tempRoot(), relativePath);
    let summary: ImportSummary;
    try {
      summary = await importNotes({
        conn: ports.conn(),
        settings: ports.settings(),
        baseDir: ports.baseDir,
        filePath: zipPath,
        conflictStrategy,
      });
    } catch (error) {
      throw new Error(`Notes import failed: ${errorText(error)}`);
    }
    notesLog.debug(`${LOG_PREFIX} imported ${summary.note_count} note(s) from ${relativePath}`);
    return {
      success: true,
      conflict_strategy: conflictStrategyRaw,
      subject_count: summary.subject_count,
      note_count: summary.note_count,
      attachment_count: summary.attachment_count,
      skipped_count: summary.skipped_count,
      overwritten_count: summary.overwritten_count,
      hint: '导入完成：笔记与附件已写入资源库，可用 builtin-note_list / builtin-note_search 验证结果。',
    };
  }
}
