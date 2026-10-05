/**
 * 待办「关联资料」：把笔记 / 教材 / 题目集 / 导图等挂到待办上，开始做时一键打开。
 * 资源名称 / 类型在面板里按路径现查（取值约定见 linkedResources.ts）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, Globe, MagnifyingGlass, Plus, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import * as dstuApi from '@/dstu/api';
import type { DstuNode, DstuNodeType } from '@/dstu/types';
import { getResourceIcon, type ResourceIconType } from '@/features/learning-hub/icons';
import { useRecentStore } from '@/features/learning-hub/stores/recentStore';
import { useTodoStore } from '../../../stores/useTodoStore';
import { parseAttachments, type TodoItem } from '../../../types';
import { InlineReveal } from './InlineReveal';
import { isLinkUrl, linkUrlLabel, linkedResourceValue, openLinkedResource } from './linkedResources';

const RESULT_LIMIT = 12;
const SEARCH_DEBOUNCE_MS = 300;

interface ResourceSummary {
  name: string;
  type: DstuNodeType | null;
  /** 资源已删除 / 查不到 */
  missing?: boolean;
}

const ResourceGlyph: React.FC<{ type: DstuNodeType | null }> = ({ type }) => {
  const Icon = getResourceIcon((type ?? 'file') as ResourceIconType);
  return <Icon size={16} className="shrink-0" />;
};

export const LinkedResourcesSection: React.FC<{ item: TodoItem; onSaved: () => void }> = ({ item, onSaved }) => {
  const { t } = useTranslation(['todo', 'common']);
  const updateItem = useTodoStore((s) => s.updateItem);
  const recentItems = useRecentStore((s) => s.items);
  const links = useMemo(() => parseAttachments(item.attachmentsJson), [item.attachmentsJson]);
  const [summaries, setSummaries] = useState<Record<string, ResourceSummary>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DstuNode[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 名称 / 类型：选中时已记下；面板重开时按路径现查（删掉的资源标为失效，仍可移除）
  useEffect(() => {
    const pending = links.filter((value) => !isLinkUrl(value) && !(value in summaries));
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.all(pending.map(async (value): Promise<[string, ResourceSummary]> => {
      const result = await dstuApi.get(value).catch(() => null);
      return result?.ok && result.value
        ? [value, { name: result.value.name, type: result.value.type }]
        : [value, { name: value.replace(/^\/+/, ''), type: null, missing: true }];
    })).then((entries) => {
      if (!cancelled) setSummaries((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => { cancelled = true; };
  }, [links, summaries]);

  useEffect(() => {
    const keyword = query.trim();
    if (!pickerOpen || !keyword) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void dstuApi.search(keyword).then((result) => {
        if (cancelled) return;
        setResults(result.ok ? result.value.filter((node) => node.type !== 'folder').slice(0, RESULT_LIMIT) : []);
        setSearching(false);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pickerOpen, query]);

  const save = useCallback((next: string[]) => {
    void updateItem({ id: item.id, attachments: next }).then(onSaved);
  }, [item.id, onSaved, updateItem]);

  const add = useCallback((node: Pick<DstuNode, 'id' | 'name' | 'type'>) => {
    const value = linkedResourceValue(node);
    setSummaries((prev) => ({ ...prev, [value]: { name: node.name, type: node.type } }));
    if (!links.includes(value)) save([...links, value]);
    setPickerOpen(false);
    setQuery('');
  }, [links, save]);

  const togglePicker = useCallback(() => {
    setPickerOpen((open) => {
      if (!open) requestAnimationFrame(() => inputRef.current?.focus());
      return !open;
    });
  }, []);

  // 没输入时给最近打开过的资料，一般要挂的就是刚看过的那份
  const candidates = results ?? recentItems.filter((recent) => recent.type !== 'folder').slice(0, RESULT_LIMIT);
  const linkedSet = useMemo(() => new Set(links), [links]);

  return (
    <div className="space-y-2" data-testid="todo-linked-resources">
      <div className="flex items-center justify-between gap-2">
        <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('todo:links.title')}
        </span>
        <DsButton variant="ghost" size="sm" aria-expanded={pickerOpen} onClick={togglePicker}>
          {pickerOpen ? <X size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
          {pickerOpen ? t('common:actions.cancel') : t('todo:links.add')}
        </DsButton>
      </div>

      {links.length === 0 && !pickerOpen ? (
        <p className="text-xs text-muted-foreground">{t('todo:links.empty')}</p>
      ) : null}

      {links.length > 0 ? (
        <ul className="space-y-0.5">
          {links.map((value) => {
            const summary = isLinkUrl(value) ? { name: linkUrlLabel(value), type: null } : summaries[value];
            const name = summary?.name ?? t('todo:links.loading');
            return (
              <li key={value} className="group flex items-center gap-1">
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={summary?.missing}
                  title={summary?.missing ? t('todo:links.missing') : t('todo:links.open', { name })}
                  onClick={() => openLinkedResource(value)}
                  className="!h-auto min-w-0 flex-1 !justify-start !py-1.5 !text-left !font-normal"
                >
                  {isLinkUrl(value) ? <Globe size={16} className="shrink-0" /> : <ResourceGlyph type={summary?.type ?? null} />}
                  <span className={summary?.missing ? 'truncate line-through' : 'truncate'}>{name}</span>
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={t('todo:links.remove', { name })}
                  title={t('todo:links.remove', { name })}
                  onClick={() => save(links.filter((link) => link !== value))}
                >
                  <X size={13} />
                </DsButton>
              </li>
            );
          })}
        </ul>
      ) : null}

      <InlineReveal open={pickerOpen}>
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-1.5 rounded-[var(--radius-shell-control)] border border-[color:var(--border-default)] p-2">
            <div className="relative">
              <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setPickerOpen(false);
                  }
                }}
                placeholder={t('todo:links.searchPlaceholder')}
                aria-label={t('todo:links.searchPlaceholder')}
                className="pl-8"
              />
            </div>
            <p className="px-1 text-xs text-muted-foreground">
              {results ? t('todo:links.searchResults') : t('todo:links.recent')}
            </p>
            {searching ? (
              <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
                <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t('todo:links.searching')}
              </div>
            ) : candidates.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                {results ? t('todo:links.noResults') : t('todo:links.noRecent')}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {candidates.map((node) => {
                  const linked = linkedSet.has(linkedResourceValue(node));
                  return (
                    <li key={node.id}>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        disabled={linked}
                        onClick={() => add(node)}
                        className="!h-auto !w-full !justify-start !py-1.5 !text-left !font-normal"
                      >
                        <ResourceGlyph type={node.type} />
                        <span className="min-w-0 flex-1 truncate">{node.name}</span>
                        {linked ? <span className="shrink-0 text-xs text-muted-foreground">{t('todo:links.linked')}</span> : null}
                      </DsButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </InlineReveal>
    </div>
  );
};
