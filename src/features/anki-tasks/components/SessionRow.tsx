/**
 * 制卡任务 — 会话行（主行 + 展开详情区）
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  CaretDown, CaretRight, Play, Pause, ArrowCounterClockwise,
  Trash, DownloadSimple, ArrowSquareOut, XCircle,
  CircleNotch, FileText, Hash, TrendUp, ChartBar, Circle,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import { exportCardsAsApkg } from '@/features/chat/anki';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import {
  normalizeTaskCardsForExport,
  selectTaskExportCards,
} from '@/components/anki/utils/normalizeTaskCardsForExport';
import {
  controlDocumentTask,
  retryFailedDocumentTasks,
} from '@/features/anki/taskControl';
import {
  classify, timeAgo, formatDate, getCardFieldValue,
  CARDS_PAGE_SIZE, type DocumentSession,
} from '../types';
import { PropRow, StatusTag, InlineProgress } from './bits';
import { FailedTasksPanel } from './FailedTasksPanel';

export const SessionRow: React.FC<{
  session: DocumentSession;
  isSmallScreen: boolean;
  expanded: boolean;
  onToggle: () => void;
  onJump: () => void;
  onRefresh: () => void;
}> = ({ session, isSmallScreen, expanded, onToggle, onJump, onRefresh }) => {
  const { t } = useTranslation('anki');
  // 移动端：行内 24px 图标簇触控目标过小且会溢出 48px 容器，改为隐藏行内簇、
  // 在展开区提供全套 44px 操作按钮（见下方展开区）
  const [cards, setCards] = useState<AnkiCard[]>([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAllCards, setShowAllCards] = useState(false);
  const [templateMap, setTemplateMap] = useState<Record<string, CustomAnkiTemplate>>({});
  // 内联删除确认
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 组件卸载时清理内联删除确认计时器，避免在已卸载组件上触发 setState
  useEffect(() => () => {
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
  }, []);

  const group = classify(session);

  // 加载卡片 — 错误时通知用户而非静默吞没；同时并行加载关联模板，避免列名闪烁
  const loadedSigRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const loadCards = useCallback(async (signature: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadingCards(true);
    try {
      const [loadedCards, allTemplates] = await Promise.all([
        invoke<AnkiCard[]>('get_document_cards', { documentId: session.documentId }),
        invoke<CustomAnkiTemplate[]>('get_all_custom_templates').catch(err => {
          debugLog.error('[AnkiTasks] loadTemplates failed:', err);
          return [] as CustomAnkiTemplate[];
        }),
      ]);
      setCards(loadedCards);
      const uniqueTemplateIds = new Set(
        loadedCards
          .map(c => c.template_id)
          .filter((id): id is string => !!id && id.trim() !== '')
      );
      const map: Record<string, CustomAnkiTemplate> = {};
      if (uniqueTemplateIds.size > 0 && allTemplates.length > 0) {
        for (const tpl of allTemplates) {
          if (uniqueTemplateIds.has(tpl.id)) {
            map[tpl.id] = tpl;
          }
        }
      }
      setTemplateMap(map);
      // 仅成功后记录签名：失败时保持未加载态，下次展开/数据变化会自动重试
      loadedSigRef.current = signature;
    } catch (err: unknown) {
      debugLog.error('[AnkiTasks] loadCards failed:', err);
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      loadingRef.current = false;
      setLoadingCards(false);
    }
  }, [session.documentId]);

  // 缓存失效策略：以「卡片数 + 最后更新时间」为签名，任何变化（新增、删除、
  // 编辑）都会使缓存失效并重新拉取；不再只增不减
  useEffect(() => {
    if (!expanded) return;
    const signature = `${session.totalCards}|${session.lastUpdated}`;
    if (loadedSigRef.current !== signature) {
      void loadCards(signature);
    }
  }, [expanded, session.totalCards, session.lastUpdated, loadCards]);

  // 后端操作（pause/resume/cancel/delete/retryFailed）
  const act = useCallback(async (action: string) => {
    setBusy(action);
    try {
      if (action === 'pause') {
        await controlDocumentTask({ documentId: session.documentId, action: 'pause' });
        showGlobalNotification('success', t('taskDashboard.paused'));
      } else if (action === 'resume') {
        await controlDocumentTask({ documentId: session.documentId, action: 'resume' });
        showGlobalNotification('success', t('taskDashboard.resumed'));
      } else if (action === 'cancel') {
        await controlDocumentTask({ documentId: session.documentId, action: 'cancel' });
        showGlobalNotification('success', t('tasks.cancelled'));
      } else if (action === 'retryFailed') {
        // 失败口径含 Failed / Truncated / Cancelled（与会话统计 failed_tasks 一致），
        // 否则仅含 Cancelled 的会话点重试会提示"没有卡住的任务"
        const result = await retryFailedDocumentTasks(session.documentId);
        if (result.total === 0) {
          showGlobalNotification('info', t('taskDashboard.noStuckTasks'));
        } else if (result.failed === 0) {
          showGlobalNotification('success', t('taskDashboard.retryStarted', { count: result.succeeded }));
        } else {
          showGlobalNotification('warning', t('taskDashboard.retryPartial', { succeeded: result.succeeded, failed: result.failed }));
        }
      } else if (action === 'delete') {
        await invoke('delete_document_session', { documentId: session.documentId });
        showGlobalNotification('success', t('taskDashboard.deleted'));
      }
      onRefresh();
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [session.documentId, onRefresh, t]);

  // 内联确认删除（点击一次显示确认态，3s 后回退；再次点击真删）
  const handleDelete = useCallback(() => {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      deleteTimerRef.current = setTimeout(() => setDeleteConfirm(false), 3000);
      return;
    }
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setDeleteConfirm(false);
    act('delete');
  }, [deleteConfirm, act]);

  // 行内一键导出 — 始终获取最新卡片，过滤错误卡，使用 extra_fields
  const exportLockRef = useRef(false);
  const handleQuickExport = useCallback(async () => {
    // 同步锁防止快速双击
    if (exportLockRef.current) return;
    exportLockRef.current = true;
    setBusy('export');
    try {
      // 优先读取聊天块中持久化的编辑后卡片；若无则回退任务库卡片
      const [editedCards, freshCards] = await Promise.all([
        invoke<AnkiCard[]>(
          'chat_v2_get_anki_cards_from_block_by_document_id',
          { documentId: session.documentId },
        ).catch(() => []),
        invoke<AnkiCard[]>(
          'get_document_cards',
          { documentId: session.documentId },
        ),
      ]);
      const sourceCards = selectTaskExportCards(editedCards, freshCards);
      setCards(sourceCards);
      const exportable = sourceCards.filter(c => !c.is_error_card);
      if (exportable.length === 0) {
        showGlobalNotification('info', t('taskDashboard.noExportableCards'));
        return;
      }
      const normalizedCards = normalizeTaskCardsForExport(exportable);
      const result = await exportCardsAsApkg({
        cards: normalizedCards,
        deckName: session.documentName || 'Export',
      });
      if (result.success) showGlobalNotification('success', t('taskDashboard.exported'));
      else throw new Error(t('chatV2.exportFailed'));
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setBusy(null);
      exportLockRef.current = false;
    }
  }, [session.documentId, session.documentName, t]);

  // 错误卡片
  const errorCards = useMemo(() => cards.filter(c => c.is_error_card), [cards]);
  // 正常卡片（分页）
  const normalCards = useMemo(() => cards.filter(c => !c.is_error_card), [cards]);
  const visibleCards = showAllCards ? normalCards : normalCards.slice(0, CARDS_PAGE_SIZE);
  const hasMoreCards = normalCards.length > CARDS_PAGE_SIZE;

  // 动态计算列和模板信息
  const { templateName, columns, isFallback } = useMemo(() => {
    if (normalCards.length === 0) {
      return { templateName: null, columns: [] as string[], isFallback: true };
    }

    const templateIds = [...new Set(
      normalCards
        .map(c => c.template_id)
        .filter((id): id is string => !!id && id.trim() !== '')
    )];

    // 单模板场景：直接使用模板声明的字段列表
    if (templateIds.length === 1 && templateMap[templateIds[0]]) {
      const tmpl = templateMap[templateIds[0]];
      if (tmpl.fields.length > 0) {
        return { templateName: tmpl.name, columns: tmpl.fields, isFallback: false };
      }
    }

    // 从卡片 extra_fields 推导列（保持首次出现顺序）
    const fieldKeys: string[] = [];
    const seen = new Set<string>();
    for (const c of normalCards) {
      const ef = c.extra_fields ?? c.fields;
      if (ef) {
        for (const k of Object.keys(ef)) {
          if (!seen.has(k)) { seen.add(k); fieldKeys.push(k); }
        }
      }
    }

    if (fieldKeys.length > 0) {
      const name = templateIds.length === 1 && templateMap[templateIds[0]]
        ? templateMap[templateIds[0]].name
        : templateIds.length > 1
          ? t('taskDashboard.multipleTemplates', { count: templateIds.length })
          : null;
      return { templateName: name, columns: fieldKeys, isFallback: false };
    }

    // 完全回退到 Front/Back
    return { templateName: null, columns: [], isFallback: true };
  }, [normalCards, templateMap, t]);

  const isRunning = group === 'active' && session.activeTasks > 0;

  return (
    <div
      className={`wb-at-row group/row${isRunning ? ' wb-at-row-running' : ''}`}
      data-agent-entity={`taskDashboard:${session.documentId}`}
    >
      {/* ---- 主行 ---- */}
      <div
        className={`wb-at-row-main${isSmallScreen ? ' min-h-[44px]' : ''}`}
        onClick={onToggle}
      >
        {/* 展开箭头 */}
        <span className="text-muted-foreground/30 w-4 flex-shrink-0">
          {expanded
            ? <CaretDown size={14} />
            : <CaretRight size={14} />}
        </span>

        {/* 文档名 */}
        <FileText className="h-[15px] w-[15px] text-muted-foreground/50 flex-shrink-0" />
        <span className="text-[13px] text-foreground truncate min-w-0 flex-1">
          {session.documentName || session.documentId.slice(0, 12)}
        </span>

        {/* 状态（宽度与表头 60/72px 对齐，避免小屏列错位） */}
        <div className="w-[60px] sm:w-[72px] flex-shrink-0">
          <StatusTag group={group} paused={group === 'active' && session.activeTasks === 0 && session.pausedTasks > 0} />
        </div>

        {/* 卡片数 */}
        <div className="w-[40px] sm:w-[48px] flex-shrink-0 text-right">
          <span className="text-xs text-muted-foreground tabular-nums">
            {session.totalCards}
          </span>
        </div>

        {/* 进度（窄窗隐藏，随窗口分级而非视口） */}
        <div className="w-[140px] flex-shrink-0 wb-at-col-progress">
          <InlineProgress completed={session.completedTasks} total={session.totalTasks} failed={session.failedTasks} active={isRunning} />
        </div>

        {/* 时间 */}
        <span className="text-xs text-muted-foreground/60 w-[80px] text-right flex-shrink-0 tabular-nums hidden sm:block">
          {timeAgo(session.lastUpdated, t)}
        </span>

        {/* 操作按钮（触屏常驻低透明度，桌面 hover 加强）
            移动端隐藏：24px 目标不满足 44px 触控标准且多按钮会溢出 48px 容器，
            操作统一收入展开区的 44px 按钮（见下方） */}
        {!isSmallScreen && (
        <div
          className="flex items-center justify-end gap-0 flex-shrink-0 w-[120px]
            opacity-40 group-hover/row:opacity-100
            transition-opacity duration-150"
          onClick={e => e.stopPropagation()}
        >
          {group === 'active' && session.activeTasks > 0 && (
            <CommonTooltip content={t('pause')}>
              <NotionButton size="sm" variant="ghost" onClick={() => act('pause')} disabled={!!busy} className="w-6 h-6 p-0">
                <Pause size={12} />
              </NotionButton>
            </CommonTooltip>
          )}
          {session.pausedTasks > 0 && (
            <CommonTooltip content={t('resume')}>
              <NotionButton size="sm" variant="ghost" onClick={() => act('resume')} disabled={!!busy} className="w-6 h-6 p-0">
                <Play size={12} />
              </NotionButton>
            </CommonTooltip>
          )}
          {group === 'active' && (
            <CommonTooltip content={t('tasks.cancelTask')}>
              <NotionButton size="sm" variant="ghost" onClick={() => act('cancel')} disabled={!!busy} className="w-6 h-6 p-0">
                <XCircle size={12} />
              </NotionButton>
            </CommonTooltip>
          )}
          {group === 'attention' && session.pausedTasks === 0 && (
            <CommonTooltip content={t('taskDashboard.retryFailed')}>
              <NotionButton size="sm" variant="ghost" onClick={() => act('retryFailed')} disabled={!!busy} className="w-6 h-6 p-0">
                <ArrowCounterClockwise size={12} />
              </NotionButton>
            </CommonTooltip>
          )}
          {session.totalCards > 0 && (
            <CommonTooltip content={t('taskDashboard.quickExport')}>
              <NotionButton size="sm" variant="ghost" onClick={handleQuickExport} disabled={!!busy || loadingCards} className="w-6 h-6 p-0">
                <DownloadSimple size={12} />
              </NotionButton>
            </CommonTooltip>
          )}
          {session.sourceSessionId && (
            <CommonTooltip content={t('taskDashboard.jumpToChat')}>
              <NotionButton size="sm" variant="ghost" onClick={onJump} className="w-6 h-6 p-0">
                <ArrowSquareOut size={12} />
              </NotionButton>
            </CommonTooltip>
          )}
          {/* 内联删除确认 */}
          <CommonTooltip content={deleteConfirm ? t('taskDashboard.confirmDeleteHint') : t('taskDashboard.deleteSession')}>
            <NotionButton
              size="sm"
              variant={deleteConfirm ? 'danger' : 'ghost'}
              onClick={handleDelete}
              disabled={!!busy}
              className={`h-6 p-0 ${deleteConfirm ? 'px-2 gap-1' : 'w-6'}`}
            >
              <Trash size={12} />
              {deleteConfirm && (
                <span className="text-[10px]">{t('taskDashboard.confirmDeleteHint')}</span>
              )}
            </NotionButton>
          </CommonTooltip>
        </div>
        )}
      </div>

      {/* ---- 展开区域 ----（ui-rise-in：与设置 TabsContent 同款挂载入场，reduced-motion 自动降级） */}
      {expanded && (
        <div className="wb-at-row-detail space-y-3 ui-rise-in">
          {/* 属性行 */}
          <div className="space-y-0.5">
            <PropRow icon={<Hash size={14} />} label={t('taskDashboard.colStatus')}>
              <StatusTag group={group} paused={group === 'active' && session.activeTasks === 0 && session.pausedTasks > 0} />
              {group === 'active' && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {session.activeTasks} {t('taskDashboard.statusActive')} / {session.pausedTasks} {t('taskDashboard.statusPaused')}
                </span>
              )}
            </PropRow>
            <PropRow icon={<ChartBar size={14} />} label={t('taskDashboard.progressLabel')}>
              <InlineProgress completed={session.completedTasks} total={session.totalTasks} failed={session.failedTasks} active={isRunning} />
            </PropRow>
            <PropRow icon={<TrendUp size={14} />} label={t('taskDashboard.propTotalCards')}>
              <span className="tabular-nums">{session.totalCards}</span>
            </PropRow>
            <PropRow icon={<Circle size={14} />} label={t('taskDashboard.timeCreated')}>
              {formatDate(session.createdAt)}
            </PropRow>
            <PropRow icon={<Circle size={14} />} label={t('taskDashboard.timeUpdated')}>
              {formatDate(session.lastUpdated)}
            </PropRow>
          </div>

          {/* 操作按钮（移动端为唯一操作入口，补齐暂停/恢复/跳转聊天） */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {session.totalCards > 0 && (
              <NotionButton size="sm" variant="default" onClick={handleQuickExport} disabled={!!busy || loadingCards}>
                <DownloadSimple size={14} />{t('taskDashboard.exportApkg')}
              </NotionButton>
            )}
            {group === 'attention' && (
              <NotionButton size="sm" variant="primary" onClick={() => act('retryFailed')} disabled={!!busy}>
                <ArrowCounterClockwise size={14} />{t('taskDashboard.retryFailed')}
              </NotionButton>
            )}
            {isSmallScreen && group === 'active' && session.activeTasks > 0 && (
              <NotionButton size="sm" variant="default" onClick={() => act('pause')} disabled={!!busy}>
                <Pause size={14} />{t('pause')}
              </NotionButton>
            )}
            {isSmallScreen && session.pausedTasks > 0 && (
              <NotionButton size="sm" variant="default" onClick={() => act('resume')} disabled={!!busy}>
                <Play size={14} />{t('resume')}
              </NotionButton>
            )}
            {isSmallScreen && group === 'active' && (
              <NotionButton size="sm" variant="default" onClick={() => act('cancel')} disabled={!!busy}>
                <XCircle size={14} />{t('tasks.cancelTask')}
              </NotionButton>
            )}
            {isSmallScreen && session.sourceSessionId && (
              <NotionButton size="sm" variant="default" onClick={onJump}>
                <ArrowSquareOut size={14} />{t('taskDashboard.jumpToChat')}
              </NotionButton>
            )}
            <NotionButton
              size="sm"
              variant={deleteConfirm ? 'danger' : 'default'}
              onClick={handleDelete}
              disabled={!!busy}
            >
              <Trash size={14} />
              {deleteConfirm ? t('taskDashboard.confirmDeleteHint') : t('taskDashboard.deleteSession')}
            </NotionButton>
          </div>

          {/* 失败分段面板 — 展示后端写入的 error_message + 逐段/整体重试入口 */}
          {session.failedTasks > 0 && (
            <FailedTasksPanel
              documentId={session.documentId}
              failedCount={session.failedTasks}
              onRetried={onRefresh}
            />
          )}

          {/* 错误卡片详情（从已加载卡片中提取） */}
          {errorCards.length > 0 && (
            <div className="py-1 space-y-1">
              <div className="text-xs font-medium text-[color:hsl(var(--warning))]">
                {t('taskDashboard.errorCardsFound', { count: errorCards.length })}
              </div>
              {errorCards.slice(0, 3).map((c, i) => (
                <div key={c.id || i} className="text-xs text-muted-foreground pl-4 py-0.5">
                  <span className="text-foreground/60 truncate inline-block max-w-[200px] align-middle">
                    {c.front || '—'}
                  </span>
                  {c.error_content && (
                    <span className="text-[color:hsl(var(--warning)/0.7)] ml-2">
                      {t('taskDashboard.errorReason')}: {c.error_content}
                    </span>
                  )}
                </div>
              ))}
              {errorCards.length > 3 && (
                <div className="text-[11px] text-muted-foreground/30 pl-4">
                  +{errorCards.length - 3} ...
                </div>
              )}
            </div>
          )}

          {/* 卡片列表 */}
          {loadingCards ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground justify-center">
              <CircleNotch size={16} className="animate-spin" />{t('taskDashboard.loadingCards')}
            </div>
          ) : normalCards.length > 0 ? (
            <div>
              {/* 模板标签 */}
              {templateName && (
                <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px]">
                  <span className="text-muted-foreground/50">{t('taskDashboard.templateLabel')}</span>
                  <span className="text-foreground/70 font-medium">{templateName}</span>
                </div>
              )}
              {/* 表头+卡片列表 — 可水平滚动，避免窄容器多列时列宽坍缩 */}
              <div className="overflow-x-auto">
                <div style={!isFallback && columns.length > 2 ? { minWidth: `${columns.length * 120 + 36}px` } : undefined}>
                  {/* 表头 — 根据模板字段动态生成列 */}
                  <div className="flex items-center gap-3 px-2 py-1.5 text-[11px] font-medium text-muted-foreground/50 uppercase tracking-wider">
                    <span className="w-6 text-right flex-shrink-0">#</span>
                    {isFallback ? (
                      <>
                        <span className="flex-1 min-w-[100px]">{t('taskDashboard.cardFront')}</span>
                        <span className="flex-1 min-w-[100px]">{t('taskDashboard.cardBack')}</span>
                      </>
                    ) : (
                      columns.map(col => (
                        <span key={col} className="flex-1 min-w-[100px] truncate">{col}</span>
                      ))
                    )}
                  </div>
                  {/* show-more 分页 — 展开后解除高度限制 */}
                  <CustomScrollArea className={showAllCards ? 'max-h-[600px]' : 'max-h-[280px]'}>
                    {visibleCards.map((c, i) => (
                      <div key={c.id || i} className="flex items-start gap-3 px-2 py-2 hover:bg-[var(--interactive-hover)] transition-colors">
                        <span className="text-[10px] text-muted-foreground/30 mt-0.5 w-6 text-right flex-shrink-0 tabular-nums">
                          {i + 1}
                        </span>
                        {isFallback ? (
                          <>
                            <div className="flex-1 min-w-[100px] text-[13px] text-foreground/90 truncate">
                              {c.front || '—'}
                            </div>
                            <div className="flex-1 min-w-[100px] text-[13px] text-muted-foreground truncate">
                              {c.back || '—'}
                            </div>
                          </>
                        ) : (
                          columns.map((col, ci) => (
                            <div
                              key={col}
                              className={`flex-1 min-w-[100px] text-[13px] truncate ${ci === 0 ? 'text-foreground/90' : 'text-muted-foreground'}`}
                            >
                              {getCardFieldValue(c, col)}
                            </div>
                          ))
                        )}
                      </div>
                    ))}
                  </CustomScrollArea>
                </div>
              </div>
              {hasMoreCards && (
                <NotionButton variant="ghost" size="sm" onClick={() => setShowAllCards(v => !v)} className="w-full !py-1.5 text-[12px] text-muted-foreground/50 hover:text-muted-foreground">
                  {showAllCards
                    ? t('taskDashboard.showLessCards')
                    : t('taskDashboard.showMoreCards', { remaining: normalCards.length - CARDS_PAGE_SIZE })}
                </NotionButton>
              )}
            </div>
          ) : session.totalCards === 0 ? (
            <p className="text-[13px] text-muted-foreground/40 py-3">{t('taskDashboard.noCards')}</p>
          ) : null}
        </div>
      )}
    </div>
  );
};
