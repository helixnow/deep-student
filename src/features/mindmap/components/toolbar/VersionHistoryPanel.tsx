/**
 * 版本历史内联面板（W10 · 任务 9）
 *
 * 工具栏下方文档流展开（同搜索条范式，无模态/无遮罩）：
 * - 列出版本（时间 / 来源 / 标题）
 * - 「预览」内联展示该版本根节点标题
 * - 「恢复」走内联确认条（非 Dialog）：确认后先自动保存当前未保存修改，
 *   再调 vfs_restore_mindmap_version，最后 loadMindMap 刷新编辑器
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ArrowCounterClockwise,
  CircleNotch,
  ClockCounterClockwise,
  Eye,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useMindMapStoreApi } from '../../store';
import {
  getMindMapVersions,
  getMindMapVersionContent,
  restoreMindMapVersion,
  type VfsMindMapVersion,
} from '../../api/mindmapApi';
import type { MindMapDocument } from '../../types';

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

function formatTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

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
  /** versionId → 预览出的根节点标题（null = 预览失败） */
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
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
        let title: string | null = null;
        if (contentStr) {
          try {
            const doc = JSON.parse(contentStr) as MindMapDocument;
            title = doc?.root?.text ?? null;
          } catch {
            title = null;
          }
        }
        setPreviews((prev) => ({ ...prev, [versionId]: title }));
      } catch (err: unknown) {
        console.error('[VersionHistoryPanel] Preview failed:', err);
        setPreviews((prev) => ({ ...prev, [versionId]: null }));
      } finally {
        setPreviewingId((current) => (current === versionId ? null : current));
      }
    },
    [previews],
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
        'flex flex-col border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] ui-drop-in',
        className,
      )}
      role="region"
      aria-label={t('mindmap:versions.title')}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--mm-border)]">
        <ClockCounterClockwise size={15} className="shrink-0 text-[var(--mm-text-muted)]" />
        <h3 className="text-sm font-medium flex-1 text-[var(--mm-text)]">
          {t('mindmap:versions.title')}
        </h3>
        <NotionButton
          variant="ghost"
          className="p-1 hover:bg-[var(--mm-bg-hover)] rounded"
          onClick={onClose}
          aria-label={t('mindmap:versions.close')}
        >
          <X className="w-4 h-4" />
        </NotionButton>
      </div>

      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--mm-text-muted)]">
            <CircleNotch size={14} className="animate-spin" />
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
            {versions.map((version) => {
              const preview = previews[version.versionId];
              const hasPreview = version.versionId in previews;
              const isConfirming = confirmingId === version.versionId;
              const isRestoring = restoringId === version.versionId;
              return (
                <li
                  key={version.versionId}
                  className="px-4 py-1.5 border-b border-[var(--mm-border)]/50 last:border-b-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[var(--mm-text)] truncate">
                        {version.title || t('mindmap:versions.untitled')}
                      </div>
                      <div className="text-xs text-[var(--mm-text-muted)] flex items-center gap-1.5">
                        <span className="tabular-nums">{formatTime(version.createdAt)}</span>
                        <span aria-hidden>·</span>
                        <span>{sourceLabel(version.source, t)}</span>
                        {version.label && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate">{version.label}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <NotionButton
                      variant="ghost"
                      className="notion-btn shrink-0 text-xs text-[var(--mm-text-secondary)]"
                      onClick={() => void handlePreview(version.versionId)}
                      disabled={previewingId === version.versionId}
                      aria-expanded={hasPreview}
                    >
                      {previewingId === version.versionId ? (
                        <CircleNotch size={13} className="animate-spin" />
                      ) : (
                        <Eye size={13} />
                      )}
                      {t('mindmap:versions.preview')}
                    </NotionButton>
                    <NotionButton
                      variant="ghost"
                      className="notion-btn shrink-0 text-xs text-[var(--mm-text-secondary)]"
                      onClick={() => setConfirmingId(version.versionId)}
                      disabled={isRestoring || restoringId !== null}
                    >
                      <ArrowCounterClockwise size={13} />
                      {t('mindmap:versions.restore')}
                    </NotionButton>
                  </div>

                  {hasPreview && (
                    <div className="mt-1 px-2 py-1 rounded bg-[var(--mm-bg-hover)] text-xs text-[var(--mm-text-secondary)] ui-drop-in">
                      {preview !== null
                        ? t('mindmap:versions.previewTitle', { title: preview })
                        : t('mindmap:versions.previewFailed')}
                    </div>
                  )}

                  {/* 恢复确认：内联确认条（非 Dialog），复用冲突横幅的 warning 视觉 */}
                  {isConfirming && (
                    <div
                      className="mt-1 flex items-center gap-2 px-2 py-1.5 rounded border border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)] ui-drop-in"
                      role="alert"
                    >
                      <WarningCircle size={14} className="shrink-0" />
                      <span className="text-xs flex-1 min-w-[120px]">
                        {t('mindmap:versions.restoreConfirmHint')}
                      </span>
                      <NotionButton
                        variant="ghost"
                        className="notion-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
                        onClick={() => void handleConfirmRestore(version.versionId)}
                        disabled={isRestoring}
                      >
                        {isRestoring ? (
                          <CircleNotch size={13} className="animate-spin" />
                        ) : (
                          <ArrowCounterClockwise size={13} />
                        )}
                        <span className="text-xs">
                          {isRestoring
                            ? t('mindmap:versions.restoring')
                            : t('mindmap:versions.restoreConfirm')}
                        </span>
                      </NotionButton>
                      <NotionButton
                        variant="ghost"
                        className="notion-btn shrink-0 text-[var(--mm-text-muted)]"
                        onClick={() => setConfirmingId(null)}
                        disabled={isRestoring}
                      >
                        <span className="text-xs">{t('common:cancel')}</span>
                      </NotionButton>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default VersionHistoryPanel;
