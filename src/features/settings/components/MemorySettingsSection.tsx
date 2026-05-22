/**
 * 记忆设置区块
 * Notion 风格：简洁、无边框、hover 效果
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Check, CircleNotch } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { AppSelect } from '@/components/ui/app-menu';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import { SettingRow as SRow, SwitchRow } from './settingsTabPrimitives';
import {
  getMemoryConfig,
  setMemoryRootFolder,
  setMemoryPrivacyMode,
  setMemoryAutoCreateSubfolders,
  setMemoryDefaultCategory,
  createMemoryRootFolder,
  type MemoryConfig,
} from '@/api/memoryApi';
import { getFolderTree } from '@/dstu/api/folderApi';
import type { FolderTreeNode } from '@/dstu/types/folder';

// 分组标题
const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

// 设置行（使用共享 primitives）
const SettingRow = SRow;

interface MemorySettingsSectionProps {
  embedded?: boolean;
}

export const MemorySettingsSection: React.FC<MemorySettingsSectionProps> = ({
  embedded = false,
}) => {
  const { t } = useTranslation(['settings', 'common']);

  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [folders, setFolders] = useState<Array<{ id: string; title: string; path: string }>>([]);
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const flattenFolders = useCallback(
    (nodes: FolderTreeNode[], parentPath = ''): Array<{ id: string; title: string; path: string }> => {
      const result: Array<{ id: string; title: string; path: string }> = [];
      for (const node of nodes) {
        const path = parentPath ? `${parentPath}/${node.folder.title}` : node.folder.title;
        result.push({ id: node.folder.id, title: node.folder.title, path });
        if (node.children.length > 0) {
          result.push(...flattenFolders(node.children, path));
        }
      }
      return result;
    },
    []
  );

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [configResult, treeResult] = await Promise.all([
        getMemoryConfig(),
        getFolderTree(),
      ]);
      setConfig(configResult);
      if (treeResult.ok) {
        setFolders(flattenFolders(treeResult.value));
      }
    } catch (error: unknown) {
      console.error('加载记忆配置失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [flattenFolders]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSelectFolder = useCallback(
    async (folderId: string) => {
      try {
        setSaving(true);
        await setMemoryRootFolder(folderId);
        const newConfig = await getMemoryConfig();
        setConfig(newConfig);
        showGlobalNotification('success', t('settings:memory.setSuccess'));
      } catch (error: unknown) {
        console.error('设置记忆文件夹失败:', error);
        showGlobalNotification('error', getErrorMessage(error));
      } finally {
        setSaving(false);
      }
    },
    [t]
  );

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;

    try {
      setSaving(true);
      await createMemoryRootFolder(newFolderName.trim());
      const newConfig = await getMemoryConfig();
      setConfig(newConfig);
      setShowCreateInput(false);
      setNewFolderName('');
      showGlobalNotification('success', t('settings:memory.createSuccess'));
      await loadData();
    } catch (error: unknown) {
      console.error('创建记忆文件夹失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [newFolderName, t, loadData]);

  const handleToggleAutoSubfolders = useCallback(async (enabled: boolean) => {
    try {
      setSaving(true);
      await setMemoryAutoCreateSubfolders(enabled);
      setConfig((prev) => (prev ? { ...prev, autoCreateSubfolders: enabled } : prev));
      showGlobalNotification('success', t('settings:memory.autoSubfoldersUpdated', '已更新'));
    } catch (error: unknown) {
      console.error('更新自动子文件夹失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [t]);

  const handleSetDefaultCategory = useCallback(async (category: string) => {
    try {
      setSaving(true);
      await setMemoryDefaultCategory(category);
      setConfig((prev) => (prev ? { ...prev, defaultCategory: category } : prev));
      showGlobalNotification('success', t('settings:memory.defaultCategoryUpdated', '已更新'));
    } catch (error: unknown) {
      console.error('更新默认分类失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [t]);

  const handleToggleMemory = useCallback(async (enabled: boolean) => {
    try {
      setSaving(true);
      await setMemoryPrivacyMode(!enabled);
      setConfig((prev) => (prev ? { ...prev, privacyMode: !enabled } : prev));
      showGlobalNotification(
        'success',
        enabled
          ? t('settings:memory.memoryEnabledToast')
          : t('settings:memory.memoryDisabledToast')
      );
    } catch (error: unknown) {
      console.error('切换记忆功能失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [t]);

  if (loading) {
    return (
      <div>
      {!embedded && <GroupTitle title={t('settings:memory.title')} />}
        <div className="flex items-center justify-center py-6">
          <CircleNotch size={20} className="animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const isConfigured = !!config?.memoryRootFolderId;
  const isMemoryOn = !config?.privacyMode;

  return (
    <div>
      {!embedded && <GroupTitle title={t('settings:memory.title')} />}
      <div className="space-y-px">
        {/* 配置状态 */}
        <div className="group py-2.5 px-1 rounded">
          <div className="flex items-center gap-2">
            <span className={cn(
              "w-1.5 h-1.5 rounded-full flex-shrink-0",
              !isMemoryOn ? "bg-muted-foreground/40" : isConfigured ? "bg-emerald-500" : "bg-amber-500/70"
            )} />
            <span className={cn(
              "text-sm",
              !isMemoryOn ? "text-muted-foreground/50" : isConfigured ? "text-foreground/80" : "text-muted-foreground/60"
            )}>
              {!isMemoryOn ? t('settings:memory.disabled') : isConfigured ? t('settings:memory.configured') : t('settings:memory.notConfigured')}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-1 ml-3.5">
            {t('settings:memory.description')}
          </p>
        </div>

        {/* 记忆功能开关 */}
        <SwitchRow
          title={t('settings:memory.memoryEnabled')}
          description={t('settings:memory.memoryEnabledDesc')}
          checked={!config?.privacyMode}
          onCheckedChange={(enabled) => handleToggleMemory(enabled)}
          disabled={saving}
        />

        {/* 根文件夹选择 */}
        <SettingRow
          title={t('settings:memory.rootFolder')}
          description={config?.memoryRootFolderTitle || undefined}
        >
          <div className="flex items-center gap-2">
            <AppSelect
              value={config?.memoryRootFolderId || ''}
              onValueChange={handleSelectFolder}
              disabled={saving}
              placeholder={t('settings:memory.selectFolder')}
              options={folders.length === 0
                ? [{ value: '_empty', label: t('settings:memory.noFolders'), disabled: true }]
                : folders.map((folder) => ({ value: folder.id, label: folder.path }))
              }
              size="sm"
              variant="ghost"
              className="h-8 text-xs bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
              width={160}
            />

            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setShowCreateInput(!showCreateInput)}
              disabled={saving}
            >
              <Plus size={14} className="mr-1" />
              {t('settings:memory.createFolder')}
            </NotionButton>
          </div>
        </SettingRow>

        {/* 创建新文件夹输入 */}
        {showCreateInput && (
          <div className="group py-2.5 px-1 rounded">
            <div className="flex items-center gap-2 ml-0 sm:ml-auto sm:max-w-[280px]">
              <Input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={t('settings:memory.defaultFolderName')}
                className="h-8 text-xs bg-transparent flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleCreateFolder();
                  }
                }}
              />
              <NotionButton
                size="sm"
                variant="primary"
                onClick={handleCreateFolder}
                disabled={saving || !newFolderName.trim()}
              >
                {saving ? (
                  <CircleNotch size={14} className="animate-spin" />
                ) : (
                  <Check size={14} />
                )}
              </NotionButton>
      </div>
          </div>
        )}

        <SwitchRow
          title={t('settings:memory.autoSubfolders', '自动创建子文件夹')}
          description={t('settings:memory.autoSubfoldersDesc', '写入记忆时，自动按分类路径创建子文件夹')}
          checked={!!config?.autoCreateSubfolders}
          onCheckedChange={handleToggleAutoSubfolders}
          disabled={saving}
        />

        <SettingRow
          title={t('settings:memory.defaultCategory', '默认分类')}
          description={t('settings:memory.defaultCategoryDesc', '未指定分类时记忆存入的默认子文件夹')}
        >
          <AppSelect
            value={config?.defaultCategory || '通用'}
            onValueChange={handleSetDefaultCategory}
            disabled={saving}
            options={[
              { value: '通用', label: '通用' },
              { value: '偏好', label: '偏好' },
              { value: '经历', label: '经历' },
            ]}
            size="sm"
            variant="ghost"
            className="h-8 text-xs bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
            width={120}
          />
        </SettingRow>

       </div>
    </div>
  );
};

export default MemorySettingsSection;
