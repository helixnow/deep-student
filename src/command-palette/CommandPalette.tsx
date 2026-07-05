/**
 * 命令面板 UI 组件
 * 提供模糊搜索、键盘导航、分组显示、历史/收藏等功能
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlass,
  X,
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
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useCommandPalette } from './CommandPaletteProvider';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { Command, CommandCategory } from './registry/types';

// 扩展分类类型，包含特殊分组
type DisplayCategory = CommandCategory | 'recent' | 'favorites' | 'files' | 'sessions';
import { CATEGORY_CONFIG, CATEGORY_LABELS } from './registry/types';
import { commandRegistry } from './registry/commandRegistry';
import { commandHistory } from './registry/commandHistory';
import { commandFavorites } from './registry/commandFavorites';
import { shortcutManager } from './registry/shortcutManager';
import { formatShortcut } from './registry/shortcutUtils';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import {
  useResourceSearch,
  openFileFromPalette,
  openSessionFromPalette,
} from './hooks/useResourceSearch';
import type { DstuNodeType } from '@/dstu/types';
import './styles/command-palette.css';

/** 资源命令 id 前缀（不进入命令注册表，仅在面板内即时构造） */
const RESOURCE_COMMAND_PREFIX = '__resource.';

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

// ==================== 组件 ====================

// 视图模式
type ViewMode = 'search' | 'recent' | 'favorites';

export function CommandPalette() {
  const { t } = useTranslation(['command_palette', 'common']);
  // 移动端没有物理键盘：快捷键徽章与键盘操作提示只在桌面显示
  const { isSmallScreen } = useBreakpoint();
  const { isOpen, close, searchCommands, executeCommand, deps, currentView } = useCommandPalette();
  
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('search');
  const [favoritesVersion, setFavoritesVersion] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 标记是否为键盘导航（区分鼠标悬停），只有键盘导航才触发滚动
  const isKeyboardNavRef = useRef(false);
  
  // 订阅收藏变化
  useEffect(() => {
    return commandFavorites.subscribe(() => {
      setFavoritesVersion((v) => v + 1);
    });
  }, []);
  
  // 获取最近使用的命令
  const recentCommands = useMemo(() => {
    const recentIds = commandHistory.getRecentCommandIds(10);
    const commands: Command[] = [];
    for (const id of recentIds) {
      const cmd = commandRegistry.getById(id);
      if (cmd) {
        // 检查视图限制
        if (!cmd.visibleInViews || cmd.visibleInViews.length === 0 || cmd.visibleInViews.includes(currentView)) {
          commands.push(cmd);
        }
      }
    }
    return commands;
  }, [currentView, isOpen]); // isOpen 变化时刷新
  
  // 获取收藏的命令
  const favoriteCommands = useMemo(() => {
    const favoriteIds = commandFavorites.getAll();
    const commands: Command[] = [];
    for (const id of favoriteIds) {
      const cmd = commandRegistry.getById(id);
      if (cmd) {
        commands.push(cmd);
      }
    }
    return commands;
  }, [favoritesVersion]);
  
  // 搜索结果
  const filteredCommands = useMemo(() => {
    if (viewMode === 'recent') {
      return recentCommands;
    }
    if (viewMode === 'favorites') {
      return favoriteCommands;
    }
    return searchCommands(query);
  }, [searchCommands, query, viewMode, recentCommands, favoriteCommands]);

  // 资源直达搜索（文件 + 会话），仅在搜索模式且输入 ≥2 字符时启用
  const resourceSearchEnabled = isOpen && viewMode === 'search' && query.trim().length >= 2;
  const { fileResults, sessionResults } = useResourceSearch(query, resourceSearchEnabled);

  // 将资源结果转为即时命令（不进入注册表，执行时直接调用 execute）
  const fileCommands = useMemo<Command[]>(() => {
    if (!resourceSearchEnabled) return [];
    return fileResults.map((node) => ({
      id: `${RESOURCE_COMMAND_PREFIX}file.${node.id}`,
      name: node.name,
      description: node.path,
      category: 'learning',
      icon: RESOURCE_TYPE_ICONS[node.type] ?? FileIcon,
      execute: (d) => { void openFileFromPalette(d, node); },
    }));
  }, [resourceSearchEnabled, fileResults]);

  const sessionCommands = useMemo<Command[]>(() => {
    if (!resourceSearchEnabled) return [];
    return sessionResults.map((item) => ({
      id: `${RESOURCE_COMMAND_PREFIX}session.${item.sessionId}`,
      name: item.title || t('command_palette:untitled', '未命名'),
      description: item.snippet,
      category: 'chat',
      icon: ChatCenteredText,
      execute: (d) => { openSessionFromPalette(d, item.sessionId); },
    }));
  }, [resourceSearchEnabled, sessionResults, t]);

  // 分组结果（搜索模式按分类分组，最近/收藏模式显示为单独分组）
  const groupedCommands = useMemo(() => {
    if (viewMode === 'recent') {
      // 最近使用模式，显示为单独分组
      return new Map<DisplayCategory, Command[]>([['recent', filteredCommands]]);
    }
    if (viewMode === 'favorites') {
      // 收藏模式，显示为单独分组
      return new Map<DisplayCategory, Command[]>([['favorites', filteredCommands]]);
    }
    // 搜索模式按分类分组显示，资源直达分组追加在命令之后
    const groups = groupCommandsByCategory(filteredCommands) as Map<DisplayCategory, Command[]>;
    if (fileCommands.length > 0) {
      groups.set('files', fileCommands);
    }
    if (sessionCommands.length > 0) {
      groups.set('sessions', sessionCommands);
    }
    return groups;
  }, [filteredCommands, viewMode, fileCommands, sessionCommands]);
  
  // 扁平化命令列表（用于键盘导航）
  const flatCommands = useMemo(() => {
    const result: Command[] = [];
    groupedCommands.forEach((commands) => {
      result.push(...commands);
    });
    return result;
  }, [groupedCommands]);
  
  // 打开时聚焦输入框并重置状态
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setViewMode('search');
      // 延迟聚焦，等待动画完成
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
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
  
  // 选中项变化时滚动到可见（仅键盘导航时触发，避免鼠标滚动回弹）
  useEffect(() => {
    if (!listRef.current || !isKeyboardNavRef.current) return;
    
    const selectedElement = listRef.current.querySelector(
      `[data-index="${selectedIndex}"]`
    ) as HTMLElement;
    
    if (selectedElement) {
      selectedElement.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
    // 重置标记
    isKeyboardNavRef.current = false;
  }, [selectedIndex]);
  
  // 键盘事件处理
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        isKeyboardNavRef.current = true;
        setSelectedIndex((prev) => 
          prev < flatCommands.length - 1 ? prev + 1 : 0
        );
        break;
        
      case 'ArrowUp':
        e.preventDefault();
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
              t('command_palette:command_disabled', '该命令当前不可用')
            );
          }
        }
        break;
        
      case 'Escape':
        e.preventDefault();
        close();
        break;
        
      case 'Tab':
        // 阻止 Tab 离开面板
        e.preventDefault();
        break;
    }
  }, [flatCommands, selectedIndex, handleExecuteCommand, close, deps, t]);
  
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
  
  if (!isOpen) return null;
  
  // 计算当前命令在扁平列表中的索引
  let currentFlatIndex = 0;
  
  return (
    <div 
      className="command-palette-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={t('command_palette:title', '命令面板')}
    >
      <div 
        className="command-palette-container"
        onKeyDown={handleKeyDown}
      >
        {/* 搜索栏 */}
        <div className="command-palette-search">
          <div className="command-palette-input-wrapper">
            <MagnifyingGlass className="command-palette-search-icon" size={16} />
            <input
              ref={inputRef}
              type="text"
              className="command-palette-input"
              placeholder={t('command_palette:search_placeholder', '搜索命令...')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
                if (e.target.value) {
                  setViewMode('search');
                }
              }}
              aria-label={t('command_palette:search_placeholder', '搜索命令...')}
            />
          </div>
          {/* 模式切换按钮 */}
          <div className="command-palette-mode-buttons">
            <button
              className={cn(
                'command-palette-mode-btn',
                viewMode === 'recent' && 'command-palette-mode-btn-active'
              )}
              onClick={() => {
                setViewMode(viewMode === 'recent' ? 'search' : 'recent');
                setSelectedIndex(0);
              }}
              title={t('command_palette:mode_recent', '最近使用')}
            >
              <Clock size={16} />
            </button>
            <button
              className={cn(
                'command-palette-mode-btn',
                viewMode === 'favorites' && 'command-palette-mode-btn-active'
              )}
              onClick={() => {
                setViewMode(viewMode === 'favorites' ? 'search' : 'favorites');
                setSelectedIndex(0);
              }}
              title={t('command_palette:mode_favorites', '收藏')}
            >
              <Star size={16} />
            </button>
          </div>
          <button
            className="command-palette-close-btn"
            onClick={close}
            aria-label={t('common:close', '关闭')}
          >
            <X size={18} />
          </button>
        </div>
        
        {/* 命令列表 */}
        <CustomScrollArea
          className="command-palette-scroll-area"
          viewportRef={listRef}
          viewportClassName="command-palette-list"
          viewportProps={{ role: 'listbox' }}
          hideTrackWhenIdle={true}
          trackOffsetTop={4}
          trackOffsetBottom={4}
          trackOffsetRight={4}
          fullHeight={false}
        >
          {flatCommands.length === 0 ? (
            <div className="command-palette-empty">
              {viewMode === 'recent'
                ? t('command_palette:no_recent', '暂无最近使用的命令')
                : viewMode === 'favorites'
                ? t('command_palette:no_favorites', '暂无收藏的命令')
                : t('command_palette:no_results', '未找到匹配的命令')}
            </div>
          ) : (
            Array.from(groupedCommands.entries()).map(([category, commands]) => {
              // 处理特殊分组标签
              let categoryLabel: string;
              if (category === 'recent') {
                categoryLabel = t('command_palette:mode_recent', '最近使用');
              } else if (category === 'favorites') {
                categoryLabel = t('command_palette:mode_favorites', '收藏');
              } else if (category === 'files') {
                categoryLabel = t('command_palette:resource_files', '文件');
              } else if (category === 'sessions') {
                categoryLabel = t('command_palette:resource_sessions', '会话');
              } else {
                categoryLabel = t(
                  `command_palette:categories.${category}`,
                  { defaultValue: CATEGORY_LABELS[category as CommandCategory] || category }
                );
              }

              return (
                <div key={category} className="command-palette-group">
                  <div className="command-palette-group-label">
                    {categoryLabel}
                  </div>
                  {commands.map((command) => {
                    const flatIndex = currentFlatIndex++;
                    const isSelected = flatIndex === selectedIndex;
                    const isEnabled = !command.isEnabled || command.isEnabled(deps);
                    const Icon = command.icon;
                    const isResource = command.id.startsWith(RESOURCE_COMMAND_PREFIX);

                    return (
                      <div
                        key={command.id}
                        data-index={flatIndex}
                        className={cn(
                          'command-palette-item',
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
                            {isResource ? command.name : t(`command_palette:commands.${command.id}`, command.name)}
                          </span>
                          {command.description && (
                            <span className="command-palette-item-description">
                              {isResource ? command.description : t(`command_palette:descriptions.${command.id}`, command.description)}
                            </span>
                          )}
                        </div>
                        {/* 收藏按钮（资源直达项为动态结果，不支持收藏） */}
                        {!isResource && (
                          <button
                            className={cn(
                              'command-palette-item-favorite',
                              commandFavorites.isFavorite(command.id) && 'command-palette-item-favorite-active'
                            )}
                            onClick={(e) => handleToggleFavorite(command.id, e)}
                            title={commandFavorites.isFavorite(command.id)
                              ? t('command_palette:unfavorite', '取消收藏')
                              : t('command_palette:favorite', '收藏')
                            }
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
            })
          )}
        </CustomScrollArea>
        
        {/* 底部提示（键盘操作提示，仅桌面显示） */}
        {!isSmallScreen && (
        <div className="command-palette-footer">
          <div className="command-palette-hint">
            <span className="command-palette-hint-key">↑↓</span>
            <span>{t('command_palette:hint_navigate', '导航')}</span>
          </div>
          <div className="command-palette-hint">
            <span className="command-palette-hint-key">
              <ArrowElbowDownLeft size={12} />
            </span>
            <span>{t('command_palette:hint_execute', '执行')}</span>
          </div>
          <div className="command-palette-hint">
            <span className="command-palette-hint-key">Esc</span>
            <span>{t('command_palette:hint_close', '关闭')}</span>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

export default CommandPalette;
