/**
 * agent-task/extractors — 从工具块中提取任务面板数据的纯函数集
 *
 * 覆盖：todo 计划步骤（按 todoListId 合并）、来源、产物、Changes 摘要、
 * 变更覆盖告警、Runtime 活动/环境、attempt_completion 完成叙述。
 * 全部为无副作用纯函数，便于单测与复用。
 */

import type { Block } from '../../core/types/block';
import { blocksToSourceBundle } from '../panels/sourceAdapter';
import { extractCompletionData, isAttemptCompletionTool } from '../CompletionCard';
import type {
  ArtifactItem,
  ChangeAction,
  ChangeCoverageIssue,
  ChangeItem,
  ChangeKind,
  RuntimeAction,
  RuntimeEnvironment,
  RuntimeItem,
  SourceItem,
  Step,
  TaskCompletionSummary,
  TodoOutput,
  TodoPlanSnapshot,
} from './types';

// ============================================================================
// 工具名集合与通用 helper
// ============================================================================

const TODO_TOOL_SET = new Set([
  'todo_init', 'todo_update', 'todo_add', 'todo_get',
  'builtin-todo_init', 'builtin-todo_update', 'builtin-todo_add', 'builtin-todo_get',
]);

export function isTodoTool(block: { toolName?: string }): boolean {
  return typeof block.toolName === 'string' ? TODO_TOOL_SET.has(block.toolName) : false;
}

/** 笔记写入类工具（产生/修改笔记，视为产物） */
export const NOTE_WRITE_TOOLS = new Set([
  'note_create', 'note_append', 'note_replace', 'note_set',
  'builtin-note_create', 'builtin-note_append', 'builtin-note_replace', 'builtin-note_set',
]);

/** 文件生成类工具名后缀（docx/xlsx/pptx 创建编辑 + 论文保存） */
export function isFileProducingTool(toolName: string): boolean {
  const short = toolName.replace('builtin-', '');
  return (
    short.startsWith('docx_') ||
    short.startsWith('xlsx_') ||
    short.startsWith('pptx_') ||
    short === 'paper_save'
  );
}

export function unwrapToolData(output: unknown): Record<string, unknown> {
  const out = (output ?? {}) as Record<string, unknown>;
  return (typeof out.result === 'object' && out.result !== null
    ? out.result
    : out) as Record<string, unknown>;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

export function normalizeToolName(toolName: string): string {
  return toolName
    .replace(/^builtin-/, '')
    .replace(/^mcp_/, '')
    .replace(/^mcp\.tools\./, '');
}

// ============================================================================
// 计划步骤（按 todoListId 合并，修复「最后写入胜出」）
// ============================================================================

interface TodoListAccumulator extends TodoPlanSnapshot {
  /** 该列表最近一次被更新时的扫描序号，用于挑选「最新」列表 */
  lastTouchedAt: number;
}

const FALLBACK_TODO_LIST_KEY = '__default__';

/**
 * 从 todo 工具块序列中提取当前应展示的计划。
 *
 * 历史 bug：不区分 todoListId，逐块扫描时「最后一个带 steps 的块」直接覆盖
 * 全部状态——多个 todo 列表（多任务）交错更新时步骤会来回闪烁、错绑。
 * 现在按 todoListId 维度合并各自的最新快照，再挑选展示对象：
 * 1) 优先取「最近更新且未完成」的列表（正在进行的任务）；
 * 2) 否则取最近更新的列表（全部完成时展示最后收尾的那个）。
 */
export function extractSteps(
  blocks: { toolOutput?: unknown; toolName?: string }[],
): TodoPlanSnapshot {
  const lists = new Map<string, TodoListAccumulator>();
  let scanIndex = 0;

  for (const b of blocks) {
    const out = b.toolOutput as TodoOutput | { result?: TodoOutput } | undefined;
    if (!out) continue;
    const d = (out as { result?: TodoOutput }).result || (out as TodoOutput);

    const listKey = typeof d.todoListId === 'string' && d.todoListId
      ? d.todoListId
      : FALLBACK_TODO_LIST_KEY;
    const acc = lists.get(listKey) ?? { steps: [] as Step[], lastTouchedAt: -1 };

    if (d.steps?.length) {
      acc.steps = d.steps;
      acc.title = d.title || acc.title;
    } else if (d.title) {
      acc.title = d.title;
    }
    if (d.isAllDone !== undefined) acc.isAllDone = d.isAllDone;
    if (d.message) acc.message = d.message;
    acc.lastTouchedAt = scanIndex;

    lists.set(listKey, acc);
    scanIndex += 1;
  }

  const withSteps = [...lists.values()].filter((list) => list.steps.length > 0);
  if (withSteps.length === 0) {
    // 无任何带 steps 的列表：退回合并 title/message（保持旧行为：仍可显示标题）
    const latest = [...lists.values()].sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)[0];
    return {
      steps: [],
      title: latest?.title,
      isAllDone: latest?.isAllDone,
      message: latest?.message,
    };
  }

  withSteps.sort((a, b) => b.lastTouchedAt - a.lastTouchedAt);
  const active = withSteps.find((list) => list.isAllDone !== true) ?? withSteps[0];
  return {
    steps: active.steps,
    title: active.title,
    isAllDone: active.isAllDone,
    message: active.message,
  };
}

// ============================================================================
// Changes / Runtime 工具识别
// ============================================================================

export function inferChangeActionFromOp(op: unknown): ChangeAction | undefined {
  if (typeof op !== 'string') return undefined;
  const normalized = op.toLowerCase();
  if (normalized === 'created' || normalized === 'create') return 'create';
  if (normalized === 'modified' || normalized === 'updated' || normalized === 'update') return 'update';
  if (normalized === 'deleted' || normalized === 'delete') return 'delete';
  if (normalized === 'appended' || normalized === 'append') return 'append';
  if (normalized === 'written' || normalized === 'write') return 'write';
  return undefined;
}

export function inferChangeAction(toolName: string): ChangeAction | undefined {
  const short = normalizeToolName(toolName);
  if (short.includes('delete') || short.endsWith('_remove')) return 'delete';
  if (short.includes('append')) return 'append';
  if (short.includes('create') || short === 'file_write') return 'create';
  if (short.includes('write') || short.includes('save')) return 'write';
  if (short.includes('replace') || short.includes('patch') || short.includes('edit') || short.includes('update') || short.includes('set')) return 'update';
  return undefined;
}

export function isChangeProducingTool(toolName: string): boolean {
  const short = normalizeToolName(toolName);
  return (
    NOTE_WRITE_TOOLS.has(toolName) ||
    ['file_write', 'file_create', 'file_append', 'file_patch', 'file_delete'].includes(short) ||
    short === 'workspace_artifact_write' ||
    short === 'workspace_file_write' ||
    short === 'workspace_file_move' ||
    short === 'workspace_file_delete' ||
    short === 'workspace_change_revert' ||
    short === 'file_manager_commit' ||
    short === 'file_manager_restore' ||
    short === 'local_shell_execute' ||
    short.startsWith('docx_') ||
    short.startsWith('xlsx_') ||
    short.startsWith('pptx_') ||
    short === 'paper_save' ||
    short === 'workspace_update_document'
  );
}

export function isRuntimeTool(toolName: string): boolean {
  const short = normalizeToolName(toolName);
  return short === 'workspace_file_list' ||
    short === 'workspace_file_read' ||
    short === 'workspace_artifact_write' ||
    short === 'workspace_file_write' ||
    short === 'workspace_file_move' ||
    short === 'workspace_file_delete' ||
    short === 'workspace_change_revert' ||
    short === 'file_manager_commit' ||
    short === 'file_manager_restore' ||
    short === 'local_shell_preflight' ||
    short === 'local_shell_execute';
}

function runtimeActionForTool(toolName: string, blocked: boolean): RuntimeAction {
  if (blocked) return 'blocked';
  const short = normalizeToolName(toolName);
  if (short === 'workspace_file_list') return 'list';
  if (short === 'workspace_file_read') return 'read';
  if (short === 'local_shell_preflight') return 'check';
  if (short === 'local_shell_execute') return 'check';
  return 'write';
}

// ============================================================================
// 产物提取
// ============================================================================

/** 从成功的工具块中提取产物（笔记 + 生成文件） */
export function extractArtifacts(blocks: Block[]): ArtifactItem[] {
  const artifacts = new Map<string, ArtifactItem>();

  for (const block of blocks) {
    if (block.status !== 'success' || !block.toolName) continue;
    const d = unwrapToolData(block.toolOutput);

    if (NOTE_WRITE_TOOLS.has(block.toolName)) {
      const noteId = (d.note_id || d.noteId || d.id ||
        block.toolInput?.noteId || block.toolInput?.note_id) as string | undefined;
      if (!noteId) continue;
      const label = (d.title || block.toolInput?.title || d.noteTitle) as string | undefined;
      artifacts.set(noteId, {
        id: noteId,
        kind: 'note',
        label: label || noteId,
        toolName: block.toolName,
      });
    } else if (isFileProducingTool(block.toolName)) {
      const fileId = (d.file_id || d.new_file_id) as string | undefined;
      if (!fileId) continue;
      const label = (d.file_name || d.title) as string | undefined;
      artifacts.set(fileId, {
        id: fileId,
        kind: 'file',
        label: label || fileId,
        toolName: block.toolName,
      });
    }
  }

  return [...artifacts.values()];
}

// ============================================================================
// Changes 提取
// ============================================================================

/** 从成功工具块中提取写入/修改摘要。 */
export function extractChanges(blocks: Block[]): ChangeItem[] {
  const changes = new Map<string, ChangeItem>();

  for (const block of blocks) {
    if (block.status !== 'success' || !block.toolName || !isChangeProducingTool(block.toolName)) continue;

    const toolName = block.toolName;
    const short = normalizeToolName(toolName);
    const data = unwrapToolData(block.toolOutput);
    const input = block.toolInput ?? {};
    const action = inferChangeAction(toolName) ?? 'update';
    const summary = asRecord(data.file_change_summary);
    const mutationReceipt = asRecord(data.mutation_receipt);
    const summaryChanges = Array.isArray(summary?.changes) ? summary.changes : [];

    if (summaryChanges.length > 0) {
      for (const entry of summaryChanges) {
        const change = asRecord(entry);
        if (!change) continue;
        const target = firstString(
          change.relative_path,
          change.path,
          change.file_path,
          data.path,
          input.path,
        );
        const label = firstString(change.file_name, target, data.file_name, short) ?? short;
        const itemAction = inferChangeActionFromOp(change.op) ?? action;
        const rootId = firstString(change.root_id, data.root_id);
        const relativePath = firstString(change.relative_path, data.path);
        const backupRef = firstString(change.backup_ref);
        const afterHash = firstString(change.after_hash, change.afterHash);
        const id = `file:${itemAction}:${rootId ?? 'root'}:${target ?? label}:${toolName}`;
        changes.set(id, {
          id,
          kind: 'file',
          action: itemAction,
          label,
          target,
          toolName,
          rootId,
          relativePath,
          backupRef,
          afterHash,
          receipt: mutationReceipt ?? undefined,
        });
      }
      continue;
    }

    let kind: ChangeKind = 'file';
    let openId: string | undefined;
    let target = firstString(
      data.path,
      data.file_path,
      input.path,
      input.file_path,
      data.file_id,
      data.new_file_id,
      input.file_id,
      input.resource_id,
    );
    let label = firstString(
      data.file_name,
      data.title,
      input.title,
      target,
      short,
    ) ?? short;

    if (NOTE_WRITE_TOOLS.has(toolName)) {
      kind = 'note';
      openId = firstString(data.note_id, data.noteId, data.id, input.noteId, input.note_id);
      target = openId;
      label = firstString(data.title, input.title, data.noteTitle, openId) ?? label;
    } else if (short === 'workspace_update_document') {
      kind = 'document';
      openId = firstString(data.document_id, data.id);
      target = openId;
      label = firstString(data.title, input.title, openId) ?? label;
    } else if (short.startsWith('docx_') || short.startsWith('xlsx_') || short.startsWith('pptx_') || short === 'paper_save') {
      openId = firstString(data.file_id, data.new_file_id, input.file_id, input.resource_id);
      target = openId ?? target;
    }

    const id = `${kind}:${action}:${target ?? label}:${toolName}`;
    changes.set(id, {
      id,
      kind,
      action,
      label,
      target,
      toolName,
      openId,
    });
  }

  return [...changes.values()];
}

export function extractChangeCoverageIssues(blocks: Block[]): ChangeCoverageIssue[] {
  const issues = new Map<string, ChangeCoverageIssue>();

  for (const block of blocks) {
    if (block.status !== 'success' || !block.toolName || !isChangeProducingTool(block.toolName)) {
      continue;
    }
    const data = unwrapToolData(block.toolOutput);
    const summary = asRecord(data.file_change_summary);
    const rollback = asRecord(data.rollback_result);
    const reasons: string[] = [];

    if (summary?.changes_truncated === true) reasons.push('change-list-truncated');
    if (summary?.snapshot_truncated === true) reasons.push('snapshot-truncated');
    if (typeof summary?.snapshot_skipped === 'number' && summary.snapshot_skipped > 0) {
      reasons.push(`snapshot-skipped:${summary.snapshot_skipped}`);
    }
    if (typeof summary?.error === 'string' && summary.error.trim()) {
      reasons.push(`snapshot-error:${summary.error.trim()}`);
    }
    if (data.change_set_complete === false) reasons.push('rollback-coverage-incomplete');
    if (typeof data.change_set_error === 'string' && data.change_set_error.trim()) {
      reasons.push(`change-set-error:${data.change_set_error.trim()}`);
    }
    if (rollback?.complete === false) {
      const failed = typeof rollback.failed_count === 'number' ? rollback.failed_count : undefined;
      reasons.push(failed === undefined ? 'rollback-partial' : `rollback-partial:${failed}`);
    }
    const batchManifest = asRecord(data.batch_manifest);
    if (batchManifest && data.complete === false) {
      const failed = Array.isArray(batchManifest.items)
        ? batchManifest.items.filter((item) => asRecord(item)?.status === 'failed').length
        : undefined;
      reasons.push(failed === undefined ? 'batch-partial' : `batch-partial:${failed}`);
    }
    if (reasons.length === 0) continue;

    const id = `coverage:${block.toolName}:${reasons.join('|')}`;
    issues.set(id, {
      id,
      label: 'coverage-incomplete',
      detail: reasons.join(', '),
    });
  }

  return [...issues.values()];
}

// ============================================================================
// Runtime 提取
// ============================================================================

/** shell 操作符探测（管道/重定向/链式执行/子命令），用于危险信号标注 */
const SHELL_OPERATOR_RE = /[|;&><`]|\$\(/;

/** 删除类 runtime 工具（危险信号 delete） */
function isDeletingRuntimeTool(short: string): boolean {
  return short === 'workspace_file_delete' || short === 'file_delete';
}

/** 从文件 runtime 工具块中提取读/列目录/写入/拦截事实，展示在任务面板内。 */
export function extractRuntimeItems(blocks: Block[]): RuntimeItem[] {
  const runtime = new Map<string, RuntimeItem>();

  for (const block of blocks) {
    if (!block.toolName || !isRuntimeTool(block.toolName)) continue;

    const toolName = block.toolName;
    const short = normalizeToolName(toolName);
    const data = unwrapToolData(block.toolOutput);
    const input = block.toolInput ?? {};
    const fileManagerSummary = asRecord(data.file_change_summary);
    const firstFileManagerChange = Array.isArray(fileManagerSummary?.changes)
      ? asRecord(fileManagerSummary.changes[0])
      : undefined;
    const error = firstString(block.error, data.error, data.message, data.reason);
    const riskLevel = firstString(data.risk_level);
    const blocked = !!error || block.status === 'error' || riskLevel === 'blocked';
    const action = runtimeActionForTool(toolName, blocked);
    const rootId = firstString(
      data.root_id,
      input.root_id,
      short === 'workspace_artifact_write' ? 'artifacts' : undefined,
    ) ?? 'workspace';
    const isShellTool = short === 'local_shell_preflight' || short === 'local_shell_execute';
    const command = isShellTool ? firstString(data.command, input.command) : undefined;
    const relativePath = firstString(
      data.relative_path,
      data.path,
      isShellTool ? data.command : undefined,
      firstFileManagerChange?.destination_path,
      firstFileManagerChange?.relative_path,
      input.path,
      isShellTool ? input.command : undefined,
    ) ?? '.';

    let detail: string | undefined;
    const dangerFlags: string[] = [];
    if (!blocked && short === 'workspace_file_list') {
      const entries = Array.isArray(data.entries) ? data.entries.length : undefined;
      const skipped = typeof data.skipped === 'number' && data.skipped > 0 ? data.skipped : undefined;
      detail = entries !== undefined
        ? skipped !== undefined
          ? `${entries} entries, ${skipped} skipped`
          : `${entries} entries`
        : undefined;
    } else if (!blocked && short === 'workspace_file_read') {
      const bytes = typeof data.bytes === 'number' ? data.bytes : undefined;
      const truncated = data.truncated === true;
      detail = bytes !== undefined
        ? truncated ? `${bytes} bytes, truncated` : `${bytes} bytes`
        : undefined;
    } else if (!blocked && short === 'workspace_artifact_write') {
      const bytes = typeof data.bytes_written === 'number' ? data.bytes_written : undefined;
      detail = bytes !== undefined ? `${bytes} bytes` : undefined;
    } else if (short === 'local_shell_preflight') {
      const cwd = firstString(data.cwd, input.cwd) ?? '.';
      detail = riskLevel ? `${riskLevel} / ${cwd}` : cwd;
    } else if (short === 'local_shell_execute') {
      const cwd = firstString(data.cwd, input.cwd) ?? '.';
      const timedOut = data.timed_out === true;
      const exitCode = typeof data.exit_code === 'number' ? data.exit_code : undefined;
      const truncated = data.stdout_truncated === true || data.stderr_truncated === true;
      const envPolicy = data.env_policy && typeof data.env_policy === 'object'
        ? data.env_policy as Record<string, unknown>
        : undefined;
      const envKeys = Array.isArray(envPolicy?.explicit_keys) ? envPolicy.explicit_keys.length : 0;
      const envSuffix = envPolicy?.allowlist_mode === true
        ? `, env allowlist${envKeys > 0 ? ` +${envKeys}` : ''}`
        : envKeys > 0
          ? `, env +${envKeys}`
          : '';
      const networkPolicy = data.network_policy && typeof data.network_policy === 'object'
        ? data.network_policy as Record<string, unknown>
        : undefined;
      const networkSuffix = networkPolicy?.allow_network === true ? ', net' : '';
      if (networkPolicy?.allow_network === true) dangerFlags.push('net');
      detail = timedOut
        ? `timeout / ${cwd}`
        : exitCode !== undefined
          ? `exit ${exitCode}${truncated ? ', truncated' : ''}${envSuffix}${networkSuffix} / ${cwd}`
          : cwd;
    } else if (short === 'file_manager_commit' || short === 'file_manager_restore') {
      const manifest = asRecord(data.batch_manifest);
      const items = Array.isArray(manifest?.items) ? manifest.items : [];
      const failed = items.filter((item) => asRecord(item)?.status === 'failed').length;
      detail = data.complete === true
        ? `${items.length} items`
        : `${items.length - failed}/${items.length} items`;
    }

    if (command && SHELL_OPERATOR_RE.test(command)) dangerFlags.push('ops');
    if (isDeletingRuntimeTool(short)) dangerFlags.push('delete');

    const id = `${action}:${rootId}:${relativePath}:${toolName}`;
    runtime.set(id, {
      id,
      action,
      rootId,
      label: relativePath,
      detail,
      error,
      toolName,
      command,
      dangerFlags: dangerFlags.length > 0 ? dangerFlags : undefined,
    });
  }

  const items = [...runtime.values()];
  const executedCommands = new Set(
    items
      .filter((item) => normalizeToolName(item.toolName) === 'local_shell_execute')
      .map((item) => item.label),
  );
  const lastPreflightByCommand = new Map<string, number>();
  items.forEach((item, index) => {
    if (normalizeToolName(item.toolName) === 'local_shell_preflight') {
      lastPreflightByCommand.set(item.label, index);
    }
  });

  return items.filter((item, index) => {
    if (normalizeToolName(item.toolName) !== 'local_shell_preflight') return true;
    if (executedCommands.has(item.label)) return false;
    return lastPreflightByCommand.get(item.label) === index;
  });
}

/** Extract the latest effective local boundary instead of treating tool history as environment state. */
export function extractRuntimeEnvironment(blocks: Block[]): RuntimeEnvironment | null {
  let environment: RuntimeEnvironment | null = null;

  for (const block of blocks) {
    if (!block.toolName || !isRuntimeTool(block.toolName)) continue;
    const data = unwrapToolData(block.toolOutput);
    const input = block.toolInput ?? {};
    const root = asRecord(data.root);
    const sandbox = asRecord(data.sandbox);
    const networkPolicy = asRecord(data.network_policy);
    const networkAllowed = typeof networkPolicy?.allow_network === 'boolean'
      ? networkPolicy.allow_network
      : data.network_default === 'deny'
        ? false
        : undefined;

    environment = {
      rootId: firstString(data.root_id, root?.id, input.root_id),
      rootLabel: firstString(root?.label),
      cwd: firstString(data.cwd, input.cwd) ?? '.',
      sandboxBackend: firstString(sandbox?.backend, data.sandbox_backend),
      platform: firstString(data.os, data.platform),
      networkAllowed,
    };
  }

  return environment;
}

// ============================================================================
// 来源提取
// ============================================================================

/** 从成功块中提取来源（复用 sourceAdapter 的解析逻辑），按 title+url 去重 */
export function extractSources(blocks: Block[]): SourceItem[] {
  const successBlocks = blocks.filter((b) => b.status === 'success');
  const bundle = blocksToSourceBundle(successBlocks);
  if (!bundle) return [];

  const seen = new Set<string>();
  const items: SourceItem[] = [];
  for (const group of bundle.groups) {
    for (const item of group.items) {
      const dedupeKey = `${item.title}::${item.link ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push({
        id: item.id,
        title: item.title,
        url: item.link,
        resourceId: item.resourceId || item.sourceId,
        origin: item.origin,
      });
    }
  }
  return items;
}

// ============================================================================
// 完成叙述提取（统一走 CompletionCard 的 extractCompletionData）
// ============================================================================

/**
 * 从块序列中提取任务完成叙述：取最后一个成功的 attempt_completion 块，
 * 复用 CompletionCard 的 extractCompletionData（唯一提取器）。
 */
export function extractTaskCompletion(blocks: Block[]): TaskCompletionSummary | null {
  let latest: TaskCompletionSummary | null = null;
  for (const block of blocks) {
    if (block.status !== 'success' || !isAttemptCompletionTool(block.toolName)) continue;
    const data = extractCompletionData(block.toolInput, block.toolOutput);
    if (data.result || data.command) {
      latest = { result: data.result || undefined, command: data.command };
    }
  }
  return latest;
}
