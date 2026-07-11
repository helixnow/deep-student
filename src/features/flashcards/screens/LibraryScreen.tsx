/**
 * 闪卡库 — 调用 listAnkiLibraryCards
 *
 * ACR R1-15：监听 `fsrs:library-refresh` 重查；行标 data-agent-entity。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass, Stack } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { listAnkiLibraryCards } from '@/utils/chatApi';
import { getErrorMessage } from '@/utils/errorUtils';
import type { AnkiLibraryCard } from '@/types';
import { FSRS_LIBRARY_REFRESH_EVENT } from '../events';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';

const PAGE_SIZE = 40;

export const LibraryScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const startBatchSession = useFsrsReviewStore((s) => s.startBatchSession);

  const [items, setItems] = useState<AnkiLibraryCard[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (searchText: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAnkiLibraryCards({
        search: searchText.trim() || undefined,
        page: 1,
        page_size: PAGE_SIZE,
      });
      setItems(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      setItems([]);
      setTotal(0);
      setError(getErrorMessage(err) || t('library.loadFailed', '无法加载卡片库'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(query);
  }, [load, query]);

  // ACR R1-15：域事件 → driver 派发 CustomEvent → 本地 state 重查
  useEffect(() => {
    const onRefresh = () => {
      void load(query);
    };
    window.addEventListener(FSRS_LIBRARY_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(FSRS_LIBRARY_REFRESH_EVENT, onRefresh);
  }, [load, query]);

  const handleSearch = () => setQuery(search);

  const handleReviewSelected = () => {
    if (items.length === 0) return;
    void startBatchSession(
      items.map((c) => c.id),
      items.map((c) => ({
        id: c.id,
        front: c.front || c.fields?.Front || '',
        back: c.back || c.fields?.Back || c.text || '',
        tags: c.tags,
      })),
    );
  };

  return (
    <div className="wb-fc-screen">
      <header className="wb-fc-header" data-align="end">
        <div className="min-w-0">
          <h2 className="wb-fc-title">
            {t('library.title', '卡片库')}
          </h2>
          <p className="wb-fc-subtitle">
            {loading
              ? t('library.loading', '加载中…')
              : t('library.total', '共 {{count}} 张', { count: total })}
          </p>
        </div>
        <NotionButton
          type="button"
          variant="default"
          disabled={loading || items.length === 0}
          onClick={handleReviewSelected}
          className="shrink-0 text-sm"
        >
          {t('library.reviewPage', '复习本页')}
        </NotionButton>
      </header>

      <div className="wb-fc-toolbar">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearch();
            }}
            placeholder={t('library.searchPlaceholder', '搜索正面 / 标签…')}
            className="h-9 pl-8 text-sm"
          />
        </div>
        <NotionButton type="button" variant="default" onClick={handleSearch} className="text-sm">
          {t('library.search', '搜索')}
        </NotionButton>
      </div>

      <div className="wb-fc-list">
        {error ? (
          <div className="wb-fc-empty">
            <p className="text-destructive">{error}</p>
            <NotionButton type="button" variant="ghost" size="sm" onClick={() => void load(query)}>
              {t('library.retry', '重试')}
            </NotionButton>
          </div>
        ) : loading ? (
          <div className="wb-fc-loading">
            {t('library.loading', '加载中…')}
          </div>
        ) : items.length === 0 ? (
          <div className="wb-fc-empty">
            <Stack size={28} className="text-muted-foreground/50" weight="duotone" />
            <p>
              {t('library.empty', '库中暂无卡片')}
            </p>
          </div>
        ) : (
          <ul className="wb-fc-list-ul">
            {items.map((card) => (
              <li
                key={card.id}
                className="wb-fc-row"
                data-agent-entity={`flashcards:${card.id}`}
              >
                <div className="wb-fc-row-front">
                  {card.front || card.fields?.Front || t('card.untitled', '无正面')}
                </div>
                <div className="wb-fc-row-back">
                  {card.back || card.fields?.Back || card.text || t('card.noBack', '无背面')}
                </div>
                {card.tags?.length ? (
                  <div className="wb-fc-tags">
                    {card.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="wb-fc-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
