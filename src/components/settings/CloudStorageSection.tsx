/**
 * 云存储配置面板
 * 
 * 支持 WebDAV 和 S3 兼容存储配置
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Cloud, CheckCircle2, XCircle, Loader2, Eye, EyeOff, History, Upload, Download, Trash2, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/shad/Card';
import { NotionButton } from '../ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { Label } from '../ui/shad/Label';
import { Switch } from '../ui/shad/Switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/shad/Tabs';
import { NotionAlertDialog } from '../ui/NotionDialog';
import { showGlobalNotification } from '../UnifiedNotification';
import { getErrorMessage } from '../../utils/errorUtils';
import { debugLog } from '../../debug-panel/debugMasterSwitch';
import * as cloudApi from '../../utils/cloudStorageApi';
import { TauriAPI } from '../../utils/tauriApi';
import { DataGovernanceApi, type BackupJobSummary } from '../../api/dataGovernance';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/** 云端同步操作的细粒度进度状态 */
interface SyncOpProgress {
  operation: 'upload' | 'download';
  stageIndex: number;    // 1-based
  stageTotal: number;
  stageLabel: string;    // 当前阶段描述
  bytesDone: number;
  bytesTotal: number;
  isTransferring: boolean; // 是否处于文件传输阶段（有字节进度）
  error: string | null;  // 阶段失败时的错误文本
}

// 本地存储配置的 key（仅存储非敏感信息，密码存储在系统安全存储中）
const CONFIG_STORAGE_KEY = 'cloud_storage_config_v2';
// 旧版 key（用于迁移）
const LEGACY_CONFIG_KEY = 'cloud_storage_config';

interface CloudStorageSectionProps {
  /** 在 Dialog 中显示时优化布局 */
  isDialog?: boolean;
  /** 配置保存/清除后的回调（用于外层刷新摘要状态） */
  onConfigChanged?: () => void;
}

export const CloudStorageSection: React.FC<CloudStorageSectionProps> = ({
  isDialog = false,
  onConfigChanged,
}) => {
  const { t } = useTranslation(['cloudStorage', 'common']);
  
  // 配置状态
  const [provider, setProvider] = useState<cloudApi.StorageProvider>('webdav');
  const [webdavConfig, setWebdavConfig] = useState<cloudApi.WebDavConfig>({
    endpoint: '',
    username: '',
    password: '',
  });
  const [s3Config, setS3Config] = useState<cloudApi.S3Config>({
    endpoint: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    region: '',
    pathStyle: false,
  });
  const [root, setRoot] = useState('deep-student-sync');
  
  // UI 状态
  const [showPassword, setShowPassword] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'connected' | 'failed'>('unknown');
  
  // 同步状态
  const [syncStatus, setSyncStatus] = useState<cloudApi.SyncStatus | null>(null);
  const [versions, setVersions] = useState<cloudApi.BackupVersion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [restoreVersionId, setRestoreVersionId] = useState<string | null>(null);

  // 细粒度进度状态
  const [opProgress, setOpProgress] = useState<SyncOpProgress | null>(null);

  // S3 feature 状态
  const [s3Enabled, setS3Enabled] = useState<boolean | null>(null);

  // 恢复确认对话框状态
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [pendingRestoreVersionId, setPendingRestoreVersionId] = useState<string | null>(null);

  // 删除确认对话框状态
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDeleteVersionId, setPendingDeleteVersionId] = useState<string | null>(null);

  // 监听后端 cloud-sync-progress 事件（字节级传输进度）
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<{
      operation: 'upload' | 'download';
      stage: 'transferring' | 'done';
      stageLabel: string;
      bytesDone: number;
      bytesTotal: number;
      percent: number;
    }>('cloud-sync-progress', (event) => {
      const { operation, stage, bytesDone, bytesTotal } = event.payload;
      setOpProgress(prev => {
        if (!prev || prev.operation !== operation) return prev;
        if (stage === 'done') {
          return { ...prev, bytesDone: bytesTotal, bytesTotal, isTransferring: false };
        }
        return { ...prev, bytesDone, bytesTotal, isTransferring: true };
      });
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // 加载保存的配置 & 检测 S3 是否启用
  useEffect(() => {
    const loadConfig = async () => {
      // 检测 S3 feature 是否启用
      const s3Available = await cloudApi.isS3Enabled();
      setS3Enabled(s3Available);
      
      // 检查是否需要从旧配置迁移
      let configLoaded = false;
      const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
      const legacy = localStorage.getItem(LEGACY_CONFIG_KEY);
      
      if (saved) {
        // 加载新格式配置
        try {
          const config: cloudApi.CloudStorageConfig = JSON.parse(saved);
          setProvider(config.provider);
          if (config.webdav) {
            setWebdavConfig(prev => ({ ...prev, ...config.webdav, password: '' }));
          }
          if (config.s3) {
            setS3Config(prev => ({ ...prev, ...config.s3, secretAccessKey: '' }));
          }
          if (config.root) setRoot(config.root);
          configLoaded = true;
        } catch (e: unknown) {
          console.error('Failed to load cloud storage config:', e);
        }
      } else if (legacy) {
        // 从旧配置迁移
        console.log('Migrating from legacy cloud storage config...');
        try {
          const oldConfig: cloudApi.CloudStorageConfig = JSON.parse(legacy);
          setProvider(oldConfig.provider);
          
          // 迁移凭据到安全存储
          const credentials: cloudApi.CloudStorageCredentials = {};
          if (oldConfig.webdav) {
            setWebdavConfig(prev => ({ ...prev, ...oldConfig.webdav, password: '' }));
            if (oldConfig.webdav.password) {
              credentials.webdavPassword = oldConfig.webdav.password;
            }
          }
          if (oldConfig.s3) {
            setS3Config(prev => ({ ...prev, ...oldConfig.s3, secretAccessKey: '' }));
            if (oldConfig.s3.secretAccessKey) {
              credentials.s3SecretAccessKey = oldConfig.s3.secretAccessKey;
            }
          }
          if (oldConfig.root) setRoot(oldConfig.root);
          
          // 保存到安全存储
          if (credentials.webdavPassword || credentials.s3SecretAccessKey) {
            await cloudApi.saveCredentials(credentials);
          }
          
          // 保存新格式配置（不含密码）
          const safeConfig = {
            ...oldConfig,
            webdav: oldConfig.webdav ? { ...oldConfig.webdav, password: '' } : undefined,
            s3: oldConfig.s3 ? { ...oldConfig.s3, secretAccessKey: '' } : undefined,
          };
          localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(safeConfig));
          
          // 删除旧配置
          localStorage.removeItem(LEGACY_CONFIG_KEY);
          console.log('Cloud storage config migration completed');
          configLoaded = true;
        } catch (e: unknown) {
          console.error('Failed to migrate legacy config:', e);
        }
      }
      
      // 从安全存储加载敏感凭据
      try {
        const credentials = await cloudApi.getCredentials();
        if (credentials) {
          if (credentials.webdavPassword) {
            setWebdavConfig(prev => ({ ...prev, password: credentials.webdavPassword! }));
          }
          if (credentials.s3SecretAccessKey) {
            setS3Config(prev => ({ ...prev, secretAccessKey: credentials.s3SecretAccessKey! }));
          }
        }
      } catch (e: unknown) {
        console.warn('Failed to load credentials from secure storage:', e);
      }
    };
    
    loadConfig();
  }, []);

  // 构建配置对象
  const buildConfig = useCallback((): cloudApi.CloudStorageConfig => {
    return {
      provider,
      webdav: provider === 'webdav' ? webdavConfig : undefined,
      s3: provider === 's3' ? s3Config : undefined,
      root,
    };
  }, [provider, webdavConfig, s3Config, root]);

  // 保存配置
  const saveConfig = useCallback(async () => {
    // 保存非敏感配置到 localStorage
    const config = buildConfig();
    const safeConfig = {
      ...config,
      webdav: config.webdav ? { ...config.webdav, password: '' } : undefined,
      s3: config.s3 ? { ...config.s3, secretAccessKey: '' } : undefined,
    };
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(safeConfig));
    
    // 保存敏感凭据到安全存储
    try {
      await cloudApi.saveCredentials({
        webdavPassword: webdavConfig.password || undefined,
        s3SecretAccessKey: s3Config.secretAccessKey || undefined,
      });
      showGlobalNotification('success', t('cloudStorage:messages.configSaved'));
    } catch (e: unknown) {
      console.error('Failed to save credentials to secure storage:', e);
      showGlobalNotification('warning', t('cloudStorage:messages.configSavedButCredentialsFailed'));
    }
    onConfigChanged?.();
  }, [buildConfig, webdavConfig.password, s3Config.secretAccessKey, t, onConfigChanged]);

  // 清除配置
  const clearConfig = useCallback(async () => {
    // 清除 localStorage
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    // 清除安全存储中的凭据
    try {
      await cloudApi.deleteCredentials();
    } catch (e: unknown) {
      console.warn('Failed to delete credentials from secure storage:', e);
    }
    // 重置状态
    setOpProgress(null);
    setWebdavConfig({ endpoint: '', username: '', password: '' });
    setS3Config({ endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', region: '', pathStyle: false });
    setRoot('deep-student-sync');
    setConnectionStatus('unknown');
    setSyncStatus(null);
    setVersions([]);
    showGlobalNotification('info', t('cloudStorage:messages.configCleared'));
    onConfigChanged?.();
  }, [t, onConfigChanged]);

  // 测试连接
  const testConnection = useCallback(async () => {
    setTesting(true);
    setConnectionStatus('unknown');
    try {
      const config = buildConfig();
      await cloudApi.checkConnection(config);
      setConnectionStatus('connected');
      showGlobalNotification('success', t('cloudStorage:messages.connectionSuccess'));
      
      // 获取同步状态
      const status = await cloudApi.getSyncStatus(config);
      setSyncStatus(status);
      
      // 获取版本列表
      const versionList = await cloudApi.listVersions(config);
      setVersions(versionList);
    } catch (e: unknown) {
      setConnectionStatus('failed');
      showGlobalNotification('error', `${t('cloudStorage:errors.connectionFailed')}: ${getErrorMessage(e)}`);
    } finally {
      setTesting(false);
    }
  }, [buildConfig, t]);

  // 刷新状态
  const refreshStatus = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    try {
      const config = buildConfig();
      const status = await cloudApi.getSyncStatus(config);
      setSyncStatus(status);
      const versionList = await cloudApi.listVersions(config);
      setVersions(versionList);
    } catch (e: unknown) {
      console.error('Failed to refresh status:', e);
    }
  }, [buildConfig, connectionStatus]);

  // 检查配置是否有效
  const isConfigValid = useCallback(() => {
    if (provider === 'webdav') {
      const endpoint = webdavConfig.endpoint.trim();
      if (!endpoint || !webdavConfig.username.trim()) return false;
      // Validate URL format and protocol
      try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
      } catch { return false; }
      return true;
    } else {
      const endpoint = s3Config.endpoint.trim();
      if (!endpoint || !s3Config.bucket.trim() || !s3Config.accessKeyId.trim() || !s3Config.secretAccessKey.trim()) return false;
      try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
      } catch { return false; }
      return true;
    }
  }, [provider, webdavConfig, s3Config]);

  const resolveBackupId = useCallback((job: BackupJobSummary | null): string | null => {
    const stats = job?.result?.stats as Record<string, unknown> | undefined;
    if (stats && typeof stats.backup_id === 'string' && stats.backup_id.trim().length > 0) {
      return stats.backup_id;
    }

    const outputPath = job?.result?.resolved_path || job?.result?.output_path;
    if (!outputPath) return null;
    const segments = outputPath.split(/[\\/]/).filter(Boolean);
    if (segments.length === 0) return null;
    const last = segments[segments.length - 1];
    return last.replace(/\.zip$/i, '') || null;
  }, []);

  const resolveExportZipPath = useCallback((job: BackupJobSummary | null): string | null => {
    const resolvedPath = job?.result?.resolved_path || job?.result?.output_path;
    return resolvedPath && resolvedPath.trim().length > 0 ? resolvedPath : null;
  }, []);

  const waitForGovernanceJob = useCallback(async (
    jobId: string,
    kind: 'export' | 'import',
    timeoutMs = 180000
  ): Promise<BackupJobSummary> => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const job = await DataGovernanceApi.getBackupJob(jobId);
      if (job) {
        if (job.status === 'completed') {
          return job;
        }

        if (job.status === 'failed' || job.status === 'cancelled') {
          throw new Error(job.result?.error || job.message || `${kind} task failed`);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`backup job timeout: ${kind} (${Math.floor(timeoutMs / 1000)}s)`);
  }, []);

  // 进度辅助：设置当前阶段
  const setStage = useCallback((
    operation: 'upload' | 'download',
    stageIndex: number,
    stageTotal: number,
    stageLabel: string,
  ) => {
    setOpProgress(prev => ({
      operation,
      stageIndex,
      stageTotal,
      stageLabel,
      bytesDone: 0,
      bytesTotal: 0,
      isTransferring: false,
      error: null,
    }));
  }, []);

  // 备份并上传到云端
  const handleBackupAndUpload = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      showGlobalNotification('warning', t('cloudStorage:errors.connectionFailed'));
      return;
    }
    setUploading(true);
    setOpProgress({ operation: 'upload', stageIndex: 1, stageTotal: 4, stageLabel: '正在备份数据库...', bytesDone: 0, bytesTotal: 0, isTransferring: false, error: null });
    try {
      // 阶段 1/4：创建备份
      let backupId: string;
      try {
        const backupJob = await DataGovernanceApi.backupTiered(['core']);
        const backupSummary = await waitForGovernanceJob(backupJob.job_id, 'export');
        backupId = resolveBackupId(backupSummary) ?? '';
        if (!backupId) throw new Error('backup_id missing from backup result');
      } catch (e: unknown) {
        throw new Error(`备份数据库失败: ${getErrorMessage(e)}`);
      }

      // 阶段 2/4：导出 ZIP
      setStage('upload', 2, 4, '正在打包 ZIP...');
      let zipPath: string;
      try {
        const zipExportJob = await DataGovernanceApi.exportZip(backupId);
        const zipExportSummary = await waitForGovernanceJob(zipExportJob.job_id, 'export');
        zipPath = resolveExportZipPath(zipExportSummary) ?? '';
        if (!zipPath) throw new Error('zip export path missing from export result');
      } catch (e: unknown) {
        throw new Error(`打包 ZIP 失败: ${getErrorMessage(e)}`);
      }

      // 阶段 3/4：上传至云端（字节进度由 Tauri 事件驱动）
      setStage('upload', 3, 4, '正在上传至云端...');
      let result: cloudApi.UploadResult;
      try {
        const appVersion = await TauriAPI.getAppVersion();
        result = await cloudApi.uploadBackup(buildConfig(), zipPath, appVersion);
      } catch (e: unknown) {
        throw new Error(`上传文件失败: ${getErrorMessage(e)}`);
      }

      // 阶段 4/4：刷新状态
      setStage('upload', 4, 4, '正在刷新状态...');
      await refreshStatus();

      setOpProgress(null);
      showGlobalNotification('success', t('cloudStorage:upload.successDetail', { version: result.version.id }));
      if (result.prunedVersions.length > 0) {
        showGlobalNotification('info', t('cloudStorage:upload.pruned', { count: result.prunedVersions.length }));
      }
    } catch (e: unknown) {
      const msg = getErrorMessage(e);
      setOpProgress(prev => prev ? { ...prev, error: msg } : null);
      showGlobalNotification('error', msg);
    } finally {
      setUploading(false);
    }
  }, [
    buildConfig,
    connectionStatus,
    refreshStatus,
    resolveBackupId,
    resolveExportZipPath,
    setStage,
    t,
    waitForGovernanceJob,
  ]);

  // 打开恢复确认对话框
  const openRestoreConfirm = useCallback((versionId: string) => {
    if (connectionStatus !== 'connected') {
      showGlobalNotification('warning', t('cloudStorage:errors.connectionFailed'));
      return;
    }
    setPendingRestoreVersionId(versionId);
    setRestoreConfirmOpen(true);
  }, [connectionStatus, t]);

  // 从云端恢复
  const handleRestore = useCallback(async () => {
    const versionId = pendingRestoreVersionId;
    if (!versionId) return;
    
    setRestoreConfirmOpen(false);
    setDownloading(true);
    setRestoreVersionId(versionId);
    setOpProgress({ operation: 'download', stageIndex: 1, stageTotal: 3, stageLabel: '正在从云端下载...', bytesDone: 0, bytesTotal: 0, isTransferring: false, error: null });

    try {
      // 阶段 1/3：下载云端备份（字节进度由 Tauri 事件驱动）
      const appDataDir = await TauriAPI.getAppDataDir();
      const downloadDir = `${appDataDir}/backups/cloud-downloads`;
      let downloadResult: cloudApi.DownloadResult;
      try {
        downloadResult = await cloudApi.downloadBackup(buildConfig(), versionId, downloadDir);
      } catch (e: unknown) {
        throw new Error(`下载备份失败: ${getErrorMessage(e)}`);
      }

      // 阶段 2/3：导入 ZIP
      setStage('download', 2, 3, '正在导入 ZIP...');
      let importedBackupId: string;
      try {
        const importJob = await DataGovernanceApi.importZip(downloadResult.localPath);
        const importSummary = await waitForGovernanceJob(importJob.job_id, 'import');
        importedBackupId = resolveBackupId(importSummary) ?? '';
        if (!importedBackupId) throw new Error('backup_id missing from import result');
      } catch (e: unknown) {
        throw new Error(`导入 ZIP 失败: ${getErrorMessage(e)}`);
      }

      // 阶段 3/3：恢复数据库
      setStage('download', 3, 3, '正在恢复数据库...');
      try {
        const restoreJob = await DataGovernanceApi.restoreBackup(importedBackupId);
        await waitForGovernanceJob(restoreJob.job_id, 'import');
      } catch (e: unknown) {
        throw new Error(`恢复数据库失败: ${getErrorMessage(e)}`);
      }

      setOpProgress(null);
      showGlobalNotification('success', t('cloudStorage:download.successRestart'));
      showGlobalNotification('info', t('cloudStorage:download.restartWhenReady'));
    } catch (e: unknown) {
      const msg = getErrorMessage(e);
      setOpProgress(prev => prev ? { ...prev, error: msg } : null);
      showGlobalNotification('error', msg);
    } finally {
      setDownloading(false);
      setRestoreVersionId(null);
      setPendingRestoreVersionId(null);
    }
  }, [
    buildConfig,
    pendingRestoreVersionId,
    resolveBackupId,
    setStage,
    t,
    waitForGovernanceJob,
  ]);

  // 打开删除确认对话框
  const openDeleteConfirm = useCallback((versionId: string) => {
    setPendingDeleteVersionId(versionId);
    setDeleteConfirmOpen(true);
  }, []);

  // 删除版本
  const handleDeleteVersion = useCallback(async () => {
    const versionId = pendingDeleteVersionId;
    if (!versionId) return;
    
    setDeleteConfirmOpen(false);
    try {
      await cloudApi.deleteVersion(buildConfig(), versionId);
      showGlobalNotification('success', t('cloudStorage:messages.versionDeleted'));
      refreshStatus();
    } catch (e: unknown) {
      showGlobalNotification('error', `${t('cloudStorage:errors.deleteFailed')}: ${getErrorMessage(e)}`);
    } finally {
      setPendingDeleteVersionId(null);
    }
  }, [buildConfig, pendingDeleteVersionId, refreshStatus, t]);

  // 主要内容
  const content = (
    <div className={isDialog ? 'space-y-4' : 'space-y-6'}>
      {/* 存储类型选择 - 卡片式单选 */}
      <div className="grid grid-cols-2 gap-3">
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => setProvider('webdav')}
          className={`relative !h-auto !justify-start flex-col items-start gap-1 !rounded-lg border-2 !p-3 text-left ${
            provider === 'webdav'
              ? 'border-primary bg-primary/5'
              : 'border-border bg-transparent'
          }`}
        >
          {provider === 'webdav' && (
            <div className="absolute right-2 top-2">
              <CheckCircle2 className="h-4 w-4 text-primary" />
            </div>
          )}
          <span className="font-medium">{t('cloudStorage:provider.webdav')}</span>
          <span className="text-xs text-muted-foreground line-clamp-2">
            {t('cloudStorage:provider.webdavDesc')}
          </span>
        </NotionButton>
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => s3Enabled !== false && setProvider('s3')}
          disabled={s3Enabled === false}
          className={`relative !h-auto !justify-start flex-col items-start gap-1 !rounded-lg border-2 !p-3 text-left ${
            s3Enabled === false
              ? 'opacity-50 border-border'
              : provider === 's3'
                ? 'border-primary bg-primary/5 hover:bg-primary/10'
                : 'border-border bg-transparent hover:bg-accent/50'
          }`}
        >
          {provider === 's3' && s3Enabled !== false && (
            <div className="absolute right-2 top-2">
              <CheckCircle2 className="h-4 w-4 text-primary" />
            </div>
          )}
          <span className={`font-medium ${s3Enabled === false ? 'line-through' : ''}`}>
            {t('cloudStorage:provider.s3')}
          </span>
          <span className={`text-xs line-clamp-2 ${s3Enabled === false ? 'text-destructive/70' : 'text-muted-foreground'}`}>
            {s3Enabled === false 
              ? t('cloudStorage:provider.s3Disabled')
              : t('cloudStorage:provider.s3Desc')}
          </span>
        </NotionButton>
      </div>

      <Tabs value={provider} onValueChange={(v) => setProvider(v as cloudApi.StorageProvider)}>
          {/* WebDAV 配置 */}
          <TabsContent value="webdav" className="space-y-4 mt-0">
            <div className="space-y-2">
              <Label htmlFor="webdav-endpoint">{t('cloudStorage:webdav.endpoint')}</Label>
              <Input
                id="webdav-endpoint"
                placeholder={t('cloudStorage:webdav.endpointPlaceholder')}
                value={webdavConfig.endpoint}
                onChange={(e) => setWebdavConfig({ ...webdavConfig, endpoint: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('cloudStorage:webdav.endpointHint')}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="webdav-username">{t('cloudStorage:webdav.username')}</Label>
                <Input
                  id="webdav-username"
                  placeholder={t('cloudStorage:webdav.usernamePlaceholder')}
                  value={webdavConfig.username}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, username: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="webdav-password">{t('cloudStorage:webdav.password')}</Label>
                <div className="relative">
                  <Input
                    id="webdav-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder={t('cloudStorage:webdav.passwordPlaceholder')}
                    value={webdavConfig.password}
                    onChange={(e) => setWebdavConfig({ ...webdavConfig, password: e.target.value })}
                  />
                  <NotionButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-0 top-0 h-full px-3"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </NotionButton>
                </div>
                <p className="text-xs text-muted-foreground">{t('cloudStorage:webdav.passwordHint')}</p>
              </div>
            </div>
          </TabsContent>

          {/* S3 配置 */}
          <TabsContent value="s3" className="space-y-4 mt-0">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="s3-endpoint">{t('cloudStorage:s3.endpoint')}</Label>
                <Input
                  id="s3-endpoint"
                  placeholder={t('cloudStorage:s3.endpointPlaceholder')}
                  value={s3Config.endpoint}
                  onChange={(e) => setS3Config({ ...s3Config, endpoint: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t('cloudStorage:s3.endpointHint')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="s3-bucket">{t('cloudStorage:s3.bucket')}</Label>
                <Input
                  id="s3-bucket"
                  placeholder={t('cloudStorage:s3.bucketPlaceholder')}
                  value={s3Config.bucket}
                  onChange={(e) => setS3Config({ ...s3Config, bucket: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="s3-access-key">{t('cloudStorage:s3.accessKeyId')}</Label>
                <Input
                  id="s3-access-key"
                  placeholder={t('cloudStorage:s3.accessKeyIdPlaceholder')}
                  value={s3Config.accessKeyId}
                  onChange={(e) => setS3Config({ ...s3Config, accessKeyId: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="s3-secret-key">{t('cloudStorage:s3.secretAccessKey')}</Label>
                <div className="relative">
                  <Input
                    id="s3-secret-key"
                    type={showSecretKey ? 'text' : 'password'}
                    placeholder={t('cloudStorage:s3.secretAccessKeyPlaceholder')}
                    value={s3Config.secretAccessKey}
                    onChange={(e) => setS3Config({ ...s3Config, secretAccessKey: e.target.value })}
                  />
                  <NotionButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-0 top-0 h-full px-3"
                    onClick={() => setShowSecretKey(!showSecretKey)}
                  >
                    {showSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </NotionButton>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="s3-region">{t('cloudStorage:s3.region')}</Label>
                <Input
                  id="s3-region"
                  placeholder={t('cloudStorage:s3.regionPlaceholder')}
                  value={s3Config.region || ''}
                  onChange={(e) => setS3Config({ ...s3Config, region: e.target.value || undefined })}
                />
                <p className="text-xs text-muted-foreground">{t('cloudStorage:s3.regionHint')}</p>
              </div>
              <div className="space-y-2 flex items-center pt-6">
                <Switch
                  id="s3-path-style"
                  checked={s3Config.pathStyle}
                  onCheckedChange={(checked) => setS3Config({ ...s3Config, pathStyle: checked })}
                />
                <Label htmlFor="s3-path-style" className="ml-2">
                  {t('cloudStorage:s3.pathStyle')}
                  <span className="block text-xs text-muted-foreground font-normal">
                    {t('cloudStorage:s3.pathStyleHint')}
                  </span>
                </Label>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* 根目录配置 */}
        <div className="space-y-2">
          <Label htmlFor="cloud-storage-root">{t('cloudStorage:root.label')}</Label>
          <Input
            id="cloud-storage-root"
            placeholder={t('cloudStorage:root.placeholder')}
            value={root}
            onChange={(e) => setRoot(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('cloudStorage:root.hint')}</p>
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-wrap gap-2">
          <NotionButton
            variant="outline"
            onClick={testConnection}
            disabled={testing || !isConfigValid()}
          >
            {testing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('cloudStorage:actions.testing')}
              </>
            ) : (
              <>
                {connectionStatus === 'connected' && <CheckCircle2 className="mr-2 h-4 w-4 text-green-500" />}
                {connectionStatus === 'failed' && <XCircle className="mr-2 h-4 w-4 text-red-500" />}
                {t('cloudStorage:actions.testConnection')}
              </>
            )}
          </NotionButton>
          <NotionButton onClick={saveConfig} disabled={!isConfigValid()}>
            {t('cloudStorage:actions.save')}
          </NotionButton>
          <NotionButton variant="ghost" onClick={clearConfig}>
            {t('cloudStorage:actions.clearConfig')}
          </NotionButton>
        </div>

        {/* 同步状态 */}
        {syncStatus && (
          <div className="border rounded-lg p-4 space-y-3">
            <h4 className="font-medium flex items-center gap-2">
              {syncStatus.connected ? (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              ) : (
                <XCircle className="h-4 w-4 text-red-500" />
              )}
              {t('cloudStorage:status.title')}
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">{t('cloudStorage:status.cloudVersions')}:</span>
                <span className="ml-2 font-medium">{syncStatus.cloudVersionCount}</span>
              </div>
              <div>
                <span className="text-muted-foreground">{t('cloudStorage:status.lastSync')}:</span>
                <span className="ml-2 font-medium">
                  {syncStatus.lastSyncTime 
                    ? cloudApi.formatTimestamp(syncStatus.lastSyncTime)
                    : t('cloudStorage:status.never')}
                </span>
              </div>
              {syncStatus.latestVersion && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">{t('cloudStorage:status.latestVersion')}:</span>
                  <span className="ml-2 font-medium">
                    {syncStatus.latestVersion.id} ({cloudApi.formatFileSize(syncStatus.latestVersion.size)})
                  </span>
                </div>
              )}
            </div>

            {/* 进度面板：上传/下载时显示 */}
            {opProgress && (
              <div className={`rounded-lg border p-3 space-y-2 text-sm ${
                opProgress.error
                  ? 'border-destructive/50 bg-destructive/5'
                  : 'border-border bg-muted/30'
              }`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {opProgress.error ? (
                      <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
                    ) : (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    )}
                    <span className={`font-medium truncate ${
                      opProgress.error ? 'text-destructive' : ''
                    }`}>
                      {opProgress.error ?? opProgress.stageLabel}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {opProgress.stageIndex}/{opProgress.stageTotal}
                  </span>
                </div>

                {/* 文件传输进度条 */}
                {!opProgress.error && opProgress.isTransferring && (
                  <>
                    <div className="w-full bg-secondary rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-primary h-1.5 rounded-full transition-all duration-200"
                        style={{
                          width: opProgress.bytesTotal > 0
                            ? `${Math.min(100, opProgress.bytesDone / opProgress.bytesTotal * 100)}%`
                            : '0%',
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{cloudApi.formatFileSize(opProgress.bytesDone)}</span>
                      {opProgress.bytesTotal > 0 && (
                        <span>{cloudApi.formatFileSize(opProgress.bytesTotal)}</span>
                      )}
                    </div>
                  </>
                )}

                {/* 非传输阶段：脉动进度条 */}
                {!opProgress.error && !opProgress.isTransferring && (
                  <div className="w-full bg-secondary rounded-full h-1.5 overflow-hidden">
                    <div className="bg-primary/60 h-1.5 rounded-full animate-pulse w-full" />
                  </div>
                )}

                {opProgress.error && (
                  <NotionButton
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-muted-foreground"
                    onClick={() => setOpProgress(null)}
                  >
                    关闭
                  </NotionButton>
                )}
              </div>
            )}

            {/* 快捷操作 */}
            <div className="flex flex-wrap gap-2 pt-2">
              <NotionButton
                size="sm"
                onClick={handleBackupAndUpload}
                disabled={uploading || downloading}
              >
                {uploading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('cloudStorage:actions.uploading')}
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    {t('cloudStorage:actions.uploadNow')}
                  </>
                )}
              </NotionButton>
              <NotionButton
                size="sm"
                variant="outline"
                onClick={() => setShowHistory(!showHistory)}
              >
                <History className="mr-2 h-4 w-4" />
                {t('cloudStorage:actions.viewHistory')}
              </NotionButton>
            </div>
          </div>
        )}

        {/* 版本历史 */}
        {showHistory && (
          <div className="border rounded-lg p-4 space-y-3">
            <h4 className="font-medium">{t('cloudStorage:history.title')}</h4>
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('cloudStorage:history.empty')}</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {versions.map((version) => (
                  <div
                    key={version.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                  >
                    <div className="space-y-1">
                      <div className="font-medium">{version.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {cloudApi.formatFileSize(version.size)} • {cloudApi.formatTimestamp(version.timestamp)}
                        {version.note && ` • ${version.note}`}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <NotionButton
                        size="sm"
                        variant="ghost"
                        title={t('cloudStorage:history.restore')}
                        disabled={downloading}
                        onClick={() => openRestoreConfirm(version.id)}
                      >
                        {downloading && restoreVersionId === version.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4" />
                        )}
                      </NotionButton>
                      <NotionButton
                        size="sm"
                        variant="ghost"
                        title={t('cloudStorage:history.delete')}
                        onClick={() => openDeleteConfirm(version.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </NotionButton>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
    </div>
  );

  // 恢复确认对话框
  const restoreConfirmDialog = (
    <NotionAlertDialog
      open={restoreConfirmOpen}
      onOpenChange={setRestoreConfirmOpen}
      title={t('cloudStorage:download.confirmTitle')}
      description={t('cloudStorage:download.warningDetail')}
      confirmText={t('cloudStorage:download.confirm')}
      cancelText={t('cloudStorage:download.cancel')}
      confirmVariant="warning"
      onConfirm={handleRestore}
    >
      <p className="text-sm font-medium text-destructive">{t('cloudStorage:download.warning')}</p>
    </NotionAlertDialog>
  );

  // 删除确认对话框
  const deleteConfirmDialog = (
    <NotionAlertDialog
      open={deleteConfirmOpen}
      onOpenChange={setDeleteConfirmOpen}
      title={t('cloudStorage:history.delete')}
      description={t('cloudStorage:history.deleteConfirm')}
      confirmText={t('cloudStorage:history.delete')}
      cancelText={t('common:actions.cancel')}
      confirmVariant="danger"
      onConfirm={handleDeleteVersion}
    />
  );

  // Dialog 模式下直接渲染内容
  if (isDialog) {
    return (
      <>
        <div className="space-y-3">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-lg">
              <Cloud className="h-5 w-5" />
              {t('cloudStorage:title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('cloudStorage:description')}</p>
          </div>
          {content}
        </div>
        {restoreConfirmDialog}
        {deleteConfirmDialog}
      </>
    );
  }

  // 普通模式使用 Card 包装
  return (
    <>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" />
            {t('cloudStorage:title')}
          </CardTitle>
          <CardDescription>{t('cloudStorage:description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {content}
        </CardContent>
      </Card>
      {restoreConfirmDialog}
      {deleteConfirmDialog}
    </>
  );
};

export default CloudStorageSection;
