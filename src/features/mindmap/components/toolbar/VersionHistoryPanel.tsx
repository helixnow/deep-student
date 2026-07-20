/**
 * 版本历史内联面板（W10 · 任务 9）
 *
 * 工具栏下方文档流展开（同搜索条范式，无模态/无遮罩）：
 * - 列出版本（相对时间 / 来源徽标 / 标题，最新版本带「最新」徽标）
 * - 「预览」内联展示该版本根节点标题 + diff 摘要（节点数、较当前 +增 / −删）
 * - 「恢复」走内联确认条（非 Dialog）：确认后先自动保存当前未保存修改，
 *   再调 vfs_restore_mindmap_version，最后 loadMindMap 刷新编辑器
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowCounterClockwise,
  CircleNotch,
  ClockCounterClockwise,
  Eye,
  Robot,
  User,
  ArrowsClockwise,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { motionSafe, tweenFast } from '@/styles/motion-springs';
import { useMindMapStoreApi } from '../../store';
import {
  getMindMapVersions,
  getMindMapVersionContent,
  restoreMindMapVersion,
  type VfsMindMapVersion,
} from '../../api/mindmapApi';
import type { MindMapDocument, MindMapNode } from '../../types';

export interface VersionHistoryPanelProps {
  mindmapId: string;
  onClose: () => void;
  className?: string;
}

/** 已知来源 → i18n key；未知来源原样展示 */
function sourceLabel(source: string | undefined, t: TFunction): string {
  if (!source) return t('mindmap:versions.source.unknown');
  return t(`mindmap:versions.source.${source}`, { defaultValue: source });
}

type SourceKind = 'manual' | 'auto' | 'ai' | 'unknown';

function sourceKind(source: string | undefined): SourceKind {
  if (!source) return 'unknown';
  if (source === 'manual') return 'manual';
  if (source === 'auto') return 'auto';
  if (source.startsWith('chat_')) return 'ai';
  return 'unknown';
}

/** 来源徽标：手动=主色 / 自动=中性 / AI=紫色（.dark 下用亮变体） */
const SourceBadge: React.FC<{ source: string | undefined; t: TFunction }> = ({ source, t }) => {
  const kind = sourceKind(source);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[11px] leading-4 whitespace-nowrap',
        kind === 'manual' && 'bg-[var(--mm-primary-soft)] text-[var(--mm-primary)]',
        kind === 'auto' && 'bg-[var(--mm-bg-hover)] text-[var(--mm-text-muted)]',
        kind === 'ai' && 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
        kind === 'unknown' && 'bg-[var(--mm-bg-hover)] text-[var(--mm-text-muted)]',
      )}
    >
      {kind === 'manual' && <User size={11} weight="bold" />}
      {kind === 'auto' && <ArrowsClockwise size={11} weight="bold" />}
      {kind === 'ai' && <Robot size={11} weight="bold" />}
      {sourceLabel(source, t)}
    </span>
  );
};

/** 相对时间：7 天内显示「x 分钟/小时/天前」，更早退回本地绝对时间 */
function formatRelativeTime(iso: string, t: TFunction): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 60_000) return t('mindmap:shellV2.versions.justNow');
  if (diffMs < 3_600_000) {
    return t('mindmap:shellV2.versions.minutesAgo', { count: Math.floor(diffMs / 60_000) });
  }
  if (diffMs < 86_400_000) {
    return t('mindmap:shellV2.versions.hoursAgo', { count: Math.floor(diffMs / 3_600_000) });
  }
  if (diffMs < 7 * 86_400_000) {
    return t('mindmap:shellV2.versions.daysAgo', { count: Math.floor(diffMs / 86_400_000) });
  }
  return parsed.toLocaleString();
}

function formatAbsoluteTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

// ============================================================================
// 预览 / diff 摘要
// ============================================================================

interface VersionPreview {
  /** 根节点标题（内容损坏时 null） */
  title: string | null;
  /** 该版本的节点总数 */
  nodeCount: number;
  /** 恢复该版本会新增的节点数（版本有、当前没有） */
  added: number;
  /** 恢复该版本会移除的节点数（当前有、版本没有） */
  removed: number;
}

function collectNodeIds(node: MindMapNode | undefined, into: Set<string>): void {
  if (!node) return;
  into.add(node.id);
  node.children?.forEach((child) => collectNodeIds(child, into));
}

/** 以节点 id 集合做轻量 diff（文本改动不计入，只统计结构增删） */
function buildPreview(
  versionDoc: MindMapDocument | null,
  currentDoc: MindMapDocument | null,
): VersionPreview | null {
  if (!versionDoc?.root) return null;
  const versionIds = new Set<string>();
  collectNodeIds(versionDoc.root, versionIds);
  const currentIds = new Set<string>();
  collectNodeIds(currentDoc?.root, currentIds);

  let added = 0;
  versionIds.forEach((id) => {
    if (!currentIds.has(id)) added += 1;
  });
  let removed = 0;
  currentIds.forEach((id) => {
    if (!versionIds.has(id)) removed += 1;
  });

  return {
    title: versionDoc.root.text ?? null,
    nodeCount: versionIds.size,
    added,
    removed,
  };
}

// ============================================================================
// 主组件
// ============================================================================

export const VersionHistoryPanel: React.FC<VersionHistoryPanelProps> = ({
  mindmapId,
  onClose,
  className,
}) => {
  const { t } = useTranslation(['mindmap', 'common']);
  const storeApi = useMindMapStoreApi();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<VfsMindMapVersion[]>([]);
  /** versionId → 预览摘要（null = 预览失败/内容不可用） */
  const [previews, setPreviews] = useState<Record<string, VersionPreview | null>>({});
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  /** 待确认恢复的版本（内联确认条） */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getMindMapVersions(mindmapId)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[VersionHistoryPanel] Failed to load versions:', err);
        setError(t('mindmap:versions.loadFailed'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mindmapId, t]);

  const handlePreview = useCallback(
    async (versionId: string) => {
      if (previews[versionId] !== undefined) {
        // 已有预览：再点收起
        setPreviews((prev) => {
          const next = { ...prev };
          delete next[versionId];
          return next;
        });
        return;
      }
      setPreviewingId(versionId);
      try {
        const contentStr = await getMindMapVersionContent(versionId);
        let versionDoc: MindMapDocument | null = null;
        if (contentStr) {
          try {
            versionDoc = JSON.parse(contentStr) as MindMapDocument;
          } catch {
            versionDoc = null;
          }
        }
        const preview = buildPreview(versionDoc, storeApi.getState().document);
        setPreviews((prev) => ({ ...prev, [versionId]: preview }));
      } catch (err: unknown) {
        console.error('[VersionHistoryPanel] Preview failed:', err);
        setPreviews((prev) => ({ ...prev, [versionId]: null }));
      } finally {
        setPreviewingId((current) => (current === versionId ? null : current));
      }
    },
    [previews, storeApi],
  );

  const handleConfirmRestore = useCallback(
    async (versionId: string) => {
      setRestoringId(versionId);
      try {
        const state = storeApi.getState();
        // 恢复会覆盖当前文档：先把未保存修改推到服务端（也会产生一个可回退的版本）
        if (state.isDirty) {
          let saved = false;
          try {
            saved = await state.save();
          } catch {
            saved = false;
          }
          if (!saved) {
            // 保存失败（冲突/网络）由 store 层提示；不继续恢复，避免覆盖未保存内容
            setRestoringId(null);
            return;
          }
        }
        await restoreMindMapVersion(versionId);
        await storeApi.getState().loadMindMap(mindmapId);
        showGlobalNotification('success', t('mindmap:versions.restored'));
        setConfirmingId(null);
        onClose();
      } catch (err: unknown) {
        console.error('[VersionHistoryPanel] Restore failed:', err);
        showGlobalNotification('error', t('mindmap:versions.restoreFailed'));
        setRestoringId(null);
      }
    },
    [storeApi, mindmapId, onClose, t],
  );

  return (
    <div
      className={cn(
        'flex flex-col border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)]',
        className,
      )}
      role="region"
      aria-label={t('mindmap:versions.title')}
    >
      <div className="mm-version-history-header flex items-center gap-2 px-4 py-2 border-b border-[var(--mm-border)]">
        <ClockCounterClockwise size={15} className="shrink-0 text-[var(--mm-text-muted)]" />
        <h3 className="text-sm font-medium flex-1 text-[var(--mm-text)]">
          {t('mindmap:versions.title')}
        </h3>
        <DsButton
          variant="ghost"
          className="mm-version-history-close p-1 hover:bg-[var(--mm-bg-hover)] rounded"
          onClick={onClose}
          aria-label={t('mindmap:versions.close')}
        >
          <X className="w-4 h-4" />
        </DsButton>
      </div>

      <CustomScrollArea
        className="mm-version-history-list max-h-64"
        viewportClassName="mm-version-history-list-viewport overscroll-contain"
        fullHeight={false}
      >
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--mm-text-muted)]">
            <CircleNotch size={14} className="motion-safe:animate-spin" />
            {t('mindmap:versions.loading')}
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--mm-warning)]" role="alert">
            <WarningCircle size={14} className="shrink-0" />
            {error}
          </div>
        ) : versions.length === 0 ? (
          <div className="px-4 py-3 text-sm text-[var(--mm-text-muted)]">
            {t('mindmap:versions.empty')}
          </div>
        ) : (
          <ul className="py-1">
            {versions.map((version, index) => {
              const preview = previews[version.versionId];
              const hasPreview = version.versionId in previews;
              const isConfirming = confirmingId === version.versionId;
              const isRestoring = restoringId === version.versionId;
              return (
                <li
                  key={version.versionId}
                  className="px-4 py-1.5 border-b border-[var(--mm-border)]/50 last:border-b-0 hover:bg-[var(--mm-bg-hover)]/50 transition-colors"
                >
                  <div className="mm-version-history-row flex items-center gap-2 min-w-0">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm text-[var(--mm-text)] truncate">
                          {version.title || t('mindmap:versions.untitled')}
                        </span>
                        {index === 0 && (
                          <span className="shrink-0 px-1.5 py-px rounded-full text-[11px] leading-4 bg-[var(--mm-primary-soft)] text-[var(--mm-primary)]">
                            {t('mindmap:shellV2.versions.latestBadge')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--mm-text-muted)] flex items-center gap-1.5 mt-0.5">
                        <span
                          className="tabular-nums cursor-default"
                          title={formatAbsoluteTime(version.createdAt)}
                        >
                          {formatRelativeTime(version.createdAt, t)}
                        </span>
                        <SourceBadge source={version.source} t={t} />
                        {version.label && (
                          <span className="truncate">{version.label}</span>
                        )}
                      </div>
                    </div>
                    <DsButton
                      variant="ghost"
                      className="ds-btn mm-version-history-action shrink-0 text-xs text-[var(--mm-text-secondary)]"
                      onClick={() => void handlePreview(version.versionId)}
                      disabled={previewingId === version.versionId}
                      aria-expanded={hasPreview}
                    >
                      {previewingId === version.versionId ? (
                        <CircleNotch size={13} className="motion-safe:animate-spin" />
                      ) : (
                        <Eye size={13} />
                      )}
                      {t('mindmap:versions.preview')}
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      className="ds-btn mm-version-history-action shrink-0 text-xs text-[var(--mm-text-secondary)]"
                      onClick={() => setConfirmingId(version.versionId)}
                      disabled={isRestoring || restoringId !== null}
                    >
                      <ArrowCounterClockwise size={13} />
                      {t('mindmap:versions.restore')}
                    </DsButton>
                  </div>

                  <AnimatePresence initial={false}>
                    {hasPreview && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={motionSafe(tweenFast)}
                        style={{ overflow: 'hidden' }}
                      >
                        <div className="mt-1 px-2 py-1.5 rounded bg-[var(--mm-bg-hover)] text-xs text-[var(--mm-text-secondary)]">
                          {preview ? (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="truncate">
                                {t('mindmap:versions.previewTitle', {
                                  title: preview.title ?? t('mindmap:versions.untitled'),
                                })}
                              </span>
                              <span aria-hidden>·</span>
                              <span className="tabular-nums whitespace-nowrap">
                                {t('mindmap:shellV2.versions.nodeCount', {
                                  count: preview.nodeCount,
                                })}
                              </span>
                              <span aria-hidden>·</span>
                              {preview.added === 0 && preview.removed === 0 ? (
                                <span className="whitespace-nowrap">
                                  {t('mindmap:shellV2.versions.diffSame')}
                                </span>
                              ) : (
                                <span className="tabular-nums whitespace-nowrap">
                                  {t('mindmap:shellV2.versions.diffSummary', {
                                    added: preview.added,
                                    removed: preview.removed,
                                  })}
                                </span>
                              )}
                            </div>
                          ) : (
                            t('mindmap:versions.previewFailed')
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* 恢复确认：内联确认条（非 Dialog），复用冲突横幅的 warning 视觉 */}
                  <AnimatePresence initial={false}>
                    {isConfirming && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={motionSafe(tweenFast)}
                        style={{ overflow: 'hidden' }}
                      >
                        <div
                          className="mt-1 mb-0.5 flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)]"
                          role="alert"
                        >
                          <WarningCircle size={14} className="shrink-0" />
                          <span className="text-xs flex-1 min-w-[120px]">
                            {t('mindmap:versions.restoreConfirmHint')}
                          </span>
                          <DsButton
                            variant="ghost"
                            className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
                            onClick={() => void handleConfirmRestore(version.versionId)}
                            disabled={isRestoring}
                          >
                            {isRestoring ? (
                              <CircleNotch size={13} className="motion-safe:animate-spin" />
                            ) : (
                              <ArrowCounterClockwise size={13} />
                            )}
                            <span className="text-xs">
                              {isRestoring
                                ? t('mindmap:versions.restoring')
                                : t('mindmap:versions.restoreConfirm')}
                            </span>
                          </DsButton>
                          <DsButton
                            variant="ghost"
                            className="ds-btn shrink-0 text-[var(--mm-text-muted)]"
                            onClick={() => setConfirmingId(null)}
                            disabled={isRestoring}
                          >
                            <span className="text-xs">{t('common:cancel')}</span>
                          </DsButton>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              );
            })}
          </ul>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default VersionHistoryPanel;
