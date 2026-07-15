/**
 * 云存储配置面板
 * 
 * 支持 WebDAV 和 S3 兼容存储配置
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Cloud, CheckCircle, XCircle, CircleNotch, ClockCounterClockwise, Upload, Download, Trash, WarningCircle } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Switch } from '@/components/ui/shad/Switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { ApiKeyField } from './ApiKeyField';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import * as cloudApi from '@/utils/cloudStorageApi';
import { TauriAPI } from '@/utils/tauriApi';
import { DataGovernanceApi, type BackupJobSummary } from '@/api/dataGovernance';

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
const FTP_RISK_WARNING_KEY = 'cloud_storage_ftp_risk_warning_v1';
// #91: FTP/FTPS 后端（PR#103）已合入并具备完整实现（原子上传/重试/TLS 强制），
// 默认放开入口；保留 VITE_ENABLE_EXPERIMENTAL_FTP_STORAGE=false 作为紧急关闭开关。
const FTP_STORAGE_EXPERIMENTAL_ENABLED =
  import.meta.env.VITE_ENABLE_EXPERIMENTAL_FTP_STORAGE !== 'false';

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
  const [ftpConfig, setFtpConfig] = useState<cloudApi.FtpConfig & { endpoint: string }>({
    endpoint: '',
    host: '',
    port: 21,
    username: '',
    password: '',
    useTls: false,
  });
  const [root, setRoot] = useState('deep-student-sync');

  // 端到端加密密码（可选）
  const [encryptionPassword, setEncryptionPassword] = useState('');
  const [showEncryptionPwd, setShowEncryptionPwd] = useState(false);

  // UI 状态
  const [showPassword, setShowPassword] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [showFtpPassword, setShowFtpPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'connected' | 'failed'>('unknown');
  
  // 同步状态
  const [syncStatus, setSyncStatus] = useState<cloudApi.SyncStatus | null>(null);
  const [versions, setVersions] = useState<cloudApi.BackupVersion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [restoreVersionId, setRestoreVersionId] = useState<string | null>(null);
  const [hasStoredFtpConfig, setHasStoredFtpConfig] = useState(false);

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

  // 不安全连接警告对话框状态
  const [showInsecureFtpWarning, setShowInsecureFtpWarning] = useState(false);
  const [showInsecureWebdavWarning, setShowInsecureWebdavWarning] = useState(false);
  const [showInsecureS3Warning, setShowInsecureS3Warning] = useState(false);
  // 记录当前不安全警告的上下文（保存还是测试连接）
  const [insecureWarningAction, setInsecureWarningAction] = useState<'save' | 'test' | null>(null);

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
      let loadedFtpConfig = false;
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
          loadedFtpConfig = config.provider === 'ftp' || Boolean(config.ftp);
          setHasStoredFtpConfig(loadedFtpConfig);
          const leakedCredentials: cloudApi.CloudStorageCredentials = {};
          if (config.webdav) {
            setWebdavConfig(prev => ({ ...prev, ...config.webdav, password: '' }));
            if (config.webdav.password) {
              leakedCredentials.webdavPassword = config.webdav.password;
            }
          }
          if (config.s3) {
            setS3Config(prev => ({ ...prev, ...config.s3, secretAccessKey: '' }));
            if (config.s3.secretAccessKey) {
              leakedCredentials.s3SecretAccessKey = config.s3.secretAccessKey;
            }
          }
          if (config.ftp) {
            const scheme = config.ftp.useTls ? 'ftps' : 'ftp';
            const hostPort = config.ftp.port ? `:${config.ftp.port}` : '';
            const endpoint = `${scheme}://${config.ftp.host}${hostPort}`;
            setFtpConfig(prev => ({ ...prev, ...config.ftp, password: '', endpoint }));
            if (config.ftp.password) {
              leakedCredentials.ftpPassword = config.ftp.password;
            }
          }
          if (config.encryptionPassword) {
            leakedCredentials.encryptionPassword = config.encryptionPassword;
          }
          if (config.root) setRoot(config.root);
          if (
            leakedCredentials.webdavPassword ||
            leakedCredentials.s3SecretAccessKey ||
            leakedCredentials.ftpPassword ||
            leakedCredentials.encryptionPassword
          ) {
            await cloudApi.saveCredentials(leakedCredentials);
            const safeConfig = {
              ...config,
              webdav: config.webdav ? { ...config.webdav, password: '' } : undefined,
              s3: config.s3 ? { ...config.s3, secretAccessKey: '' } : undefined,
              ftp: config.ftp ? { ...config.ftp, password: '' } : undefined,
              encryptionPassword: undefined,
            };
            localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(safeConfig));
          }
          await cloudApi.saveCloudConfigSsot(config);
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
          if (oldConfig.ftp) {
            const scheme = oldConfig.ftp.useTls ? 'ftps' : 'ftp';
            const hostPort = oldConfig.ftp.port ? `:${oldConfig.ftp.port}` : '';
            const endpoint = `${scheme}://${oldConfig.ftp.host}${hostPort}`;
            setFtpConfig(prev => ({ ...prev, ...oldConfig.ftp, password: '', endpoint }));
            if (oldConfig.ftp.password) {
              credentials.ftpPassword = oldConfig.ftp.password;
            }
          }
          if (oldConfig.encryptionPassword) {
            credentials.encryptionPassword = oldConfig.encryptionPassword;
          }
          loadedFtpConfig = oldConfig.provider === 'ftp' || Boolean(oldConfig.ftp);
          setHasStoredFtpConfig(loadedFtpConfig);
          if (oldConfig.root) setRoot(oldConfig.root);
          
          // 保存到安全存储
          if (
            credentials.webdavPassword ||
            credentials.s3SecretAccessKey ||
            credentials.ftpPassword ||
            credentials.encryptionPassword
          ) {
            await cloudApi.saveCredentials(credentials);
          }
          
          // 保存新格式配置（不含密码）
          const safeConfig = {
            ...oldConfig,
            webdav: oldConfig.webdav ? { ...oldConfig.webdav, password: '' } : undefined,
            s3: oldConfig.s3 ? { ...oldConfig.s3, secretAccessKey: '' } : undefined,
            ftp: oldConfig.ftp ? { ...oldConfig.ftp, password: '' } : undefined,
            encryptionPassword: undefined,
          };
          localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(safeConfig));
          await cloudApi.saveCloudConfigSsot(oldConfig);
          
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
          if (credentials.ftpPassword) {
            setFtpConfig(prev => ({ ...prev, password: credentials.ftpPassword! }));
          }
          if (credentials.encryptionPassword) {
            setEncryptionPassword(credentials.encryptionPassword);
          }
        }
      } catch (e: unknown) {
        console.warn('Failed to load credentials from secure storage:', e);
      }

      if (
        loadedFtpConfig &&
        localStorage.getItem(FTP_RISK_WARNING_KEY) !== 'shown'
      ) {
        showGlobalNotification('warning', t('cloudStorage:ftp.experimentalWarning'));
        localStorage.setItem(FTP_RISK_WARNING_KEY, 'shown');
      }
    };
    
    loadConfig();
  }, [t]);

  // 构建配置对象
  const buildConfig = useCallback((): cloudApi.CloudStorageConfig => {
    let ftp: cloudApi.FtpConfig | undefined;
    if (provider === 'ftp') {
      // 从 endpoint URL 解析出 host/port/useTls
      try {
        const url = new URL(ftpConfig.endpoint);
        ftp = {
          host: url.hostname,
          port: parseInt(url.port, 10) || 21,
          username: ftpConfig.username,
          password: ftpConfig.password,
          useTls: url.protocol === 'ftps:',
        };
      } catch {
        // URL 解析失败时回退到原始字段（用于迁移/加载旧配置）
        ftp = {
          host: ftpConfig.host,
          port: ftpConfig.port || 21,
          username: ftpConfig.username,
          password: ftpConfig.password,
          useTls: ftpConfig.useTls,
        };
      }
    }
    return {
      provider,
      webdav: provider === 'webdav' ? webdavConfig : undefined,
      s3: provider === 's3' ? s3Config : undefined,
      ftp,
      root,
      encryptionPassword: encryptionPassword || undefined,
    };
  }, [provider, webdavConfig, s3Config, ftpConfig, root, encryptionPassword]);

  // 实际执行保存逻辑
  const doSaveConfig = useCallback(async () => {
    const config = buildConfig();
    const safeConfig = {
      ...config,
      webdav: config.webdav ? { ...config.webdav, password: '' } : undefined,
      s3: config.s3 ? { ...config.s3, secretAccessKey: '' } : undefined,
      ftp: config.ftp ? { ...config.ftp, password: '' } : undefined,
      encryptionPassword: undefined,
    };

    // 凭据是提交前置条件。只有安全存储成功后，才发布“已配置”的非敏感配置，
    // 避免 Keychain/Credential Manager 失败留下无法工作的半配置状态。
    try {
      await cloudApi.saveCredentials({
        webdavPassword: webdavConfig.password || undefined,
        s3SecretAccessKey: s3Config.secretAccessKey || undefined,
        ftpPassword: ftpConfig.password || undefined,
        encryptionPassword: encryptionPassword || undefined,
      });
    } catch (e: unknown) {
      console.error('Failed to save credentials to secure storage:', e);
      showGlobalNotification('error', t('cloudStorage:messages.configSavedButCredentialsFailed'));
      return;
    }

    try {
      await cloudApi.saveCloudConfigSsot(config);
    } catch (e: unknown) {
      console.error('Failed to save credential-free cloud config SSOT:', e);
      showGlobalNotification('error', t('cloudStorage:messages.configSsotFailed'));
      return;
    }

    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(safeConfig));
    showGlobalNotification('success', t('cloudStorage:messages.configSaved'));
    onConfigChanged?.();
  }, [buildConfig, webdavConfig.password, s3Config.secretAccessKey, ftpConfig.password, encryptionPassword, t, onConfigChanged]);

  // 保存配置（先检查不安全连接）
  const saveConfig = useCallback(async () => {
    const config = buildConfig();
    if (
      (config.provider === 'webdav' && !webdavConfig.password.trim()) ||
      (config.provider === 's3' && !s3Config.secretAccessKey.trim()) ||
      (config.provider === 'ftp' && !ftpConfig.password.trim())
    ) {
      showGlobalNotification('error', t('cloudStorage:errors.passwordRequired'));
      return;
    }

    // FTP 明文连接警告：如果 endpoint 以 ftp:// 开头（非 ftps://），弹窗确认
    if (config.provider === 'ftp' && ftpConfig.endpoint.trim().toLowerCase().startsWith('ftp://')) {
      setInsecureWarningAction('save');
      setShowInsecureFtpWarning(true);
      return;
    }

    // WebDAV HTTP 连接警告：如果 endpoint 以 http:// 开头（非 https://），弹窗确认
    if (config.provider === 'webdav' && webdavConfig.endpoint.trim().toLowerCase().startsWith('http://')) {
      setInsecureWarningAction('save');
      setShowInsecureWebdavWarning(true);
      return;
    }

    // S3 HTTP 连接警告：如果 endpoint 以 http:// 开头（非 https://），弹窗确认
    if (config.provider === 's3' && s3Config.endpoint.trim().toLowerCase().startsWith('http://')) {
      setInsecureWarningAction('save');
      setShowInsecureS3Warning(true);
      return;
    }

    await doSaveConfig();
  }, [buildConfig, webdavConfig.password, webdavConfig.endpoint, s3Config.secretAccessKey, s3Config.endpoint, ftpConfig, t, doSaveConfig]);

  // 实际执行测试连接逻辑
  const doTestConnection = useCallback(async () => {
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

  // 确认保存不安全 FTP/WebDAV/S3 配置
  const handleConfirmInsecureFtpSave = useCallback(async () => {
    setShowInsecureFtpWarning(false);
    if (insecureWarningAction === 'test') {
      await doTestConnection();
    } else {
      await doSaveConfig();
    }
    setInsecureWarningAction(null);
  }, [insecureWarningAction, doSaveConfig, doTestConnection]);

  // 确认保存不安全 WebDAV 配置
  const handleConfirmInsecureWebdavSave = useCallback(async () => {
    setShowInsecureWebdavWarning(false);
    if (insecureWarningAction === 'test') {
      await doTestConnection();
    } else {
      await doSaveConfig();
    }
    setInsecureWarningAction(null);
  }, [insecureWarningAction, doSaveConfig, doTestConnection]);

  // 确认保存不安全 S3 配置
  const handleConfirmInsecureS3Save = useCallback(async () => {
    setShowInsecureS3Warning(false);
    if (insecureWarningAction === 'test') {
      await doTestConnection();
    } else {
      await doSaveConfig();
    }
    setInsecureWarningAction(null);
  }, [insecureWarningAction, doSaveConfig, doTestConnection]);

  // 清除配置
  const clearConfig = useCallback(async () => {
    let clearFailed = false;
    try {
      await cloudApi.clearCloudConfigSsot();
    } catch (e: unknown) {
      clearFailed = true;
      console.warn('Failed to clear cloud config backend SSOT:', e);
    }
    // 清除安全存储中的凭据
    try {
      await cloudApi.deleteCredentials();
    } catch (e: unknown) {
      clearFailed = true;
      console.warn('Failed to delete credentials from secure storage:', e);
    }
    // The local copy is only a UI cache; clear it even when one backend cleanup
    // failed so stale credentials are never reintroduced by the WebView.
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    // 重置状态
    setOpProgress(null);
    setHasStoredFtpConfig(false);
    setWebdavConfig({ endpoint: '', username: '', password: '' });
    setS3Config({ endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', region: '', pathStyle: false });
    setFtpConfig({ host: '', port: 21, username: '', password: '', useTls: false, endpoint: '' });
    setRoot('deep-student-sync');
    setEncryptionPassword('');
    setConnectionStatus('unknown');
    setSyncStatus(null);
    setVersions([]);
    showGlobalNotification(
      clearFailed ? 'error' : 'info',
      t(clearFailed ? 'cloudStorage:messages.configClearPartial' : 'cloudStorage:messages.configCleared'),
    );
    onConfigChanged?.();
  }, [t, onConfigChanged]);

  const shouldShowFtpOption = FTP_STORAGE_EXPERIMENTAL_ENABLED || hasStoredFtpConfig || provider === 'ftp';

  // 测试连接（先检查不安全连接）
  const testConnection = useCallback(async () => {
    // FTP 明文连接警告
    if (provider === 'ftp' && ftpConfig.endpoint.trim().toLowerCase().startsWith('ftp://')) {
      setInsecureWarningAction('test');
      setShowInsecureFtpWarning(true);
      return;
    }

    // WebDAV HTTP 连接警告
    if (provider === 'webdav' && webdavConfig.endpoint.trim().toLowerCase().startsWith('http://')) {
      setInsecureWarningAction('test');
      setShowInsecureWebdavWarning(true);
      return;
    }

    // S3 HTTP 连接警告
    if (provider === 's3' && s3Config.endpoint.trim().toLowerCase().startsWith('http://')) {
      setInsecureWarningAction('test');
      setShowInsecureS3Warning(true);
      return;
    }

    await doTestConnection();
  }, [provider, ftpConfig.endpoint, webdavConfig.endpoint, s3Config.endpoint, doTestConnection]);

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
    } else if (provider === 's3') {
      const endpoint = s3Config.endpoint.trim();
      if (!endpoint || !s3Config.bucket.trim() || !s3Config.accessKeyId.trim() || !s3Config.secretAccessKey.trim()) return false;
      try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
      } catch { return false; }
      return true;
    } else {
      // FTP provider
      const endpoint = ftpConfig.endpoint.trim();
      const username = ftpConfig.username.trim();
      const password = ftpConfig.password.trim();
      if (!endpoint || !username || !password) return false;
      try {
        const url = new URL(endpoint);
        if (!['ftp:', 'ftps:'].includes(url.protocol)) return false;
      } catch { return false; }
      return true;
    }
  }, [provider, webdavConfig, s3Config, ftpConfig]);

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

  // [P3 Fix] 使用 AbortController 保护轮询循环，组件卸载时自动取消，
  // 防止对已卸载组件的 state 更新和不必要的 API 请求。
  const abortCtrlRef = useRef<AbortController | null>(null);
  const activeGovernanceJobRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      abortCtrlRef.current?.abort();
      const jobId = activeGovernanceJobRef.current;
      if (jobId) {
        void DataGovernanceApi.cancelBackup(jobId).catch((error: unknown) => {
          console.warn('[cloud-backup] failed to cancel job during unmount:', error);
        });
      }
    };
  }, []);

  const waitForGovernanceJob = useCallback(async (
    jobId: string,
    kind: 'export' | 'import',
    timeoutMs = 180000
  ): Promise<BackupJobSummary> => {
    abortCtrlRef.current?.abort();
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    activeGovernanceJobRef.current = jobId;

    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < timeoutMs) {
        if (ctrl.signal.aborted) {
          throw new Error(`${kind} job polling cancelled (component unmounted)`);
        }

        const job = await DataGovernanceApi.getBackupJob(jobId);
        if (job) {
          if (job.status === 'completed') {
            if (job.result?.success !== true) {
              throw new Error(
                job.result?.error ||
                job.result?.message ||
                job.message ||
                `${kind} task completed without a successful result`
              );
            }
            return job;
          }

          if (job.status === 'failed' || job.status === 'cancelled') {
            throw new Error(job.result?.error || job.message || `${kind} task failed`);
          }
        }

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          ctrl.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        });
      }

      await DataGovernanceApi.cancelBackup(jobId).catch((error: unknown) => {
        console.warn('[cloud-backup] failed to cancel timed out job:', error);
      });
      throw new Error(`backup job timeout: ${kind} (${Math.floor(timeoutMs / 1000)}s)`);
    } finally {
      if (activeGovernanceJobRef.current === jobId) {
        activeGovernanceJobRef.current = null;
      }
    }
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
    setOpProgress({ operation: 'upload', stageIndex: 1, stageTotal: 4, stageLabel: t('cloudStorage:progress.backupDatabase'), bytesDone: 0, bytesTotal: 0, isTransferring: false, error: null });
    try {
      // 阶段 1/4：创建备份
      let backupId: string;
      try {
        const backupJob = await DataGovernanceApi.backupTiered(
          ['core', 'important', 'rebuildable', 'large_assets'],
          undefined,
          undefined,
          true,
          Number.MAX_SAFE_INTEGER,
        );
        const backupSummary = await waitForGovernanceJob(backupJob.job_id, 'export');
        backupId = resolveBackupId(backupSummary) ?? '';
        if (!backupId) throw new Error('backup_id missing from backup result');
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.backupDatabaseFailed', { error: getErrorMessage(e) }));
      }

      // 阶段 2/4：导出 ZIP
      setStage('upload', 2, 4, t('cloudStorage:progress.packageZip'));
      let zipPath: string;
      try {
        const zipExportJob = await DataGovernanceApi.exportZip(backupId);
        const zipExportSummary = await waitForGovernanceJob(zipExportJob.job_id, 'export');
        zipPath = resolveExportZipPath(zipExportSummary) ?? '';
        if (!zipPath) throw new Error('zip export path missing from export result');
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.packageZipFailed', { error: getErrorMessage(e) }));
      }

      // 阶段 3/4：上传至云端（字节进度由 Tauri 事件驱动）
      setStage('upload', 3, 4, t('cloudStorage:progress.uploadCloud'));
      let result: cloudApi.UploadResult;
      try {
        const appVersion = await TauriAPI.getAppVersion();
        result = await cloudApi.uploadBackup(buildConfig(), zipPath, appVersion);
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.uploadFileFailed', { error: getErrorMessage(e) }));
      }

      // 阶段 4/4：刷新状态
      setStage('upload', 4, 4, t('cloudStorage:progress.refreshStatus'));
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
    setOpProgress({ operation: 'download', stageIndex: 1, stageTotal: 3, stageLabel: t('cloudStorage:progress.downloadCloud'), bytesDone: 0, bytesTotal: 0, isTransferring: false, error: null });

    try {
      // 阶段 1/3：下载云端备份（字节进度由 Tauri 事件驱动）
      const appDataDir = await TauriAPI.getAppDataDir();
      const downloadDir = `${appDataDir}/backups/cloud-downloads`;
      let downloadResult: cloudApi.DownloadResult;
      try {
        downloadResult = await cloudApi.downloadBackup(buildConfig(), versionId, downloadDir);
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.downloadBackupFailed', { error: getErrorMessage(e) }));
      }

      // 阶段 2/3：导入 ZIP
      setStage('download', 2, 3, t('cloudStorage:progress.importZip'));
      let importedBackupId: string;
      try {
        const importJob = await DataGovernanceApi.importZip(downloadResult.localPath);
        const importSummary = await waitForGovernanceJob(importJob.job_id, 'import');
        importedBackupId = resolveBackupId(importSummary) ?? '';
        if (!importedBackupId) throw new Error('backup_id missing from import result');
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.importZipFailed', { error: getErrorMessage(e) }));
      }

      // 阶段 3/3：恢复数据库
      setStage('download', 3, 3, t('cloudStorage:progress.restoreDatabase'));
      try {
        const restoreJob = await DataGovernanceApi.restoreBackup(importedBackupId);
        await waitForGovernanceJob(restoreJob.job_id, 'import');
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.restoreDatabaseFailed', { error: getErrorMessage(e) }));
      }

      setOpProgress(null);
      showGlobalNotification('success', t('cloudStorage:download.successRestart'));
      // The restored slot is pending activation. Continuing to edit the old
      // slot can create writes that disappear at the next launch, so cut over
      // immediately after a verified restore.
      await TauriAPI.restartApp();
      if (import.meta.env.DEV) {
        window.location.reload();
      }
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
              <CheckCircle size={16} className="text-primary" />
            </div>
          )}
          <span className="font-medium">{t('cloudStorage:provider.webdav')}</span>
          <span className="text-xs text-muted-foreground line-clamp-2 whitespace-normal">
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
                : 'border-border bg-transparent hover:bg-[var(--interactive-hover)]'
          }`}
        >
          {provider === 's3' && s3Enabled !== false && (
            <div className="absolute right-2 top-2">
              <CheckCircle size={16} className="text-primary" />
            </div>
          )}
          <span className={`font-medium ${s3Enabled === false ? 'line-through' : ''}`}>
            {t('cloudStorage:provider.s3')}
          </span>
          <span className={`text-xs line-clamp-2 whitespace-normal ${s3Enabled === false ? 'text-destructive/70' : 'text-muted-foreground'}`}>
            {s3Enabled === false 
              ? t('cloudStorage:provider.s3Disabled')
              : t('cloudStorage:provider.s3Desc')}
          </span>
        </NotionButton>
        {shouldShowFtpOption && (
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={() => setProvider('ftp')}
            className={`relative !h-auto !justify-start flex-col items-start gap-1 !rounded-lg border-2 !p-3 text-left ${
              provider === 'ftp'
                ? 'border-primary bg-primary/5'
                : 'border-border bg-transparent hover:bg-[var(--interactive-hover)]'
            }`}
          >
            {provider === 'ftp' && (
              <div className="absolute right-2 top-2">
                <CheckCircle size={16} className="text-primary" />
              </div>
            )}
            <span className="font-medium">{t('cloudStorage:provider.ftp')}</span>
            <span className="text-xs text-warning line-clamp-2 whitespace-normal">
              {t('cloudStorage:provider.ftpDescExperimental')}
            </span>
          </NotionButton>
        )}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                <ApiKeyField
                  id="webdav-password"
                  placeholder={t('cloudStorage:webdav.passwordPlaceholder')}
                  value={webdavConfig.password}
                  onChange={(e) => setWebdavConfig({ ...webdavConfig, password: e.target.value })}
                  revealed={showPassword}
                  canReveal={webdavConfig.password.trim().length > 0}
                  onToggle={() => setShowPassword(!showPassword)}
                  showLabel={t('common:securePassword.showPassword')}
                  hideLabel={t('common:securePassword.hidePassword')}
                />
                <p className="text-xs text-muted-foreground">{t('cloudStorage:webdav.passwordHint')}</p>
              </div>
            </div>
          </TabsContent>

          {/* S3 配置 */}
          <TabsContent value="s3" className="space-y-4 mt-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                <ApiKeyField
                  id="s3-secret-key"
                  placeholder={t('cloudStorage:s3.secretAccessKeyPlaceholder')}
                  value={s3Config.secretAccessKey}
                  onChange={(e) => setS3Config({ ...s3Config, secretAccessKey: e.target.value })}
                  revealed={showSecretKey}
                  canReveal={s3Config.secretAccessKey.trim().length > 0}
                  onToggle={() => setShowSecretKey(!showSecretKey)}
                  showLabel={t('common:securePassword.showPassword')}
                  hideLabel={t('common:securePassword.hidePassword')}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

          {/* FTP 配置 */}
          <TabsContent value="ftp" className="space-y-4 mt-0">
            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
              {t('cloudStorage:ftp.experimentalWarning')}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ftp-endpoint">{t('cloudStorage:ftp.endpoint')}</Label>
              <Input
                id="ftp-endpoint"
                placeholder={t('cloudStorage:ftp.endpointPlaceholder')}
                value={ftpConfig.endpoint}
                onChange={(e) => setFtpConfig({ ...ftpConfig, endpoint: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('cloudStorage:ftp.endpointHint')}</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ftp-username">{t('cloudStorage:ftp.username')}</Label>
                <Input
                  id="ftp-username"
                  placeholder={t('cloudStorage:ftp.usernamePlaceholder')}
                  value={ftpConfig.username}
                  onChange={(e) => setFtpConfig({ ...ftpConfig, username: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ftp-password">{t('cloudStorage:ftp.password')}</Label>
                <ApiKeyField
                  id="ftp-password"
                  placeholder={t('cloudStorage:ftp.passwordPlaceholder')}
                  value={ftpConfig.password}
                  onChange={(e) => setFtpConfig({ ...ftpConfig, password: e.target.value })}
                  revealed={showFtpPassword}
                  canReveal={ftpConfig.password.trim().length > 0}
                  onToggle={() => setShowFtpPassword(!showFtpPassword)}
                  showLabel={t('common:securePassword.showPassword')}
                  hideLabel={t('common:securePassword.hidePassword')}
                />
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

        {/* 端到端加密配置（可选） */}
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-center gap-2">
            <WarningCircle size={16} className="text-amber-600 dark:text-amber-400 shrink-0" />
            <Label htmlFor="cloud-encryption-password" className="font-medium">
              {t('cloudStorage:encryption.title')}
            </Label>
          </div>
          <ApiKeyField
            id="cloud-encryption-password"
            placeholder={t('cloudStorage:encryption.placeholder')}
            value={encryptionPassword}
            onChange={(e) => setEncryptionPassword(e.target.value)}
            autoComplete="new-password"
            revealed={showEncryptionPwd}
            canReveal={encryptionPassword.trim().length > 0}
            onToggle={() => setShowEncryptionPwd(!showEncryptionPwd)}
            showLabel={t('common:securePassword.showPassword')}
            hideLabel={t('common:securePassword.hidePassword')}
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t('cloudStorage:encryption.description')}{' '}
            <span className="text-destructive font-medium">{t('cloudStorage:encryption.warning')}</span>
          </p>
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
                <CircleNotch size={16} className="mr-2 animate-spin" />
                {t('cloudStorage:actions.testing')}
              </>
            ) : (
              <>
                {connectionStatus === 'connected' && <CheckCircle size={16} className="mr-2 text-green-500" />}
                {connectionStatus === 'failed' && <XCircle size={16} className="mr-2 text-red-500" />}
                {t('cloudStorage:actions.testConnection')}
              </>
            )}
          </NotionButton>
          <NotionButton onClick={saveConfig} disabled={!isConfigValid()}>
            {t('cloudStorage:actions.save')}
          </NotionButton>
          <NotionButton variant="danger" onClick={clearConfig}>
            {t('cloudStorage:actions.clearConfig')}
          </NotionButton>
        </div>

        {/* 同步状态 */}
        {syncStatus && (
          <div className="border rounded-lg p-4 space-y-3">
            <h4 className="font-medium flex items-center gap-2">
              {syncStatus.connected ? (
                <CheckCircle size={16} className="text-green-500" />
              ) : (
                <XCircle size={16} className="text-red-500" />
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
                      <WarningCircle size={16} className="shrink-0 text-destructive" />
                    ) : (
                      <CircleNotch size={16} className="shrink-0 animate-spin text-primary" />
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
                    <CircleNotch size={16} className="mr-2 animate-spin" />
                    {t('cloudStorage:actions.uploading')}
                  </>
                ) : (
                  <>
                    <Upload size={16} className="mr-2" />
                    {t('cloudStorage:actions.uploadNow')}
                  </>
                )}
              </NotionButton>
              <NotionButton
                size="sm"
                variant="outline"
                onClick={() => setShowHistory(!showHistory)}
              >
                <ClockCounterClockwise size={16} className="mr-2" />
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
                          <CircleNotch size={16} className="animate-spin" />
                        ) : (
                          <Download size={16} />
                        )}
                      </NotionButton>
                      <NotionButton
                        size="sm"
                        variant="ghost"
                        title={t('cloudStorage:history.delete')}
                        onClick={() => openDeleteConfirm(version.id)}
                      >
                        <Trash size={16} className="text-destructive" />
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

  // 不安全 FTP 连接警告对话框
  const insecureFtpWarningDialog = (
    <NotionAlertDialog
      open={showInsecureFtpWarning}
      onOpenChange={(open) => { if (!open) setShowInsecureFtpWarning(false); }}
      title={t('cloudStorage:ftp.insecureWarning.title')}
      description={t('cloudStorage:ftp.insecureWarning.description')}
      confirmText={t('cloudStorage:ftp.insecureWarning.confirm')}
      cancelText={t('common:actions.cancel')}
      confirmVariant="warning"
      onConfirm={handleConfirmInsecureFtpSave}
    />
  );

  // 不安全 WebDAV 连接警告对话框
  const insecureWebdavWarningDialog = (
    <NotionAlertDialog
      open={showInsecureWebdavWarning}
      onOpenChange={(open) => { if (!open) setShowInsecureWebdavWarning(false); }}
      title={t('cloudStorage:webdav.insecureWarning.title')}
      description={t('cloudStorage:webdav.insecureWarning.description')}
      confirmText={t('cloudStorage:webdav.insecureWarning.confirm')}
      cancelText={t('common:actions.cancel')}
      confirmVariant="warning"
      onConfirm={handleConfirmInsecureWebdavSave}
    />
  );

  // 不安全 S3 连接警告对话框
  const insecureS3WarningDialog = (
    <NotionAlertDialog
      open={showInsecureS3Warning}
      onOpenChange={(open) => { if (!open) setShowInsecureS3Warning(false); }}
      title={t('cloudStorage:s3.insecureWarning.title')}
      description={t('cloudStorage:s3.insecureWarning.description')}
      confirmText={t('cloudStorage:s3.insecureWarning.confirm')}
      cancelText={t('common:actions.cancel')}
      confirmVariant="warning"
      onConfirm={handleConfirmInsecureS3Save}
    />
  );

  // Dialog 模式下直接渲染内容
  if (isDialog) {
    return (
      <>
        <div className="space-y-3">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-lg">
              <Cloud size={20} />
              {t('cloudStorage:title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('cloudStorage:description')}</p>
          </div>
          {content}
        </div>
        {restoreConfirmDialog}
        {deleteConfirmDialog}
        {insecureFtpWarningDialog}
        {insecureWebdavWarningDialog}
        {insecureS3WarningDialog}
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
      {insecureFtpWarningDialog}
      {insecureWebdavWarningDialog}
      {insecureS3WarningDialog}
    </>
  );
};

export default CloudStorageSection;
