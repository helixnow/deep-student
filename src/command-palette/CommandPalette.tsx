/**
 * 命令面板 UI 组件
 * 提供模糊搜索、键盘导航、分组显示、历史/收藏等功能
 */

import React, {
  useState,
  useEffect,
  useId,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlass,
  X,
  ArrowLeft,
  ArrowElbowDownLeft,
  Star,
  Clock,
  StarHalf,
  File as FileIcon,
  Notebook,
  BookOpen,
  Exam,
  Translate,
  PenNib,
  Image as ImageIcon,
  TreeStructure,
  ChatCenteredText,
  Stack,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useCommandPalette } from './CommandPaletteProvider';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { Command, CommandCategory, CommandView, DependencyResolver } from './registry/types';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { useImeSafeControlledValue } from '@/components/ui/shad/useImeSafeControlledValue';

// 扩展分类类型，包含特殊分组
type DisplayCategory = CommandCategory | 'recent' | 'favorites' | 'files' | 'flashcards' | 'sessions';
import { CATEGORY_CONFIG, CATEGORY_LABELS } from './registry/types';
import { commandRegistry } from './registry/commandRegistry';
import { commandHistory } from './registry/commandHistory';
import { commandFavorites } from './registry/commandFavorites';
import { shortcutManager } from './registry/shortcutManager';
import { formatShortcut } from './registry/shortcutUtils';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';
import {
  useResourceSearch,
  formatDstuSearchSubtitle,
  formatFlashcardSearchSubtitle,
  openFileFromPalette,
  openFlashcardFromPalette,
  openSessionFromPalette,
} from './hooks/useResourceSearch';
import type { DstuNodeType } from '@/dstu/types';
import './styles/command-palette.css';

/** 资源命令 id 前缀（不进入命令注册表，仅在面板内即时构造） */
const RESOURCE_COMMAND_PREFIX = '__resource.';

/**
 * 面板内可聚焦控件选择器。
 *
 * 面板是 aria-modal 对话框：焦点不能逃到背景页，
 * 但必须能在搜索框 / 模式按钮 / 收藏按钮 / 关闭按钮之间流转。
 */
const PALETTE_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** DSTU 资源类型 → 图标 */
const RESOURCE_TYPE_ICONS: Partial<Record<DstuNodeType, Icon>> = {
  note: Notebook,
  textbook: BookOpen,
  exam: Exam,
  translation: Translate,
  essay: PenNib,
  image: ImageIcon,
  mindmap: TreeStructure,
};

/**
 * 按分类分组命令
 */
function groupCommandsByCategory(commands: Command[]): Map<DisplayCategory, Command[]> {
  const groups = new Map<CommandCategory, Command[]>();
  
  for (const cmd of commands) {
    const category = cmd.category;
    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(cmd);
  }
  
  // 按分类顺序排序
  const sortedGroups = new Map<DisplayCategory, Command[]>();
  const sortedCategories = Array.from(groups.keys()).sort(
    (a, b) => (CATEGORY_CONFIG[a]?.order ?? 99) - (CATEGORY_CONFIG[b]?.order ?? 99)
  );
  
  for (const category of sortedCategories) {
    sortedGroups.set(category, groups.get(category)!);
  }
  
  return sortedGroups;
}

function isCommandAvailableInCurrentContext(
  command: Command,
  currentView: CommandView,
  deps: DependencyResolver,
): boolean {
  if (command.visibleInViews?.length && !command.visibleInViews.includes(currentView)) {
    return false;
  }
  return !command.isEnabled || command.isEnabled(deps);
}

// ==================== 组件 ====================

// 视图模式
type ViewMode = 'search' | 'recent' | 'favorites';

/** 命令面板搜索范围（支持顶部芯片点击或输入前缀 > / @ / # 切换） */
export type PaletteScope = 'all' | 'commands' | 'files' | 'flashcards';

export interface ParsedPaletteQuery {
  prefixScope: Exclude<PaletteScope, 'all'> | null;
  effectiveScope: PaletteScope;
  searchTerm: string;
}

const PREFIX_TO_SCOPE: Record<string, Exclude<PaletteScope, 'all'>> = {
  '>': 'commands',
  '＞': 'commands',
  '@': 'files',
  '＠': 'files',
  '#': 'flashcards',
  '＃': 'flashcards',
};

const SCOPE_CHIPS: ReadonlyArray<{
  id: PaletteScope;
  prefix: string | null;
  labelKey: string;
  defaultLabel: string;
}> = [
  { id: 'all', prefix: null, labelKey: 'command_palette:scope_all', defaultLabel: 'All' },
  { id: 'commands', prefix: '>', labelKey: 'command_palette:scope_commands', defaultLabel: 'Commands' },
  { id: 'files', prefix: '@', labelKey: 'command_palette:scope_files', defaultLabel: 'Files' },
  { id: 'flashcards', prefix: '#', labelKey: 'command_palette:scope_flashcards', defaultLabel: 'Cards' },
];

/** 解析前缀语法（> 命令 / @ 文件与笔记 / # 闪卡）与当前选定范围 */
export function parsePaletteQuery(
  rawQuery: string,
  selectedScope: PaletteScope,
  sessionSearchOnly = false,
): ParsedPaletteQuery {
  if (sessionSearchOnly) {
    return {
      prefixScope: null,
      effectiveScope: 'all',
      searchTerm: rawQuery.trim(),
    };
  }
  const leading = rawQuery.trimStart();
  const firstChar = leading[0];
  const prefixScope = firstChar ? (PREFIX_TO_SCOPE[firstChar] ?? null) : null;
  if (prefixScope) {
    return {
      prefixScope,
      effectiveScope: prefixScope,
      searchTerm: leading.slice(1).trim(),
    };
  }
  return {
    prefixScope: null,
    effectiveScope: selectedScope,
    searchTerm: rawQuery.trim(),
  };
}

/** 点击范围芯片切换范围时剥离已有前缀，保留用户已输入的关键词 */
export function stripPaletteQueryPrefix(rawQuery: string): string {
  const leading = rawQuery.trimStart();
  const firstChar = leading[0];
  if (firstChar && PREFIX_TO_SCOPE[firstChar]) {
    return leading.slice(1).replace(/^\s+/, '');
  }
  return rawQuery;
}

/** 评估候选项标题与描述相对检索词的匹配强度（用于 >=3 字符时的内容优先排序） */
export function scorePaletteTextMatch(
  title: string,
  description: string | undefined,
  query: string,
): number {
  const normQuery = query.trim().toLowerCase();
  if (!normQuery) return 0;
  const normTitle = title.trim().toLowerCase();
  const normDesc = (description ?? '').trim().toLowerCase();

  if (normTitle === normQuery) return 100;
  if (normTitle.startsWith(normQuery)) return 85;
  if (normTitle.includes(normQuery)) return 70;

  const tokens = normQuery.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const combined = `${normTitle} ${normDesc}`;
    if (tokens.every((token) => combined.includes(token))) {
      return 55;
    }
  }
  if (normDesc && normDesc.includes(normQuery)) return 45;
  return 20;
}

/** 安全渲染大小写不敏感子串高亮（无 dangerouslySetInnerHTML，保留原生 <mark> 语义） */
export function renderHighlightedText(text: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!text || !trimmed) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const spans: Array<{ start: number; end: number }> = [];

  let cursor = 0;
  while (cursor < lowerText.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) break;
    spans.push({ start: idx, end: idx + lowerQuery.length });
    cursor = idx + lowerQuery.length;
  }

  if (spans.length === 0) {
    const tokens = Array.from(new Set(lowerQuery.split(/\s+/).filter(Boolean)))
      .sort((a, b) => b.length - a.length);
    if (tokens.length > 1) {
      const occupied = new Uint8Array(text.length);
      for (const token of tokens) {
        let pos = 0;
        while (pos < lowerText.length) {
          const idx = lowerText.indexOf(token, pos);
          if (idx === -1) break;
          let overlaps = false;
          for (let i = idx; i < idx + token.length; i += 1) {
            if (occupied[i]) {
              overlaps = true;
              break;
            }
          }
          if (!overlaps) {
            spans.push({ start: idx, end: idx + token.length });
            for (let i = idx; i < idx + token.length; i += 1) {
              occupied[i] = 1;
            }
          }
          pos = idx + token.length;
        }
      }
      spans.sort((a, b) => a.start - b.start);
    }
  }

  if (spans.length === 0) return text;

  const parts: React.ReactNode[] = [];
  let lastEnd = 0;
  for (const span of spans) {
    if (span.start > lastEnd) {
      parts.push(text.slice(lastEnd, span.start));
    }
    parts.push(
      <mark key={`${span.start}-${span.end}`} className="command-palette-highlight">
        {text.slice(span.start, span.end)}
      </mark>,
    );
    lastEnd = span.end;
  }
  if (lastEnd < text.length) {
    parts.push(text.slice(lastEnd));
  }
  return parts;
}

export function CommandPalette() {
  const { t } = useTranslation(['command_palette', 'common']);
  // 移动端没有物理键盘：快捷键徽章与键盘操作提示只在桌面显示
  const { isSmallScreen } = useBreakpoint();
  const {
    isOpen,
    close,
    searchCommands,
    executeCommand,
    deps,
    currentView,
    sessionSearchOnly,
  } = useCommandPalette();
  
  // combobox / listbox / option 之间用稳定 id 关联（aria-controls、aria-activedescendant）
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = useCallback((index: number) => `${baseId}-option-${index}`, [baseId]);
  const groupLabelId = useCallback((category: string) => `${baseId}-group-${category}`, [baseId]);

  const [query, setQuery] = useState('');
  const [selectedScope, setSelectedScope] = useState<PaletteScope>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('search');
  const [favoritesVersion, setFavoritesVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // 标记是否为键盘导航（区分鼠标悬停），只有键盘导航才触发滚动
  const isKeyboardNavRef = useRef(false);

  const { effectiveScope, searchTerm } = useMemo(
    () => parsePaletteQuery(query, selectedScope, sessionSearchOnly),
    [query, selectedScope, sessionSearchOnly],
  );
  
  // 订阅收藏变化
  useEffect(() => {
    return commandFavorites.subscribe(() => {
      setFavoritesVersion((v) => v + 1);
    });
  }, []);
  
  // 获取最近使用的命令
  const recentCommands = useMemo(() => {
    void isOpen;
    const recentIds = commandHistory.getRecentCommandIds(10);
    const commands: Command[] = [];
    for (const id of recentIds) {
      const cmd = commandRegistry.getById(id);
      if (cmd && isCommandAvailableInCurrentContext(cmd, currentView, deps)) {
        commands.push(cmd);
      }
    }
    return commands;
  }, [currentView, deps, isOpen]); // isOpen 变化时刷新
  
  // 获取收藏的命令
  const favoriteCommands = useMemo(() => {
    void favoritesVersion;
    const favoriteIds = commandFavorites.getAll();
    const commands: Command[] = [];
    for (const id of favoriteIds) {
      const cmd = commandRegistry.getById(id);
      if (cmd && isCommandAvailableInCurrentContext(cmd, currentView, deps)) {
        commands.push(cmd);
      }
    }
    return commands;
  }, [favoritesVersion, currentView, deps]);
  
  // 搜索结果（@ / # 范围仅检索资源，不混入通用命令）
  const filteredCommands = useMemo(() => {
    if (viewMode === 'recent') {
      return recentCommands;
    }
    if (viewMode === 'favorites') {
      return favoriteCommands;
    }
    if (effectiveScope === 'files' || effectiveScope === 'flashcards') {
      return [];
    }
    return searchCommands(searchTerm);
  }, [searchCommands, searchTerm, effectiveScope, viewMode, recentCommands, favoriteCommands]);

  // 资源直达搜索（文件/闪卡 ≥2 字符、会话 ≥1 字符，由 useResourceSearch 内部按各自 minChars 门控；> 仅命令范围不发资源请求）
  const wantsResources = sessionSearchOnly
    || effectiveScope === 'all'
    || effectiveScope === 'files'
    || effectiveScope === 'flashcards';
  const resourceSearchEnabled = isOpen && viewMode === 'search' && wantsResources && searchTerm.length >= 1;
  const {
    fileResults = [],
    flashcardResults = [],
    sessionResults = [],
    loading: resourceLoading,
  } = useResourceSearch(
    searchTerm,
    resourceSearchEnabled,
  );
  const isResourceSearching = resourceSearchEnabled && Boolean(resourceLoading);

  // 将资源结果转为即时命令（不进入注册表，执行时直接调用 execute），并按匹配强度组内稳定排序
  const fileCommands = useMemo<Command[]>(() => {
    if (!resourceSearchEnabled || (effectiveScope !== 'all' && effectiveScope !== 'files')) return [];
    const mapped = fileResults.map((node, index) => {
      const description = formatDstuSearchSubtitle(node);
      return {
        command: {
          id: `${RESOURCE_COMMAND_PREFIX}file.${node.id}`,
          name: node.name,
          description,
          category: 'learning' as const,
          icon: RESOURCE_TYPE_ICONS[node.type] ?? FileIcon,
          execute: (d: DependencyResolver) => { void openFileFromPalette(d, node); },
        },
        score: scorePaletteTextMatch(node.name, description, searchTerm),
        index,
      };
    });
    if (searchTerm.length > 0) {
      mapped.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    }
    return mapped.map((entry) => entry.command);
  }, [resourceSearchEnabled, effectiveScope, fileResults, searchTerm]);

  const flashcardCommands = useMemo<Command[]>(() => {
    if (!resourceSearchEnabled || (effectiveScope !== 'all' && effectiveScope !== 'flashcards')) return [];
    const mapped = flashcardResults.map((item, index) => {
      const description = formatFlashcardSearchSubtitle(item);
      return {
        command: {
          id: `${RESOURCE_COMMAND_PREFIX}flashcard.${item.cardId}`,
          name: item.front,
          description,
          category: 'anki' as const,
          icon: Stack,
          execute: (d: DependencyResolver) => { void openFlashcardFromPalette(d, item, searchTerm); },
        },
        score: scorePaletteTextMatch(item.front, description, searchTerm),
        index,
      };
    });
    if (searchTerm.length > 0) {
      mapped.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    }
    return mapped.map((entry) => entry.command);
  }, [resourceSearchEnabled, effectiveScope, flashcardResults, searchTerm]);

  const sessionCommands = useMemo<Command[]>(() => {
    if (!resourceSearchEnabled || (!sessionSearchOnly && effectiveScope !== 'all')) return [];
    const mapped = sessionResults.map((item, index) => {
      const name = item.title || t('workbench:appsPanel.untitledChat', t('command_palette:untitled', '未命名会话'));
      return {
        command: {
          id: `${RESOURCE_COMMAND_PREFIX}session.${item.sessionId}`,
          name,
          description: item.snippet,
          category: 'chat' as const,
          icon: ChatCenteredText,
          execute: (d: DependencyResolver) => { openSessionFromPalette(d, item.sessionId); },
        },
        score: scorePaletteTextMatch(name, item.snippet, searchTerm),
        index,
      };
    });
    if (searchTerm.length > 0) {
      mapped.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    }
    return mapped.map((entry) => entry.command);
  }, [resourceSearchEnabled, sessionSearchOnly, effectiveScope, sessionResults, searchTerm, t]);

  // 分组结果（搜索模式按范围筛选；全范围且查询 ≥3 字符时，强内容命中优先于通用命令）
  const groupedCommands = useMemo(() => {
    if (sessionSearchOnly) {
      return new Map<DisplayCategory, Command[]>([['sessions', sessionCommands]]);
    }
    if (viewMode === 'recent') {
      return new Map<DisplayCategory, Command[]>([['recent', filteredCommands]]);
    }
    if (viewMode === 'favorites') {
      return new Map<DisplayCategory, Command[]>([['favorites', filteredCommands]]);
    }
    if (effectiveScope === 'commands') {
      return groupCommandsByCategory(filteredCommands);
    }
    if (effectiveScope === 'files') {
      return fileCommands.length > 0
        ? new Map<DisplayCategory, Command[]>([['files', fileCommands]])
        : new Map<DisplayCategory, Command[]>();
    }
    if (effectiveScope === 'flashcards') {
      return flashcardCommands.length > 0
        ? new Map<DisplayCategory, Command[]>([['flashcards', flashcardCommands]])
        : new Map<DisplayCategory, Command[]>();
    }

    const commandGroups = groupCommandsByCategory(filteredCommands);
    const resourceGroups: Array<{
      key: 'files' | 'flashcards' | 'sessions';
      items: Command[];
      bestScore: number;
      defaultOrder: number;
    }> = [];
    if (fileCommands.length > 0) {
      resourceGroups.push({
        key: 'files',
        items: fileCommands,
        bestScore: Math.max(...fileCommands.map((cmd) => scorePaletteTextMatch(cmd.name, cmd.description, searchTerm))),
        defaultOrder: 0,
      });
    }
    if (flashcardCommands.length > 0) {
      resourceGroups.push({
        key: 'flashcards',
        items: flashcardCommands,
        bestScore: Math.max(...flashcardCommands.map((cmd) => scorePaletteTextMatch(cmd.name, cmd.description, searchTerm))),
        defaultOrder: 1,
      });
    }
    if (sessionCommands.length > 0) {
      resourceGroups.push({
        key: 'sessions',
        items: sessionCommands,
        bestScore: Math.max(...sessionCommands.map((cmd) => scorePaletteTextMatch(cmd.name, cmd.description, searchTerm))),
        defaultOrder: 2,
      });
    }

    const groups = new Map<DisplayCategory, Command[]>();
    const bestCommandScore = searchTerm.length >= 3 && filteredCommands.length > 0
      ? Math.max(
          ...filteredCommands.map((cmd) => scorePaletteTextMatch(
            t(`command_palette:commands.${cmd.id}`, cmd.name),
            cmd.description ? t(`command_palette:descriptions.${cmd.id}`, cmd.description) : undefined,
            searchTerm,
          )),
        )
      : 0;
    const bestContentScore = resourceGroups.length > 0
      ? Math.max(...resourceGroups.map((entry) => entry.bestScore))
      : 0;
    const promoteContentFirst = searchTerm.length >= 3
      && bestContentScore >= 45
      && (bestCommandScore < 85 || bestContentScore >= bestCommandScore);

    if (promoteContentFirst) {
      const sortedResources = [...resourceGroups].sort(
        (a, b) => (b.bestScore - a.bestScore) || (a.defaultOrder - b.defaultOrder),
      );
      for (const entry of sortedResources) {
        if (entry.bestScore >= 45) groups.set(entry.key, entry.items);
      }
      commandGroups.forEach((cmds, category) => groups.set(category, cmds));
      for (const entry of sortedResources) {
        if (entry.bestScore < 45) groups.set(entry.key, entry.items);
      }
      return groups;
    }

    commandGroups.forEach((cmds, category) => groups.set(category, cmds));
    for (const entry of resourceGroups) {
      groups.set(entry.key, entry.items);
    }
    return groups;
  }, [filteredCommands, viewMode, effectiveScope, searchTerm, fileCommands, flashcardCommands, sessionCommands, sessionSearchOnly, t]);
  
  // 扁平化命令列表（用于键盘导航）
  const flatCommands = useMemo(() => {
    const result: Command[] = [];
    groupedCommands.forEach((commands) => {
      result.push(...commands);
    });
    return result;
  }, [groupedCommands]);

  // 结果列表缩短时（如取消收藏末项或异步结果收窄）钳制 selectedIndex，避免高亮落空
  useEffect(() => {
    setSelectedIndex((prev) => {
      if (flatCommands.length === 0) return 0;
      return Math.min(prev, flatCommands.length - 1);
    });
  }, [flatCommands.length]);
  
  // 打开时聚焦输入框并重置状态
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedScope('all');
    setSelectedIndex(0);
    setViewMode('search');
    // 延迟聚焦，等待动画完成；清理时取消——否则打开后一帧内按 Esc，
    // 过期 rAF 会把焦点抢回正在退场/已卸载的输入框，焦点最终掉回 body
    // （读屏丢失上下文，commandPaletteA11yContract 的 Esc 用例捕获）
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, sessionSearchOnly]);

  // 关闭后把焦点还给打开面板的那个元素，避免焦点掉回 body（读屏丢失上下文）
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement;
    const restoreTarget = previouslyFocused instanceof HTMLElement ? previouslyFocused : null;
    return () => {
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus();
      }
    };
  }, [isOpen]);

  // Android 系统返回键 = 关闭面板（自绘 dialog 无 data-state，协调器 Radix 兜底覆盖不到）
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!isOpen) return;
    return registerBackHandler(() => {
      closeRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isOpen]);

  // 打开期间锁定 body 滚动，防止触屏在遮罩/列表边界拖动时背景滚动穿透
  //（与 ImageViewer 等浮层同款做法）
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // 移动端全屏内联形态：软键盘弹出时结果区随 visualViewport 收缩，避免底部结果被键盘裁切。
  // 通过 CSS 变量 --cp-viewport-height 驱动容器高度（见 command-palette.css 移动断点）。
  useEffect(() => {
    if (!isOpen || !isSmallScreen) return;
    const vv = window.visualViewport;
    const el = containerRef.current;
    if (!vv || !el) return;

    const sync = () => {
      el.style.setProperty('--cp-viewport-height', `${Math.round(vv.height)}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      el.style.removeProperty('--cp-viewport-height');
    };
  }, [isOpen, isSmallScreen]);
  
  // 执行命令并记录历史
  // 资源直达命令（files/sessions）不在注册表中：直接调用其 execute 并关闭面板
  const handleExecuteCommand = useCallback((command: Command) => {
    if (command.id.startsWith(RESOURCE_COMMAND_PREFIX)) {
      close();
      void command.execute(deps);
      return;
    }
    commandHistory.record(command.id);
    executeCommand(command.id);
  }, [executeCommand, close, deps]);
  
  // 切换收藏状态
  const handleToggleFavorite = useCallback((commandId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    commandFavorites.toggle(commandId);
  }, []);

  // 清空搜索词并将焦点归还搜索框（无结果恢复动作）
  const handleClearSearch = useCallback(() => {
    setQuery('');
    setSelectedScope('all');
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  // 点击范围芯片切换搜索范围（剥离旧前缀保留关键词）
  const handleSelectScope = useCallback((nextScope: PaletteScope) => {
    setQuery((prev) => stripPaletteQueryPrefix(prev));
    setSelectedScope(nextScope);
    setViewMode('search');
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  // 直达 AI 对话提问（无结果恢复动作）
  const handleAskAi = useCallback(() => {
    if (commandRegistry.getById('nav.goto.chat-v2')) {
      commandHistory.record('nav.goto.chat-v2');
      void executeCommand('nav.goto.chat-v2');
      return;
    }
    close();
    deps.navigate('chat-v2');
  }, [executeCommand, close, deps]);

  // 从最近/收藏空态切回全部命令视图
  const handleBrowseAll = useCallback(() => {
    setViewMode('search');
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);
  
  // 选中项变化时即时滚动到可见（仅键盘导航时触发，不设 smooth 避免长按 ↑↓ 橡皮筋滞后）
  useEffect(() => {
    if (!listRef.current || !isKeyboardNavRef.current) return;
    
    const selectedElement = listRef.current.querySelector(
      `[data-index="${selectedIndex}"]`
    ) as HTMLElement;
    
    if (selectedElement) {
      selectedElement.scrollIntoView({
        block: 'nearest',
      });
    }
    // 重置标记
    isKeyboardNavRef.current = false;
  }, [selectedIndex]);

  // 搜索词、范围或视图模式切换时复位列表滚动位置
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [query, viewMode, selectedScope]);
  
  /**
   * Tab：只把焦点圈在面板内，不再一刀切吞掉。
   *
   * 旧实现对 Tab 无条件 preventDefault，面板内的收藏 / 模式切换 / 关闭按钮
   * 对键盘和读屏用户完全不可达。现在只在到达焦点环两端时接管并回绕，
   * 中间的 Tab 交给浏览器默认行为，正常走到下一个控件。
   */
  const handleTabKey = useCallback((e: React.KeyboardEvent) => {
    const container = containerRef.current;
    if (!container) return;

    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(PALETTE_FOCUSABLE_SELECTOR),
    ).filter((el) => el.getAttribute('aria-hidden') !== 'true');

    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const isInside = active instanceof HTMLElement && container.contains(active);

    if (e.shiftKey) {
      if (!isInside || active === first) {
        e.preventDefault();
        last.focus();
      }
      return;
    }

    if (!isInside || active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 搜索框 IME 组字中的 Enter/方向键/Esc 属于输入法，不执行命令
    if (isComposingKeyEvent(e)) return;
    // Escape / Tab 与焦点所在控件无关，始终由面板处理
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      handleTabKey(e);
      return;
    }

    // 焦点已经进入面板内的按钮时，Enter 属于该按钮，
    // 不能再被「执行当前高亮命令」抢走
    const target = e.target as HTMLElement | null;
    const isOnInnerControl = target !== inputRef.current && !!target?.closest('button');
    if (isOnInnerControl && e.key === 'Enter') return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (flatCommands.length === 0) break;
        isKeyboardNavRef.current = true;
        setSelectedIndex((prev) => 
          prev < flatCommands.length - 1 ? prev + 1 : 0
        );
        break;
        
      case 'ArrowUp':
        e.preventDefault();
        if (flatCommands.length === 0) break;
        isKeyboardNavRef.current = true;
        setSelectedIndex((prev) => 
          prev > 0 ? prev - 1 : flatCommands.length - 1
        );
        break;
        
      case 'Enter':
        e.preventDefault();
        if (flatCommands[selectedIndex]) {
          const command = flatCommands[selectedIndex];
          const isEnabled = !command.isEnabled || command.isEnabled(deps);
          if (isEnabled) {
            handleExecuteCommand(command);
          } else {
            showGlobalNotification(
              'warning',
              t('command_palette:command_disabled')
            );
          }
        }
        break;
    }
  }, [flatCommands, selectedIndex, handleExecuteCommand, close, deps, t, handleTabKey]);
  
  // 点击遮罩关闭
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      close();
    }
  }, [close]);
  
  // 执行命令
  const handleCommandClick = useCallback((command: Command) => {
    handleExecuteCommand(command);
  }, [handleExecuteCommand]);

  // 搜索框受控值走 IME 组字保护：组字中不派发、不回写 DOM（#455）
  const queryInputProps = useImeSafeControlledValue<HTMLInputElement>({
    value: query,
    onChange: (e) => {
      setQuery(e.target.value);
      setSelectedIndex(0);
      if (e.target.value) {
        setViewMode('search');
      }
    },
  });

  const presence = useMotionPresence(isOpen, {
    exitMs: readCssDurationMs('--dropdown-close-dur', 150),
    enter: 'animation',
  });

  if (!presence.mounted) return null;
  
  // 计算当前命令在扁平列表中的索引
  let currentFlatIndex = 0;

  const hasResults = flatCommands.length > 0;
  const activeOptionId = hasResults && flatCommands[selectedIndex]
    ? optionId(selectedIndex)
    : undefined;
  
  return (
    <div 
      className="command-palette-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={t('command_palette:title')}
    >
      <div 
        ref={containerRef}
        className={cn(
          'command-palette-container motion-reduce:animate-none',
          isSmallScreen && 'command-palette-container-mobile',
        )}
        data-state={presence.exiting ? 'closed' : 'open'}
        onKeyDown={handleKeyDown}
      >
        {/* 搜索栏（移动端 = 全屏页顶栏：返回 + 搜索输入） */}
        <div className="command-palette-search">
          {isSmallScreen && (
            <button
              type="button"
              className="command-palette-back-btn"
              onClick={close}
              aria-label={t('common:back')}
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <div className="command-palette-input-wrapper">
            <MagnifyingGlass className="command-palette-search-icon" size={16} />
            <input
              ref={inputRef}
              type="search"
              className={cn(
                'command-palette-input motion-reduce:transition-none [&::-webkit-search-cancel-button]:hidden',
                query.length > 0 && 'pr-8',
              )}
              placeholder={sessionSearchOnly
                ? t('command_palette:session_search_placeholder', 'Search sessions...')
                : t('command_palette:search_placeholder')}
              {...queryInputProps}
              aria-label={sessionSearchOnly
                ? t('command_palette:session_search_placeholder', 'Search sessions...')
                : t('command_palette:search_placeholder')}
              // 读屏契约：搜索框是 combobox，结果列表是它控制的 listbox，
              // 高亮项通过 aria-activedescendant 播报（焦点始终留在输入框）
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={hasResults}
              aria-activedescendant={activeOptionId}
            />
            {query.length > 0 && (
              <DsButton
                type="button"
                variant="ghost"
                size="icon"
                data-testid="command-palette-input-clear"
                aria-label={t('command_palette:clear_search')}
                title={t('command_palette:clear_search')}
                onClick={handleClearSearch}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 lg:h-6 lg:w-6 rounded-md border-transparent bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors motion-reduce:transition-none"
              >
                <X size={14} />
              </DsButton>
            )}
          </div>
          {/* 模式切换按钮 */}
          {!sessionSearchOnly ? <div className="command-palette-mode-buttons">
            <button
              type="button"
              className={cn(
                'command-palette-mode-btn',
                viewMode === 'recent' && 'command-palette-mode-btn-active'
              )}
              onClick={() => {
                setViewMode(viewMode === 'recent' ? 'search' : 'recent');
                setSelectedIndex(0);
              }}
              title={t('command_palette:mode_recent')}
              aria-label={t('command_palette:mode_recent')}
              aria-pressed={viewMode === 'recent'}
            >
              <Clock size={16} />
            </button>
            <button
              type="button"
              className={cn(
                'command-palette-mode-btn',
                viewMode === 'favorites' && 'command-palette-mode-btn-active'
              )}
              onClick={() => {
                setViewMode(viewMode === 'favorites' ? 'search' : 'favorites');
                setSelectedIndex(0);
              }}
              title={t('command_palette:mode_favorites')}
              aria-label={t('command_palette:mode_favorites')}
              aria-pressed={viewMode === 'favorites'}
            >
              <Star size={16} />
            </button>
          </div> : null}
          {!isSmallScreen && (
            <button
              type="button"
              className="command-palette-close-btn"
              onClick={close}
              aria-label={t('common:close')}
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* 范围筛选芯片（> 命令 / @ 文件与笔记 / # 闪卡） */}
        {!sessionSearchOnly && viewMode === 'search' && (
          <div
            className="command-palette-scopes"
            role="toolbar"
            aria-label={t('command_palette:scope_label', 'Search scope')}
            data-testid="command-palette-scopes"
          >
            {SCOPE_CHIPS.map((chip) => {
              const isActive = effectiveScope === chip.id;
              return (
                <DsButton
                  key={chip.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid={`command-palette-scope-${chip.id}`}
                  aria-pressed={isActive}
                  onClick={() => handleSelectScope(chip.id)}
                  className={cn(
                    'command-palette-scope-chip motion-reduce:transition-none',
                    isActive && 'command-palette-scope-chip-active',
                  )}
                >
                  {chip.prefix ? (
                    <span className="command-palette-scope-prefix" aria-hidden="true">
                      {chip.prefix}
                    </span>
                  ) : null}
                  <span>{t(chip.labelKey, chip.defaultLabel)}</span>
                </DsButton>
              );
            })}
          </div>
        )}
        
        {/* 命令列表 */}
        <CustomScrollArea
          className="command-palette-scroll-area"
          viewportRef={listRef}
          viewportClassName="command-palette-list"
          viewportProps={{
            role: 'listbox',
            id: listboxId,
            'aria-label': t('command_palette:results_label', 'Command results'),
          } as React.HTMLAttributes<HTMLDivElement>}
          hideTrackWhenIdle={true}
          trackOffsetTop={4}
          trackOffsetBottom={4}
          trackOffsetRight={4}
          fullHeight={false}
        >
          {flatCommands.length === 0 ? (
            isResourceSearching ? (
              <div
                className="command-palette-empty"
                role="status"
                data-testid="command-palette-searching"
              >
                {t('command_palette:resource_searching')}
              </div>
            ) : sessionSearchOnly && searchTerm.length < 2 ? (
              <div
                className="command-palette-empty"
                role="status"
                data-testid="command-palette-session-min-chars"
              >
                {t('command_palette:session_search_min_chars')}
              </div>
            ) : viewMode === 'search' && effectiveScope === 'files' && searchTerm.length < 2 ? (
              <div
                className="command-palette-empty"
                role="status"
                data-testid="command-palette-scope-min-chars"
              >
                {t('command_palette:scope_files_min_chars', 'Type at least 2 characters to search files and notes')}
              </div>
            ) : viewMode === 'search' && effectiveScope === 'flashcards' && searchTerm.length < 2 ? (
              <div
                className="command-palette-empty"
                role="status"
                data-testid="command-palette-scope-min-chars"
              >
                {t('command_palette:scope_flashcards_min_chars', 'Type at least 2 characters to search flashcards')}
              </div>
            ) : (
              <div
                className="command-palette-empty flex flex-col items-center justify-center gap-1.5"
                role="status"
                data-testid="command-palette-empty"
              >
                <div className="font-medium text-foreground/85">
                  {viewMode === 'recent'
                    ? t('command_palette:no_recent')
                    : viewMode === 'favorites'
                      ? t('command_palette:no_favorites')
                      : t('command_palette:no_results')}
                </div>
                {viewMode === 'search' && (searchTerm.length > 0 || effectiveScope !== 'all') ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      {t('command_palette:no_results_hint')}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
                      <DsButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        data-testid="command-palette-clear-search"
                        onClick={handleClearSearch}
                        className="h-auto lg:h-7 px-3 py-1.5 text-xs rounded-lg border-border/60 bg-background/80 text-foreground hover:bg-muted active:scale-[0.98] transition-[background-color,border-color,color,transform] duration-150 motion-reduce:transition-none motion-reduce:active:scale-100"
                      >
                        {t('command_palette:clear_search')}
                      </DsButton>
                      {!sessionSearchOnly && (
                        <DsButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          data-testid="command-palette-ask-ai"
                          onClick={handleAskAi}
                          className="h-auto lg:h-7 gap-1.5 px-3 py-1.5 text-xs rounded-lg border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary active:scale-[0.98] transition-[background-color,border-color,color,transform] duration-150 motion-reduce:transition-none motion-reduce:active:scale-100"
                        >
                          <ChatCenteredText size={14} />
                          <span>{t('command_palette:ask_ai')}</span>
                        </DsButton>
                      )}
                    </div>
                  </>
                ) : viewMode === 'recent' || viewMode === 'favorites' ? (
                  <div className="mt-2">
                    <DsButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="command-palette-browse-all"
                      onClick={handleBrowseAll}
                      className="h-auto lg:h-7 px-3 py-1.5 text-xs rounded-lg border-border/60 bg-background/80 text-foreground hover:bg-muted active:scale-[0.98] transition-[background-color,border-color,color,transform] duration-150 motion-reduce:transition-none motion-reduce:active:scale-100"
                    >
                      {t('command_palette:browse_all_commands')}
                    </DsButton>
                  </div>
                ) : null}
              </div>
            )
          ) : (
            <>
              {Array.from(groupedCommands.entries()).map(([category, commands]) => {
                // 处理特殊分组标签
                let categoryLabel: string;
                if (category === 'recent') {
                  categoryLabel = t('command_palette:mode_recent');
                } else if (category === 'favorites') {
                  categoryLabel = t('command_palette:mode_favorites');
                } else if (category === 'files') {
                  categoryLabel = t('command_palette:resource_files');
                } else if (category === 'flashcards') {
                  categoryLabel = t('command_palette:resource_flashcards', { defaultValue: '闪卡' });
                } else if (category === 'sessions') {
                  categoryLabel = t('command_palette:resource_sessions');
                } else {
                  categoryLabel = t(
                    `command_palette:categories.${category}`,
                    { defaultValue: CATEGORY_LABELS[category as CommandCategory] || category }
                  );
                }

                return (
                  <div
                    key={category}
                    className="command-palette-group"
                    role="group"
                    aria-labelledby={groupLabelId(category)}
                  >
                    <div className="command-palette-group-label" id={groupLabelId(category)}>
                      {categoryLabel}
                    </div>
                    {commands.map((command) => {
                      const flatIndex = currentFlatIndex++;
                      const isSelected = flatIndex === selectedIndex;
                      const isEnabled = !command.isEnabled || command.isEnabled(deps);
                      const Icon = command.icon;
                      const isResource = command.id.startsWith(RESOURCE_COMMAND_PREFIX);
                      const displayName = isResource
                        ? command.name
                        : t(`command_palette:commands.${command.id}`, command.name);
                      const displayDescription = command.description
                        ? (isResource
                            ? command.description
                            : t(`command_palette:descriptions.${command.id}`, command.description))
                        : '';
                      const highlightNeedle = viewMode === 'search' ? searchTerm : '';

                      return (
                        <div
                          key={command.id}
                          id={optionId(flatIndex)}
                          data-index={flatIndex}
                          className={cn(
                            'command-palette-item motion-reduce:transition-none',
                            isSelected && 'command-palette-item-selected',
                            !isEnabled && 'command-palette-item-disabled'
                          )}
                          onClick={() => isEnabled && handleCommandClick(command)}
                          onMouseEnter={() => setSelectedIndex(flatIndex)}
                          role="option"
                          aria-selected={isSelected}
                          aria-disabled={!isEnabled}
                        >
                          <div className="command-palette-item-left">
                            {Icon && <Icon className="command-palette-item-icon" size={16} />}
                            <span className="command-palette-item-name">
                              {highlightNeedle ? renderHighlightedText(displayName, highlightNeedle) : displayName}
                            </span>
                            {displayDescription && (
                              <span className="command-palette-item-description">
                                {highlightNeedle
                                  ? renderHighlightedText(displayDescription, highlightNeedle)
                                  : displayDescription}
                              </span>
                            )}
                          </div>
                          {/* 收藏按钮（资源直达项为动态结果，不支持收藏） */}
                          {!isResource && (
                            <button
                              type="button"
                              className={cn(
                                'command-palette-item-favorite motion-reduce:transition-none',
                                commandFavorites.isFavorite(command.id) && 'command-palette-item-favorite-active'
                              )}
                              onClick={(e) => handleToggleFavorite(command.id, e)}
                              title={commandFavorites.isFavorite(command.id)
                                ? t('command_palette:unfavorite')
                                : t('command_palette:favorite')
                              }
                              // 图标按钮：读屏可访问名 = 收藏/取消收藏 + 命令名
                              aria-label={`${commandFavorites.isFavorite(command.id)
                                ? t('command_palette:unfavorite')
                                : t('command_palette:favorite')} — ${command.name}`}
                              aria-pressed={commandFavorites.isFavorite(command.id)}
                            >
                              {commandFavorites.isFavorite(command.id) ? (
                                <Star size={14} className="fill-current" />
                              ) : (
                                <StarHalf size={14} />
                              )}
                            </button>
                          )}
                          {/* 显示有效快捷键（优先使用自定义快捷键） */}
                          {!isResource && !isSmallScreen && (() => {
                            const effectiveShortcut = shortcutManager.getShortcut(command.id);
                            return effectiveShortcut ? (
                              <div className="command-palette-item-shortcut">
                                {formatShortcut(effectiveShortcut)}
                              </div>
                            ) : null;
                          })()}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {isResourceSearching && (
                <div
                  className="px-3 py-2 text-xs text-muted-foreground"
                  role="status"
                  data-testid="command-palette-searching-more"
                >
                  {t('command_palette:resource_searching')}
                </div>
              )}
            </>
          )}
        </CustomScrollArea>

        {query.trim().length > 0 && (
          <div
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="command-palette-result-status"
          >
            {isResourceSearching
              ? t('command_palette:resource_searching')
              : t('command_palette:result_count', { count: flatCommands.length })}
          </div>
        )}
        
        {/* 底部提示（键盘操作提示，仅桌面显示） */}
        {!isSmallScreen && (
        <div className="command-palette-footer">
          <div className="command-palette-hint">
            <span className="command-palette-hint-key">↑↓</span>
            <span>{t('command_palette:hint_navigate')}</span>
          </div>
          <div className="command-palette-hint">
            <span className="command-palette-hint-key" aria-hidden="true">
              <ArrowElbowDownLeft size={12} />
            </span>
            <span>{t('command_palette:hint_execute')}</span>
          </div>
          <div className="command-palette-hint">
            <span className="command-palette-hint-key">Tab</span>
            <span>{t('command_palette:hint_switch')}</span>
          </div>
          <div className="command-palette-hint">
            <span className="command-palette-hint-key">Esc</span>
            <span>{t('command_palette:hint_close')}</span>
          </div>
          {query.trim().length > 0 && !isResourceSearching && (
            <span
              data-testid="command-palette-footer-count"
              className="ml-auto font-mono tabular-nums text-xs text-muted-foreground"
            >
              {t('command_palette:result_count', { count: flatCommands.length })}
            </span>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

export default CommandPalette;
