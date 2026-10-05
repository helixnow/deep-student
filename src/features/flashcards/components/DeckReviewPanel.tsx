/**
 * 今日屏「按牌组复习」：牌组树 + 各牌组到期 / 新卡数，只复习某个牌组（含子牌组）。
 * 走批次复习（startBatchSession），评分计入正式记录；全局到期队列与每日上限不变。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Books, CaretDown, CaretRight, FolderSimple, Play } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { AnkiLibraryDeckCount } from '@/types';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';
import { buildDeckTree, type DeckTreeNode } from '../library/deckTree';
import { toReviewContent } from '../library/libraryView';

/** 一次牌组复习最多取的到期卡（卡片库分页上限） */
const DECK_DUE_LIMIT = 200;
/** 牌组没有到期卡时一次引入的新卡数（与「今天多学」同批量） */
const DECK_NEW_BATCH = 10;

function visibleRows(nodes: readonly DeckTreeNode[], expanded: ReadonlySet<string>): DeckTreeNode[] {
  const rows: DeckTreeNode[] = [];
  const walk = (list: readonly DeckTreeNode[]) => {
    for (const node of list) {
      rows.push(node);
      if (node.children.length > 0 && expanded.has(node.path)) walk(node.children);
    }
  };
  walk(nodes);
  return rows;
}

export const DeckReviewPanel: React.FC<{ decks: readonly AnkiLibraryDeckCount[] | null }> = ({ decks }) => {
  const { t } = useTranslation('flashcards');
  const startBatchSession = useFsrsReviewStore((s) => s.startBatchSession);
  const setScreen = useFsrsReviewStore((s) => s.setScreen);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const tree = useMemo(() => buildDeckTree(decks ?? []), [decks]);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  const deckLabel = useCallback(
    (node: DeckTreeNode) => (node.path ? node.label : t('today.decks.ungrouped')),
    [t],
  );

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // 卡片库 API / 通知 / 库 store 点击时才加载，今日屏的静态依赖保持不变（同「今天多学」）
  const startDeck = useCallback(async (node: DeckTreeNode, kind: 'due' | 'new') => {
    if (busyPath !== null) return;
    setBusyPath(node.path);
    let notify: typeof import('@/components/UnifiedNotification').showGlobalNotification | null = null;
    try {
      const [{ listAnkiLibraryCards }, { showGlobalNotification }] = await Promise.all([
        import('@/utils/chatApi'),
        import('@/components/UnifiedNotification'),
      ]);
      notify = showGlobalNotification;
      const response = await listAnkiLibraryCards({
        deck: node.path,
        status: kind,
        sort: kind === 'due' ? 'due' : 'created',
        page: 1,
        page_size: kind === 'due' ? DECK_DUE_LIMIT : DECK_NEW_BATCH,
      });
      const cards = response.items ?? [];
      if (cards.length === 0) {
        notify('info', t('today.decks.empty'));
        return;
      }
      await startBatchSession(cards.map((card) => card.id), cards.map(toReviewContent));
    } catch {
      notify?.('error', t('today.decks.failed'));
    } finally {
      setBusyPath(null);
    }
  }, [busyPath, startBatchSession, t]);

  const openInLibrary = useCallback(async (node: DeckTreeNode) => {
    const { useFlashcardsLibraryStore } = await import('../store/libraryStore');
    useFlashcardsLibraryStore.getState().setDeckFilter(node.path);
    setScreen('library');
  }, [setScreen]);

  // 只有一个牌组时与「开始复习」等价；没有任何可做的也不占今日屏
  const actionable = tree.some((node) => node.due > 0 || node.new > 0);
  if ((decks?.length ?? 0) < 2 || !actionable) return null;

  return (
    <section className="wb-fcx-panel" data-testid="fc-today-decks">
      <div className="wb-fcx-panel-head">
        <h3 className="wb-fcx-panel-title">
          <FolderSimple size={14} weight="duotone" />
          {t('today.decks.title')}
        </h3>
        <p className="wb-fcx-panel-sub">{t('today.decks.hint')}</p>
      </div>
      <ul className="wb-fc-list-ul wb-fcx-decks">
        {rows.map((node) => {
          const name = deckLabel(node);
          const isOpen = expanded.has(node.path);
          const dueCount = Math.min(node.due, DECK_DUE_LIMIT);
          const newCount = Math.min(node.new, DECK_NEW_BATCH);
          return (
            <li
              key={node.path || '::ungrouped'}
              className="wb-fcx-deck"
              style={{ '--deck-depth': node.depth } as React.CSSProperties}
            >
              {node.children.length > 0 ? (
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-expanded={isOpen}
                  aria-label={t(isOpen ? 'today.decks.collapse' : 'today.decks.expand', { name })}
                  onClick={() => toggle(node.path)}
                  className="wb-fcx-deck-toggle"
                >
                  {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
                </DsButton>
              ) : (
                <span className="wb-fcx-deck-toggle" aria-hidden="true" />
              )}
              <div className="wb-fcx-deck-main">
                <span className="wb-fcx-deck-name" title={node.path || name}>{name}</span>
                <span className="wb-fcx-deck-counts">
                  {node.due > 0 || node.new > 0
                    ? [
                        node.due > 0 ? t('today.decks.due', { count: node.due }) : null,
                        node.new > 0 ? t('today.decks.new', { count: node.new }) : null,
                      ].filter(Boolean).join(' · ')
                    : t('today.decks.nothingDue')}
                </span>
              </div>
              {node.due > 0 ? (
                <DsButton
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={busyPath !== null}
                  aria-label={t('today.decks.reviewAria', { name, count: dueCount })}
                  onClick={() => void startDeck(node, 'due')}
                  className="wb-fcx-deck-action"
                >
                  <Play size={12} weight="fill" aria-hidden="true" />
                  {t('today.decks.review', { count: dueCount })}
                </DsButton>
              ) : node.new > 0 ? (
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busyPath !== null}
                  aria-label={t('today.decks.learnNewAria', { name, count: newCount })}
                  onClick={() => void startDeck(node, 'new')}
                  className="wb-fcx-deck-action"
                >
                  {t('today.decks.learnNew', { count: newCount })}
                </DsButton>
              ) : null}
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('today.decks.openLibrary', { name })}
                title={t('today.decks.openLibrary', { name })}
                onClick={() => void openInLibrary(node)}
                className="wb-fcx-deck-library"
              >
                <Books size={14} />
              </DsButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
