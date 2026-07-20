/**
 * agent-task/ChangesSection — 写入/修改摘要区
 *
 * - 变更 chip（打开 / 预览 / 存为笔记 / 撤销）
 * - delete 类操作使用 destructive 标签与边框，突出危险写操作
 * - 内联预览（当前内容；覆盖写与 temp 备份做行级 diff）
 * - 变更覆盖不完整告警
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  Check,
  CircleNotch,
  Notebook,
  NotePencil,
  File as FileIcon,
  FolderOpen,
  ArrowCounterClockwise,
  Eye,
  CaretUp,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { dstu } from '@/dstu/api';
import { openResource } from '@/dstu/openResource';
import { computeLineDiff } from '../../utils/lineDiff';
import type {
  ChangeAction,
  ChangeCoverageIssue,
  ChangeItem,
  ChangePreviewState,
  RuntimeFilePreview,
} from './types';

/** 可一键转存为笔记的文本产物扩展名（Changes 区「存为笔记」入口） */
const NOTE_SAVABLE_EXTENSION_RE = /\.(md|markdown|txt)$/i;
/** 转存笔记时读取产物的上限（512KB，超出则截断保存并提示） */
const SAVE_AS_NOTE_MAX_BYTES = 512 * 1024;

export interface ChangesSectionProps {
  changes: ChangeItem[];
  coverageIssues: ChangeCoverageIssue[];
  sessionId?: string;
  /** 在系统文件管理器中定位 runtime 文件（由父级提供，与其他区共用实现） */
  onRevealRuntimeFile: (item: ChangeItem) => void;
}

export const ChangesSection: React.FC<ChangesSectionProps> = ({
  changes,
  coverageIssues,
  sessionId,
  onRevealRuntimeFile,
}) => {
  const { t } = useTranslation('chatV2');
  const [revertedIds, setRevertedIds] = useState<Set<string>>(new Set());
  // 「存为笔记」转化状态：changeId → 已创建的笔记 id（组件内即可，无需持久化）
  const [savedNoteIds, setSavedNoteIds] = useState<Map<string, string>>(new Map());
  const [savingNoteIds, setSavingNoteIds] = useState<Set<string>>(new Set());
  const [previewChangeId, setPreviewChangeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChangePreviewState | null>(null);
  // 防止快速切换预览目标时，先发出的慢请求覆盖后发出的快请求结果
  const previewRequestRef = useRef<string | null>(null);
  // 撤销/转存请求进行中的 changeId 集合（ref 同步拦截双击重复 invoke）
  const revertingIdsRef = useRef<Set<string>>(new Set());
  const savingNoteIdsRef = useRef<Set<string>>(new Set());

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
      onRevealRuntimeFile(item);
    }
  }, [onRevealRuntimeFile]);

  const previewChange = previewChangeId
    ? changes.find((c) => c.id === previewChangeId)
    : undefined;
  const previewDiffLines = useMemo(() => {
    if (!preview || preview.loading || preview.error) return null;
    if (preview.backupContent === undefined) return null;
    return computeLineDiff(preview.backupContent, preview.content ?? '');
  }, [preview]);

  const changeActionLabel = (action: ChangeAction) => t(`agentPanel.changeActions.${action}`);

  return (
    <>
      {coverageIssues.length > 0 && (
        <div className="mx-4 mb-2 rounded-[6px] border border-[color:hsl(var(--destructive)/0.28)] bg-[color:hsl(var(--destructive)/0.06)] px-2.5 py-2 text-[11px] text-[color:hsl(var(--destructive))]">
          <div className="font-medium">{t('agentPanel.changeCoverageIncomplete')}</div>
          <div className="mt-0.5 break-words text-2xs opacity-80">
            {coverageIssues.map((issue) => issue.detail).filter(Boolean).join(' · ')}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {changes.map((item) => {
          const ChangeIcon = item.kind === 'note' ? Notebook : FileIcon;
          const isReverted = revertedIds.has(item.id);
          const isDestructive = item.action === 'delete' && !isReverted;
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
              <ChangeIcon
                size={11}
                className={cn(
                  'flex-shrink-0',
                  isDestructive ? 'text-[color:hsl(var(--destructive))]' : 'text-[color:var(--text-muted)]',
                )}
              />
              <span
                className={cn(
                  'text-2xs uppercase tracking-wide',
                  isDestructive
                    ? 'rounded bg-[color:hsl(var(--destructive)/0.1)] px-1 text-[color:hsl(var(--destructive))] font-medium'
                    : 'text-[color:var(--text-muted)]',
                )}
              >
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
                  'rounded-full border',
                  isDestructive
                    ? 'border-[color:hsl(var(--destructive)/0.35)]'
                    : 'border-[color:var(--border-soft)]',
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
                'rounded-full border',
                isDestructive
                  ? 'border-[color:hsl(var(--destructive)/0.35)]'
                  : 'border-[color:var(--border-soft)]',
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
                    // ★ 触控目标：触屏加宽 + 纵向伪元素扩命中区（横向不外扩，避免吃掉相邻按钮）
                    "[@media(pointer:coarse)]:px-3 relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-1 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']",
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
                      "[@media(pointer:coarse)]:px-3 relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-1 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']",
                    )}
                    title={t('agentPanel.openSavedNote')}
                    aria-label={t('agentPanel.openSavedNote')}
                  >
                    <Check size={10} className="flex-shrink-0 text-[color:hsl(var(--success))]" />
                    <span className="text-2xs">
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
                      "[@media(pointer:coarse)]:px-3 relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-1 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']",
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
                    // ★ 触控目标：撤销是破坏性操作，触屏加宽并与相邻按钮留 ≥8px 间距防误触
                    "[@media(pointer:coarse)]:px-3 [@media(pointer:coarse)]:ml-2 relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-1 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']",
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
            <span className="flex-1 min-w-0 truncate font-mono text-2xs text-[color:var(--text-muted)]">
              {previewChange.relativePath || previewChange.label}
            </span>
            {preview?.truncated && (
              <span className="flex-shrink-0 text-2xs text-[color:var(--text-muted)]">
                {t('agentPanel.previewTruncated')}
              </span>
            )}
            <DsButton
              variant="ghost"
              onClick={closePreview}
              // ★ 触控目标：视觉不变，触屏伪元素扩命中区到 ≥44px
              className="!h-auto !min-w-0 !p-0.5 !gap-0 !border-none !bg-transparent !shadow-none text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3.5 [@media(pointer:coarse)]:after:content-['']"
              aria-label={t('agentPanel.previewClose')}
            >
              <CaretUp size={9} />
            </DsButton>
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
            <pre className="m-0 px-2.5 py-1.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all">
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
            <pre className="m-0 px-2.5 py-1.5 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all text-[color:var(--text-secondary)]">
              {preview?.content ?? ''}
            </pre>
          )}
        </div>
      )}
    </>
  );
};

export default ChangesSection;
