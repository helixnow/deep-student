/**
 * LanguageSelect - 翻译模块专用语言选择器
 *
 * 基于 AppMenu 锚定浮层（复用 --menu-shell-* / --dropdown-* token，
 * 深浅色模式与开合动画自动跟随主题）：
 * - 搜索过滤：本地化名 / 英文名 / 原生名 / 拼音 / 语言代码 均可命中
 * - 常用语言记忆：localStorage 记录最近使用，置顶展示
 * - includeAuto 时提供“自动检测”项，detectedLanguage 传入后展示“自动检测 · 中文”
 * - 键盘：↑/↓ 移动、Enter 选择（搜索框内 Enter 直选第一项）、Esc 关闭
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { CaretDown, ClockCounterClockwise, Globe, Sparkle } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSeparator,
} from '../ui/app-menu';

export interface LanguageSelectProps {
  value: string;
  onChange: (code: string) => void;
  languages: { code: string; label: string }[];
  includeAuto?: boolean;
  detectedLanguage?: string | null;
  disabled?: boolean;
  className?: string;
}

const RECENT_STORAGE_KEY = 'translation.recentLanguages.v1';
const RECENT_LIMIT = 5;

/**
 * 搜索别名表：英文名 / 原生名 / 拼音。
 * label（本地化名）与 code 始终参与匹配，此表仅补充别名。
 */
const LANGUAGE_ALIASES: Record<string, string[]> = {
  auto: ['auto', 'detect', 'auto detect', '自动检测', 'zidong', 'zidongjiance'],
  'zh-CN': ['chinese', 'simplified chinese', '简体中文', '中文', 'zhongwen', 'jiantizhongwen', 'hanyu'],
  'zh-TW': ['chinese', 'traditional chinese', '繁體中文', '繁体中文', 'zhongwen', 'fantizhongwen'],
  en: ['english', 'yingyu', 'yingwen'],
  ja: ['japanese', '日本語', 'riyu', 'ribenyu'],
  ko: ['korean', '한국어', 'hanyu', 'chaoxianyu', 'hanguoyu'],
  fr: ['french', 'français', 'fayu'],
  de: ['german', 'deutsch', 'deyu'],
  es: ['spanish', 'español', 'xibanyayu'],
  ru: ['russian', 'русский', 'eyu', 'eluosiyu'],
  ar: ['arabic', 'العربية', 'alaboyu'],
  pt: ['portuguese', 'português', 'putaoyayu'],
  'pt-BR': ['portuguese', 'brazilian portuguese', 'português', 'baxiputaoyayu'],
  it: ['italian', 'italiano', 'yidaliyu'],
  vi: ['vietnamese', 'tiếng việt', 'yuenanyu'],
  th: ['thai', 'ไทย', 'taiyu'],
  hi: ['hindi', 'हिन्दी', 'yindiyu'],
  tr: ['turkish', 'türkçe', 'tuerqiyu'],
  pl: ['polish', 'polski', 'bolanyu'],
  nl: ['dutch', 'nederlands', 'helanyu'],
  sv: ['swedish', 'svenska', 'ruidianyu'],
  la: ['latin', 'latina', 'ladingyu'],
  el: ['greek', 'ελληνικά', 'xilayu'],
  uk: ['ukrainian', 'українська', 'wukelanyu'],
  id: ['indonesian', 'bahasa indonesia', 'yinniyu', 'yindunixiyayu'],
  ms: ['malay', 'bahasa melayu', 'malaiyu'],
};

function readRecentLanguages(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecentLanguages(codes: string[]) {
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(codes.slice(0, RECENT_LIMIT)));
  } catch {
    // localStorage 不可用时静默降级（仅失去常用记忆）
  }
}

function matchesQuery(
  query: string,
  code: string,
  label: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (label.toLowerCase().includes(q)) return true;
  if (code.toLowerCase().includes(q)) return true;
  const aliases = LANGUAGE_ALIASES[code];
  return !!aliases && aliases.some((alias) => alias.toLowerCase().includes(q));
}

export const LanguageSelect: React.FC<LanguageSelectProps> = ({
  value,
  onChange,
  languages,
  includeAuto = false,
  detectedLanguage = null,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation(['translation']);
  const [query, setQuery] = React.useState('');
  const [recentCodes, setRecentCodes] = React.useState<string[]>(() => readRecentLanguages());

  // 'auto' 一律由 includeAuto 控制渲染，从传入列表中剔除避免重复
  const selectableLanguages = React.useMemo(
    () => languages.filter((lang) => lang.code !== 'auto'),
    [languages],
  );

  const labelOf = React.useCallback(
    (code: string) => selectableLanguages.find((lang) => lang.code === code)?.label ?? code,
    [selectableLanguages],
  );

  // detectedLanguage 可能是语言代码也可能是现成文案：代码可解析时显示本地化名
  const detectedLabel = React.useMemo(() => {
    if (!detectedLanguage) return null;
    const fromList = selectableLanguages.find((lang) => lang.code === detectedLanguage);
    return fromList ? fromList.label : detectedLanguage;
  }, [detectedLanguage, selectableLanguages]);

  const autoLabel = t('translation:language_select.auto_detect');
  const autoTriggerLabel = detectedLabel
    ? t('translation:language_select.detected', { language: detectedLabel })
    : autoLabel;

  const triggerLabel = value === 'auto' ? autoTriggerLabel : labelOf(value);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  const autoMatches = includeAuto && matchesQuery(trimmedQuery, 'auto', autoLabel);
  const filteredLanguages = React.useMemo(
    () => selectableLanguages.filter((lang) => matchesQuery(trimmedQuery, lang.code, lang.label)),
    [selectableLanguages, trimmedQuery],
  );

  const recentLanguages = React.useMemo(
    () =>
      recentCodes
        .map((code) => selectableLanguages.find((lang) => lang.code === code))
        .filter((lang): lang is { code: string; label: string } => !!lang),
    [recentCodes, selectableLanguages],
  );

  const handleSelect = React.useCallback(
    (code: string) => {
      onChange(code);
      if (code !== 'auto') {
        // 与其他实例（源/目标语并存）共享同一份记忆，选择时以磁盘状态为准合并
        const merged = [code, ...readRecentLanguages().filter((c) => c !== code)].slice(0, RECENT_LIMIT);
        writeRecentLanguages(merged);
        setRecentCodes(merged);
      }
    },
    [onChange],
  );

  const handleOpenChange = React.useCallback((open: boolean) => {
    if (open) {
      setRecentCodes(readRecentLanguages());
    } else {
      setQuery('');
    }
  }, []);

  // 搜索框内直接回车：等价于点击第一条匹配项（复用 AppMenuItem 的选中+关闭路径）
  const handleContentKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter') return;
      if (!(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      const firstItem = event.currentTarget.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])',
      );
      firstItem?.click();
    },
    [],
  );

  const renderLanguageItem = (lang: { code: string; label: string }, keyPrefix = '') => {
    const isDetected = includeAuto && detectedLanguage === lang.code;
    return (
      <AppMenuItem
        key={`${keyPrefix}${lang.code}`}
        checked={value === lang.code}
        onClick={() => handleSelect(lang.code)}
      >
        <span className="flex items-baseline gap-2 min-w-0">
          <span className={cn('truncate', isDetected && 'text-primary font-medium')}>{lang.label}</span>
          <span className="text-xs text-[var(--menu-shell-muted-foreground)] uppercase shrink-0">
            {lang.code}
          </span>
          {isDetected && (
            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[10px] leading-tight text-primary">
              {t('translation:workbench_core.detected_badge')}
            </span>
          )}
        </span>
      </AppMenuItem>
    );
  };

  const autoItem = (
    <AppMenuItem
      key="auto"
      icon={<Sparkle size={15} />}
      checked={value === 'auto'}
      onClick={() => handleSelect('auto')}
    >
      <span className="flex items-baseline gap-1.5 min-w-0">
        <span className="shrink-0">{autoLabel}</span>
        {detectedLabel && (
          <span className="truncate text-xs text-[var(--menu-shell-muted-foreground)]">
            · {detectedLabel}
          </span>
        )}
      </span>
    </AppMenuItem>
  );

  const hasAnyResult = autoMatches || filteredLanguages.length > 0;

  return (
    <AppMenu onOpenChange={handleOpenChange} className={cn(className?.includes('flex-1') && 'flex-1 min-w-0')}>
      <AppMenuTrigger asChild>
        <DsButton
          variant="ghost"
          disabled={disabled}
          aria-label={t('translation:language_select.trigger_label')}
          className={cn(
            '!inline-flex !justify-between !gap-1.5 !rounded-md font-medium',
            'h-8 px-2.5 text-sm',
            'disabled:pointer-events-none disabled:opacity-50',
            className,
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <CaretDown size={14} className="shrink-0 opacity-50" />
        </DsButton>
      </AppMenuTrigger>

      <AppMenuContent
        width={244}
        maxHeight={340}
        showSearch
        searchPlaceholder={t('translation:language_select.search_placeholder')}
        searchValue={query}
        onSearchChange={setQuery}
        onKeyDown={handleContentKeyDown}
      >
        {isSearching ? (
          hasAnyResult ? (
            <>
              {autoMatches && autoItem}
              {filteredLanguages.map((lang) => renderLanguageItem(lang))}
            </>
          ) : (
            <div className="px-2.5 py-3 text-xs text-center text-[var(--menu-shell-muted-foreground)]">
              {t('translation:language_select.no_results')}
            </div>
          )
        ) : (
          <>
            {includeAuto && (
              <>
                {autoItem}
                <AppMenuSeparator />
              </>
            )}
            {recentLanguages.length > 0 && (
              <AppMenuGroup label={t('translation:language_select.recent')}>
                {recentLanguages.map((lang) => (
                  <AppMenuItem
                    key={`recent-${lang.code}`}
                    icon={<ClockCounterClockwise size={15} />}
                    checked={value === lang.code}
                    onClick={() => handleSelect(lang.code)}
                  >
                    <span className="truncate">{lang.label}</span>
                  </AppMenuItem>
                ))}
              </AppMenuGroup>
            )}
            <AppMenuGroup
              label={
                recentLanguages.length > 0 || includeAuto
                  ? t('translation:language_select.all')
                  : undefined
              }
            >
              {selectableLanguages.length > 0 ? (
                selectableLanguages.map((lang) => renderLanguageItem(lang, 'all-'))
              ) : (
                <div className="px-2.5 py-3 text-xs text-center text-[var(--menu-shell-muted-foreground)]">
                  <Globe size={14} className="inline-block mr-1 align-[-2px]" />
                  {t('translation:language_select.no_results')}
                </div>
              )}
            </AppMenuGroup>
          </>
        )}
      </AppMenuContent>
    </AppMenu>
  );
};

export default LanguageSelect;
