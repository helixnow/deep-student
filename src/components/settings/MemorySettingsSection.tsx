/**
 * 记忆设置区块
 * Notion 风格：简洁、无边框、hover 效果
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Check, Loader2 } from 'lucide-react';
import { NotionButton } from '../ui/NotionButton';
import { AppSelect } from '../ui/app-menu';
import { Input } from '../ui/shad/Input';
import { Switch } from '../ui/shad/Switch';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';
import { cn } from '../../lib/utils';
import {
  getMemoryConfig,
  setMemoryRootFolder,
  setMemoryPrivacyMode,
  createMemoryRootFolder,
  type MemoryConfig,
} from '../../api/memoryApi';
import { getFolderTree } from '../../dstu/api/folderApi';
import type { FolderTreeNode } from '../../dstu/types/folder';

// 分组标题
const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

// 设置行
const SettingRow = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <div className="group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors overflow-hidden">
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="flex-shrink-0">
      {children}
    </div>
  </div>
);

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

  const handleTogglePrivacyMode = useCallback(async (enabled: boolean) => {
    try {
      setSaving(true);
      await setMemoryPrivacyMode(enabled);
      setConfig((prev) => (prev ? { ...prev, privacyMode: enabled } : prev));
      showGlobalNotification(
        'success',
        enabled
          ? t('settings:memory.privacyModeEnabled')
          : t('settings:memory.privacyModeDisabled')
      );
    } catch (error: unknown) {
      console.error('更新记忆隐私模式失败:', error);
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [t]);

  if (loading) {
    return (
      <div>
        <GroupTitle title={t('settings:memory.title')} />
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const isConfigured = !!config?.memoryRootFolderId;

  return (
    <div>
      <GroupTitle title={t('settings:memory.title')} />
      <div className="space-y-px">
        {/* 配置状态 */}
        <div className="group py-2.5 px-1 hover:bg-muted/30 rounded transition-colors">
          <div className="flex items-center gap-2">
            <span className={cn(
              "w-1.5 h-1.5 rounded-full flex-shrink-0",
              isConfigured ? "bg-emerald-500" : "bg-amber-500/70"
            )} />
            <span className={cn(
              "text-sm",
              isConfigured ? "text-foreground/80" : "text-muted-foreground/60"
            )}>
              {isConfigured ? t('settings:memory.configured') : t('settings:memory.notConfigured')}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-1 ml-3.5">
            {t('settings:memory.description')}
          </p>
        </div>

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
              className="h-8 text-xs bg-transparent hover:bg-muted/20 transition-colors"
              width={160}
            />

            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setShowCreateInput(!showCreateInput)}
              disabled={saving}
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              {t('settings:memory.createFolder')}
            </NotionButton>
          </div>
        </SettingRow>

        {/* 创建新文件夹输入 */}
        {showCreateInput && (
          <div className="group py-2.5 px-1 hover:bg-muted/30 rounded transition-colors">
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
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
              </NotionButton>
            </div>
          </div>
        )}

        <SettingRow
          title={t('settings:memory.privacyMode')}
          description={t('settings:memory.privacyModeDesc')}
        >
          <Switch
            checked={!!config?.privacyMode}
            onCheckedChange={handleTogglePrivacyMode}
            disabled={saving}
          />
        </SettingRow>
      </div>
    </div>
  );
};

export default MemorySettingsSection;
