/**
 * AgentTaskPanel — AI agent 的 builtin todo_list 步骤面板
 *
 * 附着在 chat 输入栏上方，非阻塞式。展开即见全部 steps。
 * 设计语义对齐 composer shell，颜色随主题 palette 联动。
 *
 * 结构化四区（对标 Codex 任务侧栏）：
 * 1. 计划 — todo steps 列表
 * 2. 来源 — 检索/搜索引用（复用 sourceAdapter，可点击溯源）
 * 3. 产物 — 笔记/文件 chip（点击在面板中打开）
 * 4. 摘要 — 全部完成后的总结语
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  ListChecks,
  Check,
  X,
  CircleNotch,
  SkipForward,
  CaretDown,
  CaretUp,
  Notebook,
  NotePencil,
  FileDoc,
  FileXls,
  FilePpt,
  FilePdf,
  File as FileIcon,
  Globe,
  Brain,
  BookOpen,
  MagnifyingGlass,
  Terminal,
  FolderOpen,
  ArrowCounterClockwise,
  ArrowSquareOut,
  Eye,
  DownloadSimple,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { motion, AnimatePresence } from 'framer-motion';
import { openUrl } from '@/utils/urlOpener';
import { openResource } from '@/dstu/openResource';
import { dstu } from '@/dstu/api';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  isRuntimeRootBlockedError,
  openToolPermissionSettings,
} from '../utils/runtimeRootNavigation';
import { blocksToSourceBundle } from './panels/sourceAdapter';
import { computeLineDiff } from '../utils/lineDiff';
import type { Block } from '../core/types/block';
import {
  listRuntimeDirectory,
  listTaskBrowserDownloads,
  type RuntimeDirectoryPage,
} from '../api/taskWorkspaceApi';
import type { BrowserDownloadObservation } from '@/features/browser/types';

// ============================================================================
// Inline types & helpers
// ============================================================================

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

interface Step {
  id: string;
  description: string;
  status: StepStatus;
  result?: string;
  createdAt: number;
  updatedAt?: number;
}

interface TodoOutput {
  success: boolean;
  todoListId?: string;
  title?: string;
  steps?: Step[];
  isAllDone?: boolean;
  message?: string;
}

const TODO_TOOL_SET = new Set([
  'todo_init', 'todo_update', 'todo_add', 'todo_get',
  'builtin-todo_init', 'builtin-todo_update', 'builtin-todo_add', 'builtin-todo_get',
]);

function isTodo(block: { toolName?: string }) {
  return typeof block.toolName === 'string' ? TODO_TOOL_SET.has(block.toolName) : false;
}

function extractSteps(blocks: { toolOutput?: unknown; toolName?: string }[]) {
  let steps: Step[] = [];
  let title: string | undefined;
  let isAllDone: boolean | undefined;
  let message: string | undefined;
  for (const b of blocks) {
    const out = b.toolOutput as TodoOutput | { result?: TodoOutput } | undefined;
    if (!out) continue;
    const d = (out as { result?: TodoOutput }).result || (out as TodoOutput);
    if (d.steps?.length) { steps = d.steps; title = d.title || title; isAllDone = d.isAllDone; message = d.message; }
    else if (d.title) title = d.title;
    if (d.isAllDone !== undefined) isAllDone = d.isAllDone;
    if (d.message) message = d.message;
  }
  return { steps, title, isAllDone, message };
}

// ============================================================================
// 来源 & 产物提取
// ============================================================================

interface SourceItem {
  id: string;
  title: string;
  url?: string;
  resourceId?: string;
  origin: string;
}

interface ArtifactItem {
  id: string;
  kind: 'note' | 'file';
  label: string;
  toolName: string;
}

type ChangeAction = 'create' | 'update' | 'delete' | 'append' | 'write';
type ChangeKind = 'note' | 'file' | 'document';

interface ChangeItem {
  id: string;
  kind: ChangeKind;
  action: ChangeAction;
  label: string;
  target?: string;
  toolName: string;
  openId?: string;
  /** runtime root id（来自 file_change_summary，可用于 reveal/撤销） */
  rootId?: string;
  /** root 内相对路径（来自 file_change_summary） */
  relativePath?: string;
  /** 覆盖写时旧内容在 temp 根备份区的相对引用（撤销时恢复、预览时做 diff） */
  backupRef?: string;
  /** 写入完成后的内容哈希；撤销时用于阻止覆盖用户的后续修改 */
  afterHash?: string;
  /** workspace_file_* 返回的完整、hash-bound mutation receipt */
  receipt?: Record<string, unknown>;
}

interface ChangeCoverageIssue {
  id: string;
  label: string;
  detail?: string;
}

/** Changes 内联预览的加载态（当前内容 + 可选备份旧内容） */
interface ChangePreviewState {
  loading: boolean;
  error?: string;
  content?: string;
  truncated?: boolean;
  backupContent?: string;
}

interface RuntimeFilePreview {
  content: string;
  truncated: boolean;
}

type RuntimeAction = 'list' | 'read' | 'write' | 'check' | 'blocked';

interface RuntimeItem {
  id: string;
  action: RuntimeAction;
  rootId: string;
  label: string;
  detail?: string;
  error?: string;
  toolName: string;
}

interface RuntimeEnvironment {
  rootId?: string;
  rootLabel?: string;
  cwd?: string;
  sandboxBackend?: string;
  platform?: string;
  networkAllowed?: boolean;
}

const ORIGIN_ICONS: Record<string, Icon> = {
  web_search: Globe,
  memory: Brain,
  rag: BookOpen,
  multimodal: BookOpen,
  tool: MagnifyingGlass,
};

/** 可一键转存为笔记的文本产物扩展名（Changes 区「存为笔记」入口） */
const NOTE_SAVABLE_EXTENSION_RE = /\.(md|markdown|txt)$/i;
/** 转存笔记时读取产物的上限（512KB，超出则截断保存并提示） */
const SAVE_AS_NOTE_MAX_BYTES = 512 * 1024;

/** 笔记写入类工具（产生/修改笔记，视为产物） */
const NOTE_WRITE_TOOLS = new Set([
  'note_create', 'note_append', 'note_replace', 'note_set',
  'builtin-note_create', 'builtin-note_append', 'builtin-note_replace', 'builtin-note_set',
]);

/** 文件生成类工具名后缀（docx/xlsx/pptx 创建编辑 + 论文保存） */
function isFileProducingTool(toolName: string): boolean {
  const short = toolName.replace('builtin-', '');
  return (
    short.startsWith('docx_') ||
    short.startsWith('xlsx_') ||
    short.startsWith('pptx_') ||
    short === 'paper_save'
  );
}

function fileArtifactIcon(toolName: string): Icon {
  const short = toolName.replace('builtin-', '');
  if (short.startsWith('docx_')) return FileDoc;
  if (short.startsWith('xlsx_')) return FileXls;
  if (short.startsWith('pptx_')) return FilePpt;
  if (short === 'paper_save') return FilePdf;
  return FileIcon;
}

function unwrapToolData(output: unknown): Record<string, unknown> {
  const out = (output ?? {}) as Record<string, unknown>;
  return (typeof out.result === 'object' && out.result !== null
    ? out.result
    : out) as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function normalizeToolName(toolName: string): string {
  return toolName
    .replace(/^builtin-/, '')
    .replace(/^mcp_/, '')
    .replace(/^mcp\.tools\./, '');
}

function inferChangeActionFromOp(op: unknown): ChangeAction | undefined {
  if (typeof op !== 'string') return undefined;
  const normalized = op.toLowerCase();
  if (normalized === 'created' || normalized === 'create') return 'create';
  if (normalized === 'modified' || normalized === 'updated' || normalized === 'update') return 'update';
  if (normalized === 'deleted' || normalized === 'delete') return 'delete';
  if (normalized === 'appended' || normalized === 'append') return 'append';
  if (normalized === 'written' || normalized === 'write') return 'write';
  return undefined;
}

function inferChangeAction(toolName: string): ChangeAction | undefined {
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

/** 从成功的工具块中提取产物（笔记 + 生成文件） */
function extractArtifacts(blocks: Block[]): ArtifactItem[] {
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

/** 从成功工具块中提取写入/修改摘要。 */
function extractChanges(blocks: Block[]): ChangeItem[] {
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

/** 从文件 runtime 工具块中提取读/列目录/写入/拦截事实，展示在任务面板内。 */
function extractRuntimeItems(blocks: Block[]): RuntimeItem[] {
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
    const relativePath = firstString(
      data.relative_path,
      data.path,
      short === 'local_shell_preflight' ? data.command : undefined,
      short === 'local_shell_execute' ? data.command : undefined,
      firstFileManagerChange?.destination_path,
      firstFileManagerChange?.relative_path,
      input.path,
      short === 'local_shell_preflight' ? input.command : undefined,
      short === 'local_shell_execute' ? input.command : undefined,
    ) ?? '.';

    let detail: string | undefined;
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

    const id = `${action}:${rootId}:${relativePath}:${toolName}`;
    runtime.set(id, {
      id,
      action,
      rootId,
      label: relativePath,
      detail,
      error,
      toolName,
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
function extractRuntimeEnvironment(blocks: Block[]): RuntimeEnvironment | null {
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

/** 从成功块中提取来源（复用 sourceAdapter 的解析逻辑），按 title+url 去重 */
function extractSources(blocks: Block[]): SourceItem[] {
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
// StatusDot
// ============================================================================

const StatusDot: React.FC<{ status: StepStatus; index: number }> = ({ status, index }) => {
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-[color:hsl(var(--primary))] text-[color:hsl(var(--primary-foreground))] text-[10px] font-bold flex-shrink-0">
          {index + 1}
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:hsl(var(--success))]">
          <Check size={14} weight="bold" />
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:hsl(var(--destructive))]">
          <X size={13} weight="bold" />
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full flex-shrink-0 text-[color:var(--text-muted)]">
          <SkipForward size={12} />
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border border-[color:var(--border-soft)] flex-shrink-0" />
      );
  }
};

// ============================================================================
// Section label
// ============================================================================

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)] select-none">
    {children}
  </div>
);

// ============================================================================
// AgentTaskPanel
// ============================================================================

interface Props {
  store: any;
  className?: string;
}

export const AgentTaskPanel: React.FC<Props> = ({ store, className }) => {
  const { t } = useTranslation('chatV2');
  const [expanded, setExpanded] = useState(false);
  const [runtimeExpanded, setRuntimeExpanded] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  const blocksMap = useStore(store, (s: any) => s.blocks) as Map<string, any> | undefined;
  const sessionId = useStore(store, (s: any) => s.sessionId) as string | undefined;
  const [revertedIds, setRevertedIds] = useState<Set<string>>(new Set());
  // 「存为笔记」转化状态：changeId → 已创建的笔记 id（组件内即可，无需持久化）
  const [savedNoteIds, setSavedNoteIds] = useState<Map<string, string>>(new Map());
  const [savingNoteIds, setSavingNoteIds] = useState<Set<string>>(new Set());
  const [previewChangeId, setPreviewChangeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChangePreviewState | null>(null);
  const [workspacePage, setWorkspacePage] = useState<RuntimeDirectoryPage | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [browserDownloads, setBrowserDownloads] = useState<BrowserDownloadObservation[]>([]);
  // 防止快速切换预览目标时，先发出的慢请求覆盖后发出的快请求结果
  const previewRequestRef = useRef<string | null>(null);

  const loadWorkspacePage = useCallback(async (
    relativePath = '',
    cursor?: string,
    append = false,
  ) => {
    if (!sessionId) return;
    setWorkspaceLoading(true);
    try {
      const page = await listRuntimeDirectory({
        sessionId,
        rootId: 'workspace',
        relativePath,
        cursor,
        limit: 40,
      });
      setWorkspacePage((previous) => append && previous
        ? { ...page, entries: [...previous.entries, ...page.entries] }
        : page);
    } catch {
      setWorkspacePage(null);
    } finally {
      setWorkspaceLoading(false);
    }
  }, [sessionId]);

  const { steps, title, isAllDone, message } = useMemo(() => {
    const out: { toolOutput?: unknown; toolName?: string }[] = [];
    blocksMap?.forEach((b) => { if (isTodo(b)) out.push(b); });
    return extractSteps(out);
  }, [blocksMap]);

  // 廉价存在性检查：即使没有 todo 计划，只要用了本地 runtime 工具面板也要出现
  //（只比较 toolName 字符串，流式期间每帧代价可忽略）
  const hasRuntimeActivity = useMemo(() => {
    if (!blocksMap) return false;
    let found = false;
    blocksMap.forEach((b: any) => {
      if (found) return;
      if (typeof b?.toolName === 'string') {
        const short = normalizeToolName(b.toolName);
        if (isRuntimeTool(b.toolName) || short === 'browser_downloads' || short === 'browser_file_upload') {
          found = true;
        }
      }
    });
    return found;
  }, [blocksMap]);

  // 来源 + 产物（仅在面板展开时才提取：折叠态不展示这两个区，
  // 流式期间 blocksMap 每帧变化，无谓的全量重算会被跳过）
  const { sources, artifacts } = useMemo(() => {
    if (!expanded || !blocksMap) return { sources: [], artifacts: [] };
    const all: Block[] = [];
    blocksMap.forEach((b) => all.push(b));
    return {
      sources: extractSources(all),
      artifacts: extractArtifacts(all),
    };
  }, [blocksMap, expanded]);

  const changes = useMemo(() => {
    if (!expanded || !blocksMap) return [];
    const all: Block[] = [];
    blocksMap.forEach((b) => all.push(b));
    return extractChanges(all);
  }, [blocksMap, expanded]);

  const changeCoverageIssues = useMemo(() => {
    if (!expanded || !blocksMap) return [];
    const all: Block[] = [];
    blocksMap.forEach((b) => all.push(b));
    return extractChangeCoverageIssues(all);
  }, [blocksMap, expanded]);

  const runtimeItems = useMemo(() => {
    if (!expanded || !blocksMap) return [];
    const all: Block[] = [];
    blocksMap.forEach((b) => all.push(b));
    return extractRuntimeItems(all);
  }, [blocksMap, expanded]);

  const runtimeEnvironment = useMemo(() => {
    if (!expanded || !blocksMap) return null;
    const all: Block[] = [];
    blocksMap.forEach((b) => all.push(b));
    return extractRuntimeEnvironment(all);
  }, [blocksMap, expanded]);

  const done = steps.filter((s) => s.status === 'completed').length;
  const total = steps.length;
  const running = steps.find((s) => s.status === 'running');
  const has = steps.length > 0;
  const streaming = useStore(store, (s: any) => s.activeBlockIds?.size > 0) ?? false;

  useEffect(() => {
    if (!expanded || !sessionId || (has && isAllDone !== true)) return;
    void loadWorkspacePage();
    void listTaskBrowserDownloads(sessionId)
      .then(setBrowserDownloads)
      .catch(() => setBrowserDownloads([]));
  }, [expanded, has, isAllDone, loadWorkspacePage, sessionId]);

  const openSource = useCallback((item: SourceItem) => {
    if (item.url && (item.url.startsWith('http://') || item.url.startsWith('https://'))) {
      void openUrl(item.url);
    } else if (item.resourceId) {
      void openResource(`/${item.resourceId}`, { handlerNamespace: 'chat-v2' });
    }
  }, []);

  const openArtifact = useCallback((item: ArtifactItem) => {
    if (item.kind === 'note') {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
        detail: { noteId: item.id, source: 'agent_task_panel' },
      }));
    } else {
      void openResource(`/${item.id}`, { handlerNamespace: 'chat-v2' });
    }
  }, []);

  /** 在系统文件管理器中定位 runtime root 内的文件（artifacts/workspace 等）。 */
  const revealRuntimeFile = useCallback(async (item: ChangeItem) => {
    if (!sessionId || !item.rootId || !item.relativePath) return;
    try {
      const absolutePath = await invoke<string>('chat_v2_resolve_runtime_path', {
        sessionId,
        rootId: item.rootId,
        relativePath: item.relativePath,
      });
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(absolutePath);
    } catch (error: unknown) {
      showGlobalNotification(
        'warning',
        t('agentPanel.revealFailed'),
        getErrorMessage(error),
      );
    }
  }, [sessionId, t]);

  const revealResultFile = useCallback(async (rootId: string, relativePath: string) => {
    if (!sessionId) return;
    try {
      const absolutePath = await invoke<string>('chat_v2_resolve_runtime_path', {
        sessionId,
        rootId,
        relativePath,
      });
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(absolutePath);
    } catch (error: unknown) {
      showGlobalNotification('warning', t('agentPanel.revealFailed'), getErrorMessage(error));
    }
  }, [sessionId, t]);

  const openWorkspaceParent = useCallback(() => {
    const current = workspacePage?.relativePath ?? '';
    const parent = current.split('/').filter(Boolean).slice(0, -1).join('/');
    void loadWorkspacePage(parent);
  }, [loadWorkspacePage, workspacePage?.relativePath]);

  const closePreview = useCallback(() => {
    previewRequestRef.current = null;
    setPreviewChangeId(null);
    setPreview(null);
  }, []);

  /** 内联预览：读当前文件内容；覆盖写还会读 temp 备份区旧内容用于行级 diff。 */
  const togglePreview = useCallback(async (item: ChangeItem) => {
    if (previewChangeId === item.id) {
      closePreview();
      return;
    }
    if (!sessionId || !item.rootId || !item.relativePath) return;
    previewRequestRef.current = item.id;
    setPreviewChangeId(item.id);
    setPreview({ loading: true });
    try {
      const current = await invoke<RuntimeFilePreview>('chat_v2_read_runtime_file', {
        sessionId,
        rootId: item.rootId,
        relativePath: item.relativePath,
      });
      let backupContent: string | undefined;
      if (item.backupRef) {
        const backup = await invoke<RuntimeFilePreview>('chat_v2_read_runtime_file', {
          sessionId,
          rootId: 'temp',
          relativePath: item.backupRef,
        });
        backupContent = backup.content;
      }
      if (previewRequestRef.current !== item.id) return;
      setPreview({
        loading: false,
        content: current.content,
        truncated: current.truncated,
        backupContent,
      });
    } catch (error: unknown) {
      if (previewRequestRef.current !== item.id) return;
      setPreview({ loading: false, error: getErrorMessage(error) });
    }
  }, [previewChangeId, sessionId, closePreview]);

  // 撤销请求进行中的 changeId 集合（ref 同步拦截双击重复 invoke）
  const revertingIdsRef = useRef<Set<string>>(new Set());

  /** 真实撤销：artifacts 走写备份；workspace 走 hash-bound mutation receipt。 */
  const revertRuntimeChange = useCallback(async (item: ChangeItem) => {
    if (!sessionId || !item.relativePath) return;
    if (revertingIdsRef.current.has(item.id)) return;
    revertingIdsRef.current.add(item.id);
    try {
      if (item.rootId === 'workspace' && item.receipt) {
        await invoke('chat_v2_revert_workspace_change', {
          sessionId,
          receipt: item.receipt,
        });
      } else if (item.rootId === 'artifacts' && item.afterHash) {
        await invoke('chat_v2_revert_artifact_write', {
          sessionId,
          relativePath: item.relativePath,
          backupRef: item.backupRef ?? null,
          expectedAfterHash: item.afterHash,
        });
      } else {
        return;
      }
      setRevertedIds((prev) => {
        const next = new Set(prev);
        next.add(item.id);
        return next;
      });
      // 撤销后文件内容已变化，预览若正开着则关闭，避免展示过期内容
      if (previewRequestRef.current === item.id) {
        closePreview();
      }
      showGlobalNotification(
        'success',
        item.rootId === 'workspace'
          ? t('agentPanel.revertWorkspaceDone')
          : item.backupRef
            ? t('agentPanel.restoreDone')
            : t('agentPanel.revertDone'),
      );
    } catch (error: unknown) {
      showGlobalNotification(
        'error',
        t('agentPanel.revertFailed'),
        getErrorMessage(error),
      );
    } finally {
      revertingIdsRef.current.delete(item.id);
    }
  }, [sessionId, t, closePreview]);

  // 转存笔记进行中的 changeId 集合（ref 同步拦截：state 更新异步，双击会重复建笔记）
  const savingNoteIdsRef = useRef<Set<string>>(new Set());

  /** 把 artifacts 根内的文本产物转存为 DSTU 笔记，让产物流入学习资产库。 */
  const saveChangeAsNote = useCallback(async (item: ChangeItem) => {
    if (!sessionId || !item.relativePath || item.rootId !== 'artifacts') return;
    if (savedNoteIds.has(item.id) || savingNoteIds.has(item.id)) return;
    if (savingNoteIdsRef.current.has(item.id)) return;
    savingNoteIdsRef.current.add(item.id);
    setSavingNoteIds((prev) => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    try {
      const file = await invoke<RuntimeFilePreview>('chat_v2_read_runtime_file', {
        sessionId,
        rootId: item.rootId,
        relativePath: item.relativePath,
        maxBytes: SAVE_AS_NOTE_MAX_BYTES,
      });
      const fileName = item.relativePath.split(/[\\/]/).pop() || item.label;
      const title = fileName.replace(NOTE_SAVABLE_EXTENSION_RE, '') || fileName;
      const result = await dstu.create('/', {
        type: 'note',
        name: title,
        content: file.content,
        metadata: { tags: [] },
      });
      if (!result.ok) {
        throw result.error;
      }
      setSavedNoteIds((prev) => {
        const next = new Map(prev);
        next.set(item.id, result.value.id);
        return next;
      });
      if (file.truncated) {
        showGlobalNotification(
          'warning',
          t('agentPanel.saveAsNoteTruncated'),
        );
      }
    } catch (error: unknown) {
      showGlobalNotification(
        'error',
        t('agentPanel.saveAsNoteFailed'),
        getErrorMessage(error),
      );
    } finally {
      savingNoteIdsRef.current.delete(item.id);
      setSavingNoteIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  }, [sessionId, savedNoteIds, savingNoteIds, t]);

  const openSavedNote = useCallback((noteId: string) => {
    window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
      detail: { noteId, source: 'agent_task_panel_changes' },
    }));
  }, []);

  const openChange = useCallback((item: ChangeItem) => {
    if (item.openId) {
      if (item.kind === 'note') {
        window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
          detail: { noteId: item.openId, source: 'agent_task_panel_changes' },
        }));
      } else if (item.kind === 'file') {
        void openResource(`/${item.openId}`, { handlerNamespace: 'chat-v2' });
      }
      return;
    }
    // runtime 文件变更没有内部资源 id，直接在文件管理器中定位
    if (item.rootId && item.relativePath) {
      void revealRuntimeFile(item);
    }
  }, [revealRuntimeFile]);

  // Auto-expand when a NEW running step appears.
  // 只在「进入 running 的步骤发生变化」时展开一次：原实现把 expanded 放进条件里，
  // 用户在步骤仍在 running 时手动折叠会被立刻重新展开，面板收不起来。
  const lastAutoExpandStepRef = useRef<string | null>(null);
  useEffect(() => {
    if (!has || !streaming) return;
    const runningStep = steps.find((s) => s.status === 'running');
    if (!runningStep) return;
    const stepKey = runningStep.id || runningStep.description;
    if (lastAutoExpandStepRef.current === stepKey) return;
    lastAutoExpandStepRef.current = stepKey;
    setExpanded(true);
  }, [has, streaming, steps]);

  const previewChange = previewChangeId
    ? changes.find((c) => c.id === previewChangeId)
    : undefined;
  const previewDiffLines = useMemo(() => {
    if (!preview || preview.loading || preview.error) return null;
    if (preview.backupContent === undefined) return null;
    return computeLineDiff(preview.backupContent, preview.content ?? '');
  }, [preview]);

  if (!has && !hasRuntimeActivity) return null;

  const showSources = sources.length > 0;
  const showArtifacts = artifacts.length > 0;
  const showChanges = changes.length > 0 || changeCoverageIssues.length > 0;
  const showRuntime = runtimeItems.length > 0;
  const showWorkspaceResults = workspacePage !== null;
  const showBrowserDownloads = browserDownloads.length > 0;
  const showSections = showSources || showArtifacts || showChanges || showRuntime
    || showWorkspaceResults || showBrowserDownloads;
  const runtimeBoundary = runtimeEnvironment
    ? [runtimeEnvironment.rootLabel || runtimeEnvironment.rootId, runtimeEnvironment.cwd !== '.' ? runtimeEnvironment.cwd : undefined]
      .filter(Boolean)
      .join(' / ')
    : '';

  const changeActionLabel = (action: ChangeAction) =>
    t(`agentPanel.changeActions.${action}`);

  const runtimeActionLabel = (action: RuntimeAction) =>
    t(`agentPanel.runtimeActions.${action}`);

  return (
    <div ref={ref} className={cn('w-full px-4 md:px-8 flex-shrink-0 pb-0', className)}>
      <div className="mx-auto max-w-[var(--chat-thread-max-w)]">

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            Collapsed pill / Expanded header bar
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {!expanded && (
          <div
            className={cn(
              'flex w-fit items-center gap-2 h-7 px-2.5',
              'rounded-[var(--radius-shell-control)]',
              'transition-all duration-200 ease-out',
              'bg-transparent hover:bg-[color:var(--interactive-hover)]',
            )}
          >
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(true)}
              aria-expanded={false}
              className="!h-auto !p-0.5 !gap-1.5 !text-xs !font-medium !text-[color:var(--text-secondary)] hover:!text-[color:var(--text-primary)] !border-none !bg-transparent !shadow-none"
            >
              {has ? (
                <ListChecks size={12} className="text-[color:hsl(var(--primary))]" weight="fill" />
              ) : (
                <Terminal size={12} className="text-[color:hsl(var(--primary))]" weight="fill" />
              )}
              <span className="truncate max-w-[180px]">
                {running
                  ? running.description
                  : title || (has ? t('agentPanel.plan') : t('agentPanel.environment'))}
              </span>
              <CaretDown size={10} className="text-[color:var(--text-muted)]" />
            </NotionButton>

            {has && (
              <span className="text-[10px] tabular-nums text-[color:var(--text-muted)] font-medium min-w-[2em] text-right">
                {done}/{total}
              </span>
            )}
          </div>
        )}

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            Expanded panel: plan / sources / artifacts / summary
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
              data-wb-blur-surface
              className={cn(
                'mt-1',
                'w-full overflow-hidden',
                'rounded-[var(--radius-shell-toolbar)]',
                'border border-[color:var(--composer-panel-border)]',
                'bg-[color:var(--composer-panel-surface)]',
                'shadow-[var(--composer-panel-shadow)]',
                'backdrop-blur-[18px] saturate-[140%]',
              )}
            >
              <div className="flex items-center gap-2 px-4 py-2.5">
                {has ? (
                  <ListChecks size={15} className="text-[color:hsl(var(--primary))] flex-shrink-0" />
                ) : (
                  <Terminal size={15} className="text-[color:hsl(var(--primary))] flex-shrink-0" />
                )}
                <span className="text-sm font-semibold text-[color:var(--text-primary)] truncate flex-1 min-w-0">
                  {title || (has ? t('agentPanel.plan') : t('agentPanel.environment'))}
                </span>
                {has && (
                  <span className="text-[11px] tabular-nums text-[color:var(--text-muted)] flex-shrink-0">
                    {done}/{total}
                  </span>
                )}
                <NotionButton
                  variant="ghost"
                  onClick={() => setExpanded(false)}
                  className="!h-auto !min-w-0 !p-1 !gap-0 !border-none !bg-transparent !shadow-none text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                  aria-label={t('agentPanel.collapsePanel')}
                  aria-expanded={true}
                >
                  <CaretUp size={10} />
                </NotionButton>
              </div>
              <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />

              {/* ── 区 1：计划（无 todo 计划时整区隐藏，Runtime/Changes 仍可见） ── */}
              {has && showSections && (
                <SectionLabel>{t('agentPanel.plan')}</SectionLabel>
              )}
              {has && (
              <div className="py-1 max-h-[260px] overflow-y-auto">
                {steps.map((step, idx) => (
                  <div
                    key={step.id || idx}
                    className={cn(
                      'flex items-start gap-2.5 mx-1 px-3 py-[7px] rounded-[10px]',
                      'transition-colors duration-100',
                      'hover:bg-[color:var(--interactive-hover)]',
                    )}
                  >
                    <StatusDot status={step.status} index={idx} />
                    <div className="flex-1 min-w-0">
                      <span
                        className={cn(
                          'block text-[13px] leading-snug',
                          step.status === 'completed' && 'line-through text-[color:hsl(var(--success))] opacity-70',
                          step.status === 'running' && 'text-[color:var(--text-primary)] font-medium',
                          step.status === 'failed' && 'text-[color:hsl(var(--destructive))]',
                          step.status === 'skipped' && 'text-[color:var(--text-muted)] line-through',
                          step.status === 'pending' && 'text-[color:var(--text-muted)]',
                        )}
                      >
                        {step.description}
                      </span>
                      {step.status === 'failed' && step.result && (
                        <span className="block text-[11px] text-[color:hsl(var(--destructive))] opacity-60 mt-0.5">
                          {step.result}
                        </span>
                      )}
                    </div>
                    {step.status === 'running' && (
                      <CircleNotch size={13} className="animate-spin text-[color:hsl(var(--primary))] flex-shrink-0 mt-[3px]" />
                    )}
                  </div>
                ))}
              </div>
              )}

              {/* ── 区 2：来源 ── */}
              {showSources && (
                <>
                  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
                  <SectionLabel>
                    {t('agentPanel.sources')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">{sources.length}</span>
                  </SectionLabel>
                  {/* 容器本身可滚动，渲染全部来源，保证与计数一致 */}
                  <div className="flex flex-wrap gap-1.5 px-4 pb-2 max-h-[96px] overflow-y-auto">
                    {sources.map((item) => {
                      const OriginIcon = ORIGIN_ICONS[item.origin] ?? MagnifyingGlass;
                      const clickable = !!(item.url || item.resourceId);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => clickable && openSource(item)}
                          className={cn(
                            'inline-flex items-center gap-1.5 h-6 px-2 max-w-[220px]',
                            'rounded-full border border-[color:var(--border-soft)]',
                            'bg-transparent text-[11px] text-[color:var(--text-secondary)]',
                            clickable
                              ? 'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--text-primary)] cursor-pointer'
                              : 'cursor-default opacity-70',
                          )}
                          title={item.title}
                        >
                          <OriginIcon size={11} className="flex-shrink-0 text-[color:var(--text-muted)]" />
                          <span className="truncate">{item.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {/* ── Runtime：Codex 式环境状态行 + 可展开本地活动 ── */}
              {showRuntime && (
                <>
                  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
                  <div className="px-2 py-1">
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={() => setRuntimeExpanded((value) => !value)}
                      className={cn(
                        '!flex !h-auto !w-full !min-w-0 !items-center !justify-start !gap-2 rounded-[6px] !px-2 !py-2 text-left',
                        'text-[13px] text-[color:var(--text-primary)] transition-colors',
                        '!border-none !bg-transparent !shadow-none hover:!bg-[color:var(--interactive-hover)]',
                      )}
                      aria-expanded={runtimeExpanded}
                    >
                      <Terminal size={14} className="shrink-0 text-[color:var(--text-secondary)]" />
                      <span className="font-medium">{t('agentPanel.local')}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-[color:var(--text-muted)]">
                        {runtimeItems.some((item) => item.action === 'blocked') && (
                          <span className="text-[color:hsl(var(--destructive))]">
                            {t('agentPanel.blockedCount', {
                              count: runtimeItems.filter((item) => item.action === 'blocked').length,
                            })}
                          </span>
                        )}
                        <span>{t('agentPanel.activityCount', { count: runtimeItems.length })}</span>
                        {runtimeExpanded ? <CaretUp size={11} /> : <CaretDown size={11} />}
                      </span>
                    </NotionButton>

                    <AnimatePresence initial={false}>
                      {runtimeExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.14, ease: 'easeOut' }}
                          className="overflow-hidden"
                        >
                          <div className="ml-6 max-h-[220px] overflow-y-auto border-l border-[color:var(--border-soft)] py-1 pl-2">
                            {runtimeEnvironment && (
                              <div className="mb-1 border-b border-[color:var(--border-soft)] pb-1">
                                {runtimeBoundary && (
                                  <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-[11px]">
                                    <FolderOpen size={12} className="shrink-0 text-[color:var(--text-muted)]" />
                                    <span className="shrink-0 text-[color:var(--text-secondary)]">
                                      {t('agentPanel.environmentBoundary')}
                                    </span>
                                    <code className="min-w-0 truncate font-mono text-[color:var(--text-primary)]" title={runtimeBoundary}>
                                      {runtimeBoundary}
                                    </code>
                                  </div>
                                )}
                                {runtimeEnvironment.sandboxBackend && (
                                  <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-[11px]">
                                    <Terminal size={12} className="shrink-0 text-[color:var(--text-muted)]" />
                                    <span className="shrink-0 text-[color:var(--text-secondary)]">
                                      {t('agentPanel.sandbox')}
                                    </span>
                                    <code className="min-w-0 truncate font-mono text-[color:var(--text-primary)]">
                                      {runtimeEnvironment.sandboxBackend}
                                    </code>
                                    {runtimeEnvironment.platform && (
                                      <span className="shrink-0 text-[color:var(--text-muted)]">{runtimeEnvironment.platform}</span>
                                    )}
                                  </div>
                                )}
                                {runtimeEnvironment.networkAllowed !== undefined && (
                                  <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-[11px]">
                                    <Globe size={12} className="shrink-0 text-[color:var(--text-muted)]" />
                                    <span className="shrink-0 text-[color:var(--text-secondary)]">
                                      {t('agentPanel.network')}
                                    </span>
                                    <span className={runtimeEnvironment.networkAllowed
                                      ? 'text-[color:var(--text-primary)]'
                                      : 'text-[color:var(--text-muted)]'}>
                                      {runtimeEnvironment.networkAllowed
                                        ? t('agentPanel.networkEnabled')
                                        : t('agentPanel.networkDisabled')}
                                    </span>
                                  </div>
                                )}
                                <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium text-[color:var(--text-muted)]">
                                  {t('agentPanel.recentActivity', {
                                    count: runtimeItems.length,
                                  })}
                                </div>
                              </div>
                            )}
                            {runtimeItems.map((item) => {
                              const runtimeShortName = normalizeToolName(item.toolName);
                              const RuntimeIcon = runtimeShortName === 'local_shell_preflight' || runtimeShortName === 'local_shell_execute'
                                ? Terminal
                                : FileIcon;
                              const canJumpToSettings = item.action === 'blocked' && isRuntimeRootBlockedError(item.error);
                              const content = (
                                <>
                                  {item.action === 'blocked' ? (
                                    <X size={12} className="mt-0.5 shrink-0 text-[color:hsl(var(--destructive))]" />
                                  ) : (
                                    <RuntimeIcon size={12} className="mt-0.5 shrink-0 text-[color:var(--text-muted)]" />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <div className="flex min-w-0 items-center gap-2">
                                      <span className={cn(
                                        'shrink-0 text-[11px] font-medium',
                                        item.action === 'blocked'
                                          ? 'text-[color:hsl(var(--destructive))]'
                                          : 'text-[color:var(--text-secondary)]',
                                      )}>
                                        {runtimeActionLabel(item.action)}
                                      </span>
                                      <span className="min-w-0 truncate font-mono text-[11px] text-[color:var(--text-primary)]">
                                        {item.label}
                                      </span>
                                    </div>
                                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-[color:var(--text-muted)]">
                                      {item.rootId !== runtimeEnvironment?.rootId && (
                                        <code className="shrink-0 font-mono">{item.rootId}</code>
                                      )}
                                      {item.detail && <span className="truncate">{item.detail}</span>}
                                    </div>
                                  </div>
                                  {canJumpToSettings && <ArrowSquareOut size={11} className="shrink-0 text-[color:var(--text-muted)]" />}
                                </>
                              );

                              if (canJumpToSettings) {
                                return (
                                  <NotionButton
                                    key={item.id}
                                    variant="ghost"
                                    size="sm"
                                    onClick={openToolPermissionSettings}
                                    className="!flex !h-auto !w-full !min-w-0 !items-start !justify-start !gap-2 rounded-[5px] !border-none !bg-transparent !px-2 !py-1.5 text-left !shadow-none hover:!bg-[color:var(--interactive-hover)]"
                                    title={`${item.error || item.label} — ${t('agentPanel.goAuthorize')}`}
                                  >
                                    {content}
                                  </NotionButton>
                                );
                              }

                              return (
                                <div
                                  key={item.id}
                                  className="flex min-w-0 items-start gap-2 rounded-[5px] px-2 py-1.5"
                                  title={item.error || item.detail || `${item.rootId}:${item.label}`}
                                >
                                  {content}
                                </div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </>
              )}

              {showWorkspaceResults && workspacePage && (
                <>
                  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
                  <SectionLabel>
                    {t('agentPanel.workspaceFiles')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">
                      {workspacePage.entries.length}{workspacePage.truncated ? '+' : ''}
                    </span>
                  </SectionLabel>
                  <div className="px-4 pb-2">
                    <div className="flex min-w-0 items-center gap-1 px-2 pb-1 text-[10px] text-[color:var(--text-muted)]">
                      {workspacePage.relativePath && (
                        <button type="button" onClick={openWorkspaceParent} className="shrink-0 hover:text-[color:var(--text-primary)]">
                          .. /
                        </button>
                      )}
                      <span className="truncate font-mono">{workspacePage.relativePath || '/'}</span>
                    </div>
                    <div className="max-h-[144px] overflow-y-auto">
                      {workspacePage.entries.map((entry) => {
                        const isDirectory = entry.kind === 'directory';
                        return (
                          <button
                            key={`${entry.kind}:${entry.relativePath}`}
                            type="button"
                            onClick={() => isDirectory
                              ? void loadWorkspacePage(entry.relativePath)
                              : void revealResultFile('workspace', entry.relativePath)}
                            className="flex h-7 w-full min-w-0 items-center gap-2 rounded-[5px] px-2 text-left text-[11px] hover:bg-[color:var(--interactive-hover)]"
                            title={entry.relativePath}
                          >
                            {isDirectory ? <FolderOpen size={12} /> : <FileIcon size={12} />}
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            {entry.sizeBytes != null && (
                              <span className="shrink-0 text-[10px] text-[color:var(--text-muted)]">{entry.sizeBytes} B</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {workspacePage.nextCursor && (
                      <button
                        type="button"
                        disabled={workspaceLoading}
                        onClick={() => void loadWorkspacePage(
                          workspacePage.relativePath,
                          workspacePage.nextCursor ?? undefined,
                          true,
                        )}
                        className="mt-1 px-2 text-[10px] text-[color:hsl(var(--primary))] disabled:opacity-50"
                      >
                        {workspaceLoading
                          ? t('agentPanel.loadingFiles')
                          : t('agentPanel.loadMoreFiles')}
                      </button>
                    )}
                    {workspacePage.truncated && !workspacePage.nextCursor && (
                      <div className="px-2 pt-1 text-[10px] text-[color:var(--text-muted)]">
                        {t('agentPanel.fileTreeTruncated')}
                      </div>
                    )}
                  </div>
                </>
              )}

              {showBrowserDownloads && (
                <>
                  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
                  <SectionLabel>
                    {t('agentPanel.browserDownloads')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">{browserDownloads.length}</span>
                  </SectionLabel>
                  <div className="max-h-[112px] overflow-y-auto px-4 pb-2">
                    {browserDownloads.map((download) => (
                      <button
                        key={download.id}
                        type="button"
                        disabled={download.state !== 'completed'}
                        onClick={() => void revealResultFile(download.rootId, download.relativePath)}
                        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-[5px] px-2 text-left text-[11px] hover:bg-[color:var(--interactive-hover)] disabled:cursor-default disabled:opacity-60"
                        title={download.locator}
                      >
                        <DownloadSimple size={12} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{download.filename}</span>
                        <span className="shrink-0 text-[10px] text-[color:var(--text-muted)]">{download.state}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* ── 区 3：产物 ── */}
              {showArtifacts && (
                <>
                  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
                  <SectionLabel>
                    {t('agentPanel.artifacts')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">{artifacts.length}</span>
                  </SectionLabel>
                  <div className="flex flex-wrap gap-1.5 px-4 pb-2 max-h-[96px] overflow-y-auto">
                    {artifacts.map((item) => {
                      const ArtifactIcon = item.kind === 'note' ? Notebook : fileArtifactIcon(item.toolName);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => openArtifact(item)}
                          className={cn(
                            'inline-flex items-center gap-1.5 h-6 px-2 max-w-[220px]',
                            'rounded-full border border-[color:var(--border-soft)]',
                            'bg-transparent text-[11px] text-[color:var(--text-secondary)]',
                            'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--text-primary)] cursor-pointer',
                          )}
                          title={item.label}
                        >
                          <ArtifactIcon size={11} className="flex-shrink-0 text-[color:hsl(var(--primary))]" />
                          <span className="truncate">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}

              {/* ── 区 4：摘要 ── */}
              {showChanges && (
                <>
                  <div className="h-px bg-[color:var(--composer-panel-border)] opacity-40 mx-4" />
                  <SectionLabel>
                    {t('agentPanel.changes')}
                    <span className="ml-1.5 normal-case tracking-normal font-normal">{changes.length}</span>
                  </SectionLabel>
                  {changeCoverageIssues.length > 0 && (
                    <div className="mx-4 mb-2 rounded-[6px] border border-[color:hsl(var(--destructive)/0.28)] bg-[color:hsl(var(--destructive)/0.06)] px-2.5 py-2 text-[11px] text-[color:hsl(var(--destructive))]">
                      <div className="font-medium">{t('agentPanel.changeCoverageIncomplete')}</div>
                      <div className="mt-0.5 break-words text-[10px] opacity-80">
                        {changeCoverageIssues.map((issue) => issue.detail).filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5 px-4 pb-2 max-h-[96px] overflow-y-auto">
                    {changes.map((item) => {
                      const ChangeIcon = item.kind === 'note' ? Notebook : FileIcon;
                      const isReverted = revertedIds.has(item.id);
                      const canReveal = !!(item.rootId && item.relativePath && sessionId);
                      const clickable = !isReverted && item.kind !== 'document' && (!!item.openId || canReveal);
                      const canPreview = canReveal && !isReverted && item.action !== 'delete';
                      const isPreviewing = previewChangeId === item.id;
                      const canRevertArtifact = item.rootId === 'artifacts'
                        && !!item.afterHash
                        && item.action !== 'delete';
                      const canRevertWorkspace = item.rootId === 'workspace' && !!item.receipt;
                      const canRevert = !isReverted
                        && !!item.relativePath
                        && !!sessionId
                        && (canRevertArtifact || canRevertWorkspace);
                      const savedNoteId = savedNoteIds.get(item.id);
                      const isSavingNote = savingNoteIds.has(item.id);
                      const canSaveAsNote = !isReverted
                        && item.rootId === 'artifacts'
                        && !!item.relativePath
                        && NOTE_SAVABLE_EXTENSION_RE.test(item.relativePath)
                        && !!sessionId
                        && item.action !== 'delete';
                      const chip = (
                        <>
                          <ChangeIcon size={11} className="flex-shrink-0 text-[color:var(--text-muted)]" />
                          <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
                            {isReverted
                              ? t('agentPanel.reverted')
                              : changeActionLabel(item.action)}
                          </span>
                          <span className={cn('truncate', isReverted && 'line-through opacity-60')}>
                            {item.label}
                          </span>
                          {!item.openId && canReveal && !isReverted && (
                            <FolderOpen size={10} className="flex-shrink-0 text-[color:var(--text-muted)]" />
                          )}
                        </>
                      );

                      if (!clickable) {
                        return (
                          <span
                            key={item.id}
                            className={cn(
                              'inline-flex items-center gap-1.5 h-6 px-2 max-w-[260px]',
                              'rounded-full border border-[color:var(--border-soft)]',
                              'bg-transparent text-[11px] text-[color:var(--text-secondary)]',
                              'cursor-default',
                              isReverted && 'opacity-60',
                            )}
                            title={item.target || item.label}
                          >
                            {chip}
                          </span>
                        );
                      }

                      return (
                        <span
                          key={item.id}
                          className={cn(
                            'inline-flex items-center h-6 max-w-[280px]',
                            'rounded-full border border-[color:var(--border-soft)]',
                            'bg-transparent text-[11px] text-[color:var(--text-secondary)]',
                            'overflow-hidden',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => openChange(item)}
                            className={cn(
                              'inline-flex items-center gap-1.5 h-full px-2 min-w-0',
                              'hover:bg-[color:var(--interactive-hover)] hover:text-[color:var(--text-primary)] cursor-pointer',
                            )}
                            title={
                              item.openId
                                ? (item.target || item.label)
                                : t('agentPanel.revealInFolder', { path: item.target || item.label })
                            }
                          >
                            {chip}
                          </button>
                          {canPreview && (
                            <button
                              type="button"
                              onClick={() => togglePreview(item)}
                              className={cn(
                                'inline-flex items-center h-full px-1.5 border-l border-[color:var(--border-soft)]',
                                'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]',
                                'hover:bg-[color:var(--interactive-hover)] cursor-pointer',
                                isPreviewing && 'bg-[color:var(--interactive-hover)] text-[color:var(--text-primary)]',
                              )}
                              title={t('agentPanel.preview')}
                              aria-label={t('agentPanel.preview')}
                            >
                              <Eye size={10} />
                            </button>
                          )}
                          {canSaveAsNote && (
                            savedNoteId ? (
                              <button
                                type="button"
                                onClick={() => openSavedNote(savedNoteId)}
                                className={cn(
                                  'inline-flex items-center gap-1 h-full px-1.5 border-l border-[color:var(--border-soft)]',
                                  'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]',
                                  'hover:bg-[color:var(--interactive-hover)] cursor-pointer',
                                )}
                                title={t('agentPanel.openSavedNote')}
                                aria-label={t('agentPanel.openSavedNote')}
                              >
                                <Check size={10} className="flex-shrink-0 text-[color:hsl(var(--success))]" />
                                <span className="text-[10px]">
                                  {t('agentPanel.savedAsNote')}
                                </span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => saveChangeAsNote(item)}
                                disabled={isSavingNote}
                                className={cn(
                                  'inline-flex items-center h-full px-1.5 border-l border-[color:var(--border-soft)]',
                                  'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]',
                                  'hover:bg-[color:var(--interactive-hover)] cursor-pointer',
                                  isSavingNote && 'opacity-60 cursor-default',
                                )}
                                title={t('agentPanel.saveAsNote')}
                                aria-label={t('agentPanel.saveAsNote')}
                              >
                                {isSavingNote ? (
                                  <CircleNotch size={10} className="animate-spin" />
                                ) : (
                                  <NotePencil size={10} />
                                )}
                              </button>
                            )
                          )}
                          {canRevert && (
                            <button
                              type="button"
                              onClick={() => revertRuntimeChange(item)}
                              className={cn(
                                'inline-flex items-center h-full px-1.5 border-l border-[color:var(--border-soft)]',
                                'text-[color:var(--text-muted)] hover:text-[color:hsl(var(--destructive))]',
                                'hover:bg-[color:var(--interactive-hover)] cursor-pointer',
                              )}
                              title={item.rootId === 'workspace'
                                ? t('agentPanel.revertWorkspace')
                                : item.backupRef
                                  ? t('agentPanel.revertRestore')
                                  : t('agentPanel.revertDeleteNew')}
                              aria-label={item.rootId === 'workspace'
                                ? t('agentPanel.revertWorkspace')
                                : item.backupRef
                                  ? t('agentPanel.revertRestore')
                                  : t('agentPanel.revertDeleteNew')}
                            >
                              <ArrowCounterClockwise size={10} />
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>

                  {/* 内联预览区：当前内容预览；覆盖写时与备份旧内容做行级 diff */}
                  {previewChange && (
                    <div className="mx-4 mb-2 rounded-[10px] border border-[color:var(--border-soft)] overflow-hidden">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 border-b border-[color:var(--border-soft)]">
                        <FileIcon size={10} className="flex-shrink-0 text-[color:var(--text-muted)]" />
                        <span className="flex-1 min-w-0 truncate font-mono text-[10px] text-[color:var(--text-muted)]">
                          {previewChange.relativePath || previewChange.label}
                        </span>
                        {preview?.truncated && (
                          <span className="flex-shrink-0 text-[10px] text-[color:var(--text-muted)]">
                            {t('agentPanel.previewTruncated')}
                          </span>
                        )}
                        <NotionButton
                          variant="ghost"
                          onClick={closePreview}
                          className="!h-auto !min-w-0 !p-0.5 !gap-0 !border-none !bg-transparent !shadow-none text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
                          aria-label={t('agentPanel.previewClose')}
                        >
                          <CaretUp size={9} />
                        </NotionButton>
                      </div>
                      {preview?.loading ? (
                        <div className="flex items-center gap-1.5 px-2.5 py-2">
                          <CircleNotch size={11} className="animate-spin text-[color:hsl(var(--primary))]" />
                        </div>
                      ) : preview?.error ? (
                        <div className="px-2.5 py-2 text-[11px] text-[color:hsl(var(--destructive))]">
                          {t('agentPanel.previewFailed')}: {preview.error}
                        </div>
                      ) : previewDiffLines ? (
                        <pre className="m-0 max-h-60 overflow-auto px-2.5 py-1.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all">
                          {previewDiffLines.map((line, idx) => (
                            <div
                              key={idx}
                              className={cn(
                                line.type === 'added'
                                  && 'bg-[color:hsl(var(--success)/0.12)] text-[color:hsl(var(--success))]',
                                line.type === 'removed'
                                  && 'bg-[color:hsl(var(--destructive)/0.12)] text-[color:hsl(var(--destructive))]',
                                line.type === 'unchanged' && 'text-[color:var(--text-muted)]',
                              )}
                            >
                              {(line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  ') + line.text}
                            </div>
                          ))}
                        </pre>
                      ) : (
                        <pre className="m-0 max-h-60 overflow-auto px-2.5 py-1.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all text-[color:var(--text-secondary)]">
                          {preview?.content ?? ''}
                        </pre>
                      )}
                    </div>
                  )}
                </>
              )}

              {isAllDone && message && (
                <div className="flex-shrink-0 px-4 py-2 border-t border-[color:var(--composer-panel-border)] opacity-60">
                  <span className="text-[11px] text-[color:hsl(var(--success))] font-medium">{message}</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default AgentTaskPanel;
