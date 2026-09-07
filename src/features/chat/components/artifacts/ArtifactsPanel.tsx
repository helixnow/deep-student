/**
 * Chat V2 — 产物面板（P1 产物一等公民化）
 *
 * 会话级产物架：generative-ui / anki-cards / note / file 四类产物，
 * 列表重开（不重跑）+ 带快照刷新（新消息新块，不覆盖历史）+ 跳完整应用。
 *
 * - 索引来自 artifactRegistry（派生索引，SSOT 在 blocks 表）；
 *   面板打开时懒扫水合，并订阅 blocks 规模变化做增量补齐（restore 分页 prepend）。
 * - generative-ui 重开：extractGenerativeUIIntent 三级回退取 intent
 *   （落库 intent 在 tool_input），GenerativeUIPanel 渲染；actionHandlers 不传
 *   （未注册安全模式，action-bar 按钮不渲染——MVP 可接受）。
 * - anki-cards 重开：直接重渲染持久化块（cards 在 toolOutput 自包含）。
 * - pin 存 sessionMetadata['artifactMeta']（整体替换语义 → read-modify-write）。
 *
 * 设计文档：docs/plans/2026-09-06-canvas-patterns-absorption.md P1
 */

import React, { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowClockwise,
  CardsThree,
  File,
  FileText,
  PushPin,
  PushPinSlash,
  SquaresFour,
  X,
} from '@phosphor-icons/react';
import type { StoreApi } from 'zustand';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { openResource } from '@/dstu/openResource';
import type { ChatStore } from '../../core/types';
import type { Block } from '../../core/types/block';
import { extractGenerativeUIIntent } from '@/features/generative-ui/bridge/chatBlockBridge';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { AnkiCardsBlock } from '../../plugins/blocks/ankiCardsBlock';
import {
  getSessionArtifacts,
  getArtifactUserMeta,
  buildArtifactMetaPatch,
  type ArtifactEntry,
  type ArtifactKind,
} from '../../core/store/artifactRegistry';
import { useArtifactRegistrySync } from './useArtifactRegistrySync';
import { extractChanges } from '../agent-task/extractors';
import type { ChangeItem } from '../agent-task/types';

// ============================================================================
// 工具
// ============================================================================

const KIND_ICON: Record<ArtifactKind, React.ElementType> = {
  'generative-ui': SquaresFour,
  'anki-cards': CardsThree,
  note: FileText,
  file: File,
};

const KIND_LABEL_KEY: Record<ArtifactKind, string> = {
  'generative-ui': 'generativeUi',
  'anki-cards': 'ankiCards',
  note: 'note',
  file: 'file',
};

/** 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期） */
function useRelativeTime(): (ts: number) => string {
  const { t, i18n } = useTranslation('chatV2');
  return useCallback((ts: number) => {
    const delta = Date.now() - ts;
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return t('artifacts.time.justNow');
    if (minutes < 60) return t('artifacts.time.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('artifacts.time.hoursAgo', { count: hours });
    const days = Math.floor(hours / 24);
    if (days < 7) return t('artifacts.time.daysAgo', { count: days });
    return new Date(ts).toLocaleDateString(i18n.resolvedLanguage ?? i18n.language);
  }, [t, i18n]);
}

// ============================================================================
// 主组件
// ============================================================================

export interface ArtifactsPanelProps {
  sessionId: string;
  /** 会话 store（LRU 淘汰后可能为 null → 只读降级） */
  store: StoreApi<ChatStore> | null;
  onClose: () => void;
}

export const ArtifactsPanel: React.FC<ArtifactsPanelProps> = ({ sessionId, store, onClose }) => {
  const { t } = useTranslation('chatV2');
  const relativeTime = useRelativeTime();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // sessionMetadata 版本（pin 后触发重渲染）
  const [metaVersion, setMetaVersion] = useState(0);
  // 产物索引/水合/增量补齐统一由共享 hook 承担（registryVersion 仅作重取触发器——
  // getSessionArtifacts 每次新数组，不能直接喂 useSyncExternalStore）
  const { registryVersion, blocksVersion } = useArtifactRegistrySync(sessionId, store);

  const sessionMetadata = store?.getState().sessionMetadata ?? null;

  const artifacts = useMemo(() => {
    void registryVersion;
    void metaVersion;
    const list = getSessionArtifacts(sessionId);
    const visible = list.filter((a) => !getArtifactUserMeta(sessionMetadata, a.artifactId).hidden);
    // pin 优先，其余按创建时间倒序（getSessionArtifacts 已排）
    return visible.sort((a, b) => {
      const pa = getArtifactUserMeta(sessionMetadata, a.artifactId).pinned ? 1 : 0;
      const pb = getArtifactUserMeta(sessionMetadata, b.artifactId).pinned ? 1 : 0;
      return pb - pa;
    });
  }, [sessionId, registryVersion, metaVersion, sessionMetadata]);

  const selected = selectedId ? artifacts.find((a) => a.artifactId === selectedId) ?? null : null;

  // P2 变更聚合分段（薄壳）：复用 AgentTaskPanel 的 extractChanges 扫会话 blocks
  // （两壳通用的已持久化数据源——写工具块 toolOutput；ACR receipt 亦走块持久化）
  const changes = useMemo<ChangeItem[]>(() => {
    void blocksVersion;
    if (!store) return [];
    return extractChanges([...store.getState().blocks.values()]);
  }, [store, blocksVersion]);

  /** 变更条目点击：打开目标（note → DSTU_OPEN_NOTE；mindmap → 附件预览面板；其余 → openResource） */
  const openChangeTarget = useCallback((change: ChangeItem) => {
    const targetId = change.openId ?? change.target;
    if (!targetId) return;
    if (change.kind === 'note') {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
        detail: { noteId: targetId, source: 'artifacts_panel_changes' },
      }));
    } else if (change.kind === 'mindmap') {
      // 与 MindmapCitationCard 同一打开通道
      window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
        detail: { id: targetId, type: 'mindmap', title: change.label },
      }));
    } else {
      void openResource(`/${targetId}`, { handlerNamespace: 'chat-v2' });
    }
  }, []);

  // ========== 动作 ==========

  const togglePin = useCallback(async (entry: ArtifactEntry) => {
    if (!store) return;
    const current = getArtifactUserMeta(sessionMetadata, entry.artifactId);
    const next = buildArtifactMetaPatch(sessionMetadata, entry.artifactId, { pinned: !current.pinned });
    try {
      await invoke('chat_v2_update_session_settings', {
        sessionId,
        settings: { metadata: next ?? null },
      });
      store.setState({ sessionMetadata: next ?? null });
      setMetaVersion((v) => v + 1);
    } catch (error) {
      console.error('[ArtifactsPanel] pin failed:', error);
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [store, sessionId, sessionMetadata]);

  /** 刷新：快照 refreshPrompt + contextRefs 作为新消息发送（新消息新块，不覆盖历史） */
  const refreshArtifact = useCallback(async (entry: ArtifactEntry) => {
    if (!store || !entry.refreshPrompt || refreshing) return;
    setRefreshing(true);
    try {
      const state = store.getState();
      for (const ref of entry.contextRefs ?? []) {
        state.addContextRef(ref);
      }
      await state.sendMessage(entry.refreshPrompt);
    } catch (error) {
      console.error('[ArtifactsPanel] refresh failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('artifacts.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  }, [store, refreshing, t]);

  /** 在完整应用中打开（note/file） */
  const openInApp = useCallback((entry: ArtifactEntry) => {
    if (!entry.targetId) return;
    if (entry.kind === 'note') {
      window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', {
        detail: { noteId: entry.targetId, source: 'artifacts_panel' },
      }));
    } else {
      void openResource(`/${entry.targetId}`, { handlerNamespace: 'chat-v2' });
    }
  }, []);

  // ========== 详情内容 ==========

  const renderDetail = (entry: ArtifactEntry) => {
    if (!store) {
      return (
        <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
          {t('artifacts.storeUnavailable')}
        </div>
      );
    }
    const block: Block | undefined = store.getState().blocks.get(entry.artifactId);

    if (entry.kind === 'generative-ui') {
      const extracted = block
        ? extractGenerativeUIIntent(block.toolOutput, block.content, block.toolInput, block.id)
        : null;
      const intent = extracted && !extracted.isStreaming ? extracted.intent : null;
      if (!intent) {
        return (
          <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
            {t('artifacts.intentUnavailable')}
          </div>
        );
      }
      return (
        <div className="flex-1 min-h-0 overflow-auto p-3">
          {/* 标题由面板头部承担（不再传 title 避免三层标题重复）；
              forceCompact：面板宽 320-720px 远小于 sm 视口断点，强制单列紧凑布局 */}
          <GenerativeUIPanel intent={intent} forceCompact />
        </div>
      );
    }

    if (entry.kind === 'anki-cards') {
      if (!block) {
        return (
          <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
            {t('artifacts.intentUnavailable')}
          </div>
        );
      }
      return (
        <div className="flex-1 min-h-0 overflow-auto p-3">
          <AnkiCardsBlock block={block} store={store} />
        </div>
      );
    }

    // note / file：详情即「打开入口」（内容在完整应用中查看编辑）
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <p>{t('artifacts.openInAppHint')}</p>
        <DsButton variant="secondary" size="sm" onClick={() => openInApp(entry)}>
          {t('artifacts.openInApp')}
        </DsButton>
      </div>
    );
  };

  // ========== 渲染 ==========

  return (
    <div className="h-full flex flex-col bg-background">
      {/* 头部 */}
      <div className="flex items-center gap-1 px-3 h-11 border-b border-border shrink-0">
        {selected ? (
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setSelectedId(null)}
            aria-label={t('artifacts.back')} title={t('artifacts.back')}
            className="!h-7 !w-7">
            <ArrowLeft size={15} />
          </DsButton>
        ) : (
          <SquaresFour size={14} className="ml-1 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className={cn('flex-1 truncate text-sm font-medium', !selected && 'ml-1.5')}>
          {selected ? selected.title : t('artifacts.title')}
        </span>
        {selected?.refreshPrompt ? (
          <CommonTooltip content={t('artifacts.refresh')} position="bottom">
            <DsButton variant="ghost" size="icon" iconOnly disabled={refreshing || !store}
              onClick={() => void refreshArtifact(selected)}
              aria-label={t('artifacts.refresh')} title={t('artifacts.refresh')}
              className="!h-7 !w-7">
              <ArrowClockwise size={15} className={refreshing ? 'animate-spin' : undefined} />
            </DsButton>
          </CommonTooltip>
        ) : null}
        <DsButton variant="ghost" size="icon" iconOnly onClick={onClose}
          aria-label={t('artifacts.close')} title={t('artifacts.close')}
          className="!h-7 !w-7">
          <X size={15} />
        </DsButton>
      </div>

      {selected ? (
        renderDetail(selected)
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          {artifacts.length === 0 && changes.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 h-full p-6 text-center">
              <SquaresFour size={22} className="text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">{t('artifacts.empty')}</p>
              <p className="text-xs text-muted-foreground/70">{t('artifacts.emptyHint')}</p>
            </div>
          ) : (
            <>
            <ul className="py-1">
              {artifacts.map((entry) => {
                const Icon = KIND_ICON[entry.kind];
                const meta = getArtifactUserMeta(sessionMetadata, entry.artifactId);
                return (
                  <li key={entry.artifactId}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedId(entry.artifactId)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedId(entry.artifactId); }}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-3 py-2 text-left cursor-pointer',
                        'hover:bg-foreground/[0.04] transition-colors',
                      )}
                    >
                      <Icon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-sm">{meta.alias || entry.title}</span>
                        <span className="block text-xs text-muted-foreground/70">
                          {t(`artifacts.kind.${KIND_LABEL_KEY[entry.kind]}`)} · {relativeTime(entry.createdAt)}
                        </span>
                      </span>
                      <DsButton
                        variant="ghost" size="icon" iconOnly
                        onClick={(e) => { e.stopPropagation(); void togglePin(entry); }}
                        aria-label={meta.pinned ? t('artifacts.unpin') : t('artifacts.pin')}
                        title={meta.pinned ? t('artifacts.unpin') : t('artifacts.pin')}
                        className={cn('!h-6 !w-6 shrink-0', meta.pinned ? 'text-foreground' : 'text-muted-foreground/50')}
                      >
                        {meta.pinned ? <PushPinSlash size={13} /> : <PushPin size={13} />}
                      </DsButton>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* P2 变更分段（WorkBuddy「产物+变更」同构）：会话内 AI 写入/修改记录 */}
            {changes.length > 0 && (
              <div className="border-t border-border/60 mt-1">
                <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                  {t('artifacts.changes.title')}
                </div>
                <ul className="pb-1">
                  {changes.map((change) => (
                    <li key={change.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => openChangeTarget(change)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openChangeTarget(change); }}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-3 py-1.5 text-left',
                          (change.openId ?? change.target)
                            ? 'cursor-pointer hover:bg-foreground/[0.04] transition-colors'
                            : 'cursor-default opacity-80',
                        )}
                      >
                        <span className={cn(
                          'shrink-0 rounded px-1 py-px text-[10px] font-medium',
                          // 对齐 ChangesSection 语义：仅 delete 用 destructive 标红，
                          // create/update 中性浅底（颜色走 token，不手写 Tailwind 彩色）
                          change.action === 'delete'
                            ? 'bg-[color:hsl(var(--destructive)/0.1)] text-[color:hsl(var(--destructive))]'
                            : 'bg-foreground/[0.05] text-muted-foreground',
                        )}>
                          {t(`artifacts.changes.action.${change.action}`, { defaultValue: change.action })}
                        </span>
                        <span className="flex-1 min-w-0 truncate text-xs text-foreground/90">
                          {change.label}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ArtifactsPanel;
