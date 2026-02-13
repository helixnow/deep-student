import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  RotateCcw,
  AlertTriangle,
  Keyboard,
  Download,
  Upload,
  Trash2,
} from 'lucide-react';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { commandRegistry } from '../registry/commandRegistry';
import { shortcutManager, type ShortcutConflict } from '../registry/shortcutManager';
import { formatShortcut, buildShortcutString } from '../registry/shortcutUtils';
import { CATEGORY_CONFIG, type Command, type CommandCategory } from '../registry/types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { SettingSection } from '@/components/settings/SettingsCommon';

interface ShortcutSettingsProps {
  className?: string;
}

interface EditingState {
  commandId: string;
  listening: boolean;
  newShortcut: string | null;
  conflict: ShortcutConflict | null;
}

const GroupTitle = ({ title, rightSlot }: { title: string; rightSlot?: React.ReactNode }) => (
  <div className="px-1 mb-3 mt-0 flex items-center justify-between">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
    {rightSlot}
  </div>
);

export function ShortcutSettings({ className }: ShortcutSettingsProps) {
  const { t } = useTranslation(['command_palette', 'common', 'settings']);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<CommandCategory | 'all'>('all');
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    return shortcutManager.subscribe(() => {
      setVersion((v) => v + 1);
    });
  }, []);

  const allCommands = useMemo(() => {
    return commandRegistry.getAll();
  }, [version]);

  const filteredCommands = useMemo(() => {
    let result = allCommands;

    if (selectedCategory !== 'all') {
      result = result.filter((cmd) => cmd.category === selectedCategory);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((cmd) =>
        cmd.name.toLowerCase().includes(query) ||
        cmd.id.toLowerCase().includes(query) ||
        (cmd.description?.toLowerCase().includes(query))
      );
    }

    return result;
  }, [allCommands, selectedCategory, searchQuery]);

  const groupedCommands = useMemo(() => {
    const groups = new Map<CommandCategory, Command[]>();

    for (const cmd of filteredCommands) {
      if (!groups.has(cmd.category)) {
        groups.set(cmd.category, []);
      }
      groups.get(cmd.category)!.push(cmd);
    }

    const sortedGroups = new Map<CommandCategory, Command[]>();
    const sortedCategories = Array.from(groups.keys()).sort(
      (a, b) => (CATEGORY_CONFIG[a]?.order ?? 99) - (CATEGORY_CONFIG[b]?.order ?? 99)
    );

    for (const category of sortedCategories) {
      sortedGroups.set(category, groups.get(category)!);
    }

    return sortedGroups;
  }, [filteredCommands]);

  const startEditing = useCallback((commandId: string) => {
    setEditing({
      commandId,
      listening: true,
      newShortcut: null,
      conflict: null,
    });
  }, []);

  const cancelEditing = useCallback(() => {
    setEditing(null);
  }, []);

  const saveShortcut = useCallback(() => {
    if (!editing || !editing.newShortcut) return;

    const conflict = shortcutManager.setShortcut(editing.commandId, editing.newShortcut);
    if (conflict) {
      setEditing({
        ...editing,
        conflict,
      });
      return;
    }

    showGlobalNotification('success', t('command_palette:shortcut_saved', '快捷键已保存'));
    setEditing(null);
  }, [editing, t]);

  const resetShortcut = useCallback((commandId: string) => {
    shortcutManager.resetShortcut(commandId);
    showGlobalNotification('info', t('command_palette:shortcut_reset', '快捷键已重置为默认'));
  }, [t]);

  const disableShortcut = useCallback((commandId: string) => {
    shortcutManager.disableShortcut(commandId);
    showGlobalNotification('info', t('command_palette:shortcut_disabled', '快捷键已禁用'));
  }, [t]);

  const resetAllShortcuts = useCallback(() => {
    if (unifiedConfirm(t('command_palette:confirm_reset_all', '确定要重置所有自定义快捷键吗？'))) {
      shortcutManager.resetAll();
      showGlobalNotification('success', t('command_palette:all_shortcuts_reset', '所有快捷键已重置'));
    }
  }, [t]);

  const exportConfig = useCallback(() => {
    const config = shortcutManager.exportConfig();
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dstu-shortcuts.json';
    a.click();
    URL.revokeObjectURL(url);
    showGlobalNotification('success', t('command_palette:config_exported', '配置已导出'));
  }, [t]);

  const importConfig = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const config = JSON.parse(text);
        if (typeof config !== 'object' || config === null || Array.isArray(config)) {
          showGlobalNotification('error', t('command_palette:import_failed', '导入失败：格式无效'));
          return;
        }
        const result = shortcutManager.importConfig(config);
        const msg = result.skipped.length > 0
          ? t('command_palette:config_imported_partial', `已导入 ${result.imported} 项，跳过 ${result.skipped.length} 项无效命令`)
          : t('command_palette:config_imported', '配置已导入');
        showGlobalNotification('success', msg);
      } catch (error: unknown) {
        showGlobalNotification('error', t('command_palette:import_failed', '导入失败'));
      }
    };
    input.click();
  }, [t]);

  useEffect(() => {
    if (!editing?.listening) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape 键取消录入（修复：录入模式可通过键盘退出）
      if (e.key === 'Escape') {
        setEditing(null);
        return;
      }

      const shortcut = buildShortcutString(e);
      if (!shortcut) return;

      const conflict = shortcutManager.checkConflict(shortcut, editing.commandId);

      setEditing({
        ...editing,
        listening: false,
        newShortcut: shortcut,
        conflict,
      });
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [editing]);

  const categories: Array<{ value: CommandCategory | 'all'; label: string }> = [
    { value: 'all', label: t('command_palette:all_categories', '全部') },
    ...Object.entries(CATEGORY_CONFIG).map(([key, config]) => ({
      value: key as CommandCategory,
      label: t(config.labelKey, key),
    })),
  ];

  return (
    <div className={cn('space-y-1 pb-10 text-left animate-in fade-in duration-500', className)}>
      <SettingSection
        title=""
        hideHeader
        className="overflow-visible"
      >
        <div>
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center mb-6">
            <div className="relative flex-1 w-full sm:max-w-xs">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                placeholder={t('command_palette:search_shortcuts', '搜索快捷键...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-xs bg-transparent"
              />
            </div>

            <select
              className="h-8 px-2.5 py-1 bg-transparent border border-border/50 rounded-md text-xs text-foreground/80 focus:outline-none focus:ring-1 focus:ring-primary/30 hover:bg-muted/30 transition-colors"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value as CommandCategory | 'all')}
            >
              {categories.map((cat) => (
                <option key={cat.value} value={cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>

            <div className="flex gap-1 ml-auto">
              <NotionButton variant="ghost" size="sm" onClick={exportConfig} className="gap-1.5">
                <Download size={12} />
                {t('common:actions.export', '导出')}
              </NotionButton>
              <NotionButton variant="ghost" size="sm" onClick={importConfig} className="gap-1.5">
                <Upload size={12} />
                {t('common:actions.import', '导入')}
              </NotionButton>
              <NotionButton variant="ghost" size="sm" onClick={resetAllShortcuts} className="gap-1.5">
                <RotateCcw size={12} />
                {t('command_palette:reset_all', '全部重置')}
              </NotionButton>
            </div>
          </div>

          {Array.from(groupedCommands.entries()).map(([category, commands], groupIdx) => (
            <div key={category} className={groupIdx > 0 ? 'mt-8' : ''}>
              <GroupTitle title={t(CATEGORY_CONFIG[category]?.labelKey ?? category, category)} />
              <div className="space-y-px">
                {commands.map((command) => {
                  const effectiveShortcut = shortcutManager.getShortcut(command.id);
                  const hasCustom = shortcutManager.hasCustomShortcut(command.id);
                  const isEditing = editing?.commandId === command.id;

                  return (
                    <div
                      key={command.id}
                      className={cn(
                        'group flex items-center justify-between py-2.5 px-1 rounded transition-colors',
                        isEditing
                          ? 'bg-primary/5'
                          : 'hover:bg-muted/30'
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="text-sm text-foreground/90 truncate">
                          {t(`command_palette:commands.${command.id}`, command.name)}
                        </span>
                        {hasCustom && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary font-medium flex-shrink-0">
                            {t('command_palette:custom', '自定义')}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 flex-shrink-0">
                        {isEditing ? (
                          <div className="flex items-center gap-2 animate-in fade-in slide-in-from-right-2 duration-200">
                            {editing.listening ? (
                              <div className="flex items-center gap-2 px-2.5 py-1 bg-primary/10 rounded-md text-primary text-xs font-medium">
                                <Keyboard size={13} className="animate-pulse" />
                                {t('command_palette:press_shortcut', '按下快捷键...')}
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                <span className="px-2 py-1 bg-muted rounded text-xs font-mono min-w-[3rem] text-center text-foreground/90">
                                  {editing.newShortcut ? formatShortcut(editing.newShortcut) : '—'}
                                </span>
                                {editing.conflict && (
                                  <div className="flex items-center gap-1 text-[11px] text-amber-500 bg-amber-500/10 px-2 py-1 rounded">
                                    <AlertTriangle size={11} />
                                    <span>{editing.conflict.commands.join(', ')}</span>
                                  </div>
                                )}
                                <NotionButton size="sm" onClick={saveShortcut} disabled={!editing.newShortcut || !!editing.conflict}>
                                  {t('common:save', '保存')}
                                </NotionButton>
                                <NotionButton size="sm" variant="ghost" onClick={() => startEditing(command.id)}>
                                  {t('command_palette:re_record', '重录')}
                                </NotionButton>
                                <NotionButton size="sm" variant="ghost" onClick={cancelEditing}>
                                  {t('common:cancel', '取消')}
                                </NotionButton>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              'px-2 py-1 rounded text-xs font-mono min-w-[3rem] text-center',
                              effectiveShortcut
                                ? 'bg-muted text-foreground/80'
                                : 'text-muted-foreground/40 italic'
                            )}>
                              {effectiveShortcut ? formatShortcut(effectiveShortcut) : t('command_palette:no_shortcut', '无')}
                            </span>

                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <NotionButton
                                size="sm"
                                variant="ghost"
                                onClick={() => startEditing(command.id)}
                              >
                                {t('command_palette:edit_shortcut', '编辑')}
                              </NotionButton>
                              {hasCustom && (
                                <NotionButton
                                  size="sm"
                                  variant="ghost"
                                  iconOnly
                                  onClick={() => resetShortcut(command.id)}
                                  title={t('command_palette:reset_shortcut', '重置')}
                                >
                                  <RotateCcw size={12} />
                                </NotionButton>
                              )}
                              {effectiveShortcut && (
                                <NotionButton
                                  size="sm"
                                  variant="ghost"
                                  iconOnly
                                  onClick={() => disableShortcut(command.id)}
                                  className="hover:text-destructive"
                                  title={t('command_palette:disable_shortcut', '禁用')}
                                >
                                  <Trash2 size={12} />
                                </NotionButton>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {filteredCommands.length === 0 && (
            <div className="py-12 text-center text-muted-foreground/60 text-sm">
              {t('command_palette:no_commands_found', '未找到命令')}
            </div>
          )}
        </div>
      </SettingSection>
    </div>
  );
}

export default ShortcutSettings;
