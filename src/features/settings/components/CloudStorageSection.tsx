/**
 * 云存储配置面板
 * 
 * 支持 WebDAV；桌面端还支持 S3 兼容存储与实验性 FTP。Android 仅 WebDAV。
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Cloud, CheckCircle, XCircle, CircleNotch, ClockCounterClockwise, Upload, Download, Trash, WarningCircle, ShieldCheck } from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Switch } from '@/components/ui/shad/Switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { ApiKeyField } from './ApiKeyField';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import * as cloudApi from '@/utils/cloudStorageApi';
import { TauriAPI } from '@/utils/tauriApi';
import { DataGovernanceApi, type BackupJobSummary } from '@/api/dataGovernance';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { parseCommandErrorEnvelope } from '@/api/tauriClient';
import { isMobilePlatform } from '@/utils/platform';
import { useShallow } from 'zustand/react/shallow';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import {
  CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS,
  localizeCloudStorageError,
} from './data-governance/localizeCloudError';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

function isExplicitCloudEncryptionPasswordTooShort(password: string): boolean {
  const trimmed = password.trim();
  return trimmed.length > 0 && [...trimmed].length < CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS;
}

// ==================== [R11-check] 云端仓库巡检（只读） ====================

/** 巡检问题类别（与后端 `cloud_storage::repo_check::RepoCheckProblemKind` 对齐） */
type RepoCheckProblemKind =
  | 'missingObject'
  | 'checksumMismatch'
  | 'undecodableDsbkHeader'
  | 'plaintextInEncryptedRepo'
  | 'encryptedWithoutMarker'
  | 'orphanObject'
  | 'tempLeftover'
  | 'corruptManifest'
  | 'conflictingManifestEntry'
  | 'corruptEncryptionMarker'
  | 'objectReadFailed';

interface RepoCheckProblem {
  kind: RepoCheckProblemKind;
  objectKey?: string;
  versionId?: string;
  detail: string;
}

/** 巡检报告（与后端 `RepoCheckReport` 对齐） */
interface RepoCheckReport {
  status: 'ok' | 'problemsFound' | 'incomplete';
  listingTruncated: boolean;
  encryptionMarkerPresent: boolean;
  versionsReferenced: number;
  objectsChecked: number;
  bytesVerified: number;
  orphanObjects: number;
  problems: RepoCheckProblem[];
  problemsTruncated: boolean;
  checkedAt: string;
}

/** 表示某个版本已坏（无法完整恢复）的问题类别 */
const BAD_OBJECT_KINDS: ReadonlySet<RepoCheckProblemKind> = new Set([
  'missingObject',
  'checksumMismatch',
  'undecodableDsbkHeader',
  'plaintextInEncryptedRepo',
]);

/** manifest / 加密标记层面的问题类别 */
const MANIFEST_KINDS: ReadonlySet<RepoCheckProblemKind> = new Set([
  'corruptManifest',
  'conflictingManifestEntry',
  'corruptEncryptionMarker',
  'encryptedWithoutMarker',
]);

/** 云端仓库巡检操作（restic `check` 档，只读不修） */
async function runCloudRepoCheck(config: cloudApi.CloudStorageConfig): Promise<RepoCheckReport> {
  return invoke<RepoCheckReport>('data_governance_repo_check', {
    cloudConfig: cloudApi.toRuntimeCloudStorageConfig(config),
  });
}

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
const CONFIG_STORAGE_KEY = cloudApi.CLOUD_STORAGE_CONFIG_V2_STORAGE_KEY;
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
  const { enterMaintenanceMode, requireMaintenanceRestart, exitMaintenanceMode } = useSystemStatusStore(
    useShallow((state) => ({
      enterMaintenanceMode: state.enterMaintenanceMode,
      requireMaintenanceRestart: state.requireMaintenanceRestart,
      exitMaintenanceMode: state.exitMaintenanceMode,
    })),
  );

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
  const [allowInsecure, setAllowInsecure] = useState(false);

  // 端到端加密密码（可选）
  const [encryptionPassword, setEncryptionPassword] = useState('');
  const [showEncryptionPwd, setShowEncryptionPwd] = useState(false);

  // UI 状态
  const [showPassword, setShowPassword] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [showFtpPassword, setShowFtpPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'unknown' | 'connected' | 'failed'>('unknown');
  // 三态配置状态机（前端认知）：'draft' = 表单内容尚未发布（含已测试但未
  // 发布），'published' = 表单与后端已发布配置一致。草稿测试的成功/失败都
  // 不改变该状态；只有 cloud_config_publish 成功才置 'published'。
  const [configPhase, setConfigPhase] = useState<'draft' | 'published'>('draft');
  // 后端已发布配置回填表单时跳过一次「标记为草稿」，hydration 不是用户编辑
  const hydratingFormRef = useRef(true);
  const [secureStoreIssue, setSecureStoreIssue] = useState<string | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<cloudApi.CloudStorageCredentialStatus>({
    webdavPasswordConfigured: false,
    s3SecretAccessKeyConfigured: false,
    ftpPasswordConfigured: false,
    encryptionPasswordConfigured: false,
  });

  // [R11-android2 / P2-LOCALE] 平台能力错误只按后端稳定 code 映射。
  // message 是诊断文本，允许改语言/措辞，禁止再以正则参与程序分派。
  const localizeCloudError = useCallback(
    (error: unknown): string => localizeCloudStorageError(error, t),
    [t],
  );

  const markSecureStoreIssue = useCallback(
    (error: unknown, operation: 'read' | 'write'): string | null => {
      const envelope = parseCommandErrorEnvelope(error);
      if (!envelope?.code.startsWith('SECURE_STORE_')) return null;
      const message = t(
        operation === 'read'
          ? 'cloudStorage:messages.secureStoreReadFailed'
          : 'cloudStorage:messages.secureStoreWriteFailed',
      );
      setSecureStoreIssue(message);
      return message;
    },
    [t],
  );
  
  // 同步状态
  const [syncStatus, setSyncStatus] = useState<cloudApi.SyncStatus | null>(null);
  const [versions, setVersions] = useState<cloudApi.BackupVersion[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [restoreVersionId, setRestoreVersionId] = useState<string | null>(null);
  const [hasStoredFtpConfig, setHasStoredFtpConfig] = useState(false);

  // 细粒度进度状态
  const [opProgress, setOpProgress] = useState<SyncOpProgress | null>(null);

  // [R11-check] 云端仓库巡检状态（只读操作，独立于上传/下载进度）
  const [repoChecking, setRepoChecking] = useState(false);
  const [repoCheckReport, setRepoCheckReport] = useState<RepoCheckReport | null>(null);
  const [repoCheckError, setRepoCheckError] = useState<string | null>(null);

  // S3 feature 状态
  const [s3Enabled, setS3Enabled] = useState<boolean | null>(null);

  // 恢复确认对话框状态
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [pendingRestoreVersionId, setPendingRestoreVersionId] = useState<string | null>(null);

  // 删除确认对话框状态
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDeleteVersionId, setPendingDeleteVersionId] = useState<string | null>(null);
  // 清除配置确认对话框状态（danger 操作必须显式确认）
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // 停用端到端加密确认对话框状态（同为 danger：删除本机加密密码后，
  // 未另存密码的用户将永久失去已加密云端备份的解密能力）
  const [disableEncryptionConfirmOpen, setDisableEncryptionConfirmOpen] = useState(false);
  // P2-12 移动端契约：版本删除确认改为按钮两段式行内确认（4 秒未确认自动复位）
  const { isSmallScreen } = useBreakpoint();
  const [confirmingDeleteVersionId, setConfirmingDeleteVersionId] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmingDeleteVersionId) return;
    const timer = window.setTimeout(() => setConfirmingDeleteVersionId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingDeleteVersionId]);

  useEffect(() => {
    let active = true;
    void cloudApi.getDeviceId()
      .then(deviceId => {
        if (active) setCurrentDeviceId(deviceId);
      })
      .catch(error => {
        console.warn('[cloud-backup] failed to resolve current device id:', error);
      });
    return () => {
      active = false;
    };
  }, []);

  // 不安全连接警告对话框状态
  const [showInsecureFtpWarning, setShowInsecureFtpWarning] = useState(false);
  const [showInsecureWebdavWarning, setShowInsecureWebdavWarning] = useState(false);
  // 记录当前不安全警告的上下文（保存还是测试连接）
  const [insecureWarningAction, setInsecureWarningAction] = useState<'save' | 'test' | null>(null);
  // 短口令确认对话框：8 字符下限只管「新设」口令。v0.9.44 没有长度限制，
  // 换机/重装用户必须能重输存量短口令来解密既有云端备份；用户显式确认
  // 「这是旧口令」后按存量口令保存，新设短口令仍被拒绝。
  const [shortPasswordConfirm, setShortPasswordConfirm] = useState<
    { action: 'save' | 'test'; allowInsecure: boolean } | null
  >(null);

  // 任何表单编辑都把前端认知回退为「未测试的草稿」：后端已发布配置不受
  // 影响，但陈旧的「已连接」测试结论不能继续代表编辑后的表单内容。
  useEffect(() => {
    if (hydratingFormRef.current) {
      hydratingFormRef.current = false;
      return;
    }
    setConfigPhase('draft');
    setConnectionStatus('unknown');
  }, [provider, webdavConfig, s3Config, ftpConfig, root, encryptionPassword]);

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
    let active = true;
    const loadConfig = async () => {
      let loadedFtpConfig = false;
      // 检测 S3 feature 是否启用
      const s3Available = await cloudApi.isS3Enabled();
      if (active) setS3Enabled(s3Available);

      // Backend DB wins unconditionally. The resolver consults localStorage
      // only after an explicit `configured: false`, then performs one migration.
      try {
        const config = await cloudApi.resolveCloudStorageConfig();
        if (config && active) {
          // 后端已发布配置回填表单：这不是用户编辑，跳过一次草稿标记，
          // 并把前端认知置为「已发布」。
          hydratingFormRef.current = true;
          setConfigPhase('published');
          setProvider(config.provider);
          loadedFtpConfig = config.provider === 'ftp' || Boolean(config.ftp);
          setHasStoredFtpConfig(loadedFtpConfig);
          if (config.webdav) {
            setWebdavConfig(prev => ({ ...prev, ...config.webdav, password: '' }));
          }
          if (config.s3) {
            setS3Config(prev => ({ ...prev, ...config.s3, secretAccessKey: '' }));
          }
          if (config.ftp) {
            const scheme = config.ftp.useTls ? 'ftps' : 'ftp';
            const hostPort = config.ftp.port ? `:${config.ftp.port}` : '';
            const endpoint = `${scheme}://${config.ftp.host}${hostPort}`;
            setFtpConfig(prev => ({ ...prev, ...config.ftp, password: '', endpoint }));
          }
          if (config.root) setRoot(config.root);
          setAllowInsecure(config.allowInsecure ?? false);
        } else if (active) {
          setHasStoredFtpConfig(false);
          setAllowInsecure(false);
        }
      } catch (e: unknown) {
        console.error('Failed to resolve backend cloud storage config:', e);
        const secureMessage = markSecureStoreIssue(e, 'read');
        showGlobalNotification(
          'error',
          secureMessage ?? `${t('cloudStorage:messages.configSsotFailed')}: ${localizeCloudError(e)}`,
        );
      }

      if (!active) return;

      // Only presence flags cross backend-to-frontend IPC. Secret values remain
      // exclusively in secure storage and blank fields mean "keep existing".
      try {
        const status = await cloudApi.getCredentialStatus();
        if (!active) return;
        setSecureStoreIssue(null);
        setCredentialStatus(status);
      } catch (e: unknown) {
        console.warn('Failed to load credentials from secure storage:', e);
        const secureMessage = markSecureStoreIssue(e, 'read');
        showGlobalNotification(
          'warning',
          secureMessage ?? t('cloudStorage:messages.secureStoreReadFailed'),
        );
      }

      if (
        loadedFtpConfig &&
        localStorage.getItem(FTP_RISK_WARNING_KEY) !== 'shown'
      ) {
        showGlobalNotification('warning', t('cloudStorage:ftp.experimentalWarning'));
        localStorage.setItem(FTP_RISK_WARNING_KEY, 'shown');
      }
    };
    
    void loadConfig();
    return () => {
      active = false;
    };
  }, [localizeCloudError, markSecureStoreIssue, t]);

  // 构建配置对象
  const buildConfig = useCallback((
    allowInsecureOverride = allowInsecure,
  ): cloudApi.CloudStorageConfig => {
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
      allowInsecure: allowInsecureOverride,
      encryptionPassword: encryptionPassword || undefined,
    };
  }, [provider, webdavConfig, s3Config, ftpConfig, root, allowInsecure, encryptionPassword]);

  // 当前表单里的凭据快照。空字段不上送：发布时表示「保留已发布值」
  // （「空=保留」合并语义只在 publish 生效）；草稿测试后端禁止 hydrate，
  // 空就是空——缺凭据的草稿会如实报 E_CLOUD_CREDENTIALS_UNAVAILABLE。
  const buildFormCredentials = useCallback((): cloudApi.CloudStorageCredentials => ({
    webdavPassword:
      provider === 'webdav' && webdavConfig.password.trim()
        ? webdavConfig.password
        : undefined,
    s3SecretAccessKey:
      provider === 's3' && s3Config.secretAccessKey.trim()
        ? s3Config.secretAccessKey
        : undefined,
    ftpPassword:
      provider === 'ftp' && ftpConfig.password.trim()
        ? ftpConfig.password
        : undefined,
    encryptionPassword: encryptionPassword.trim() ? encryptionPassword : undefined,
  }), [provider, webdavConfig.password, s3Config.secretAccessKey, ftpConfig.password, encryptionPassword]);

  // 实际执行发布逻辑：凭据+非敏感配置经 cloud_config_publish 单逻辑提交，
  // 失败保持旧 generation——后端不留半配置，前端也不写本地 SSOT 缓存/标记。
  const doSaveConfig = useCallback(async (
    allowInsecureOverride = false,
    acceptPreexistingShortPassword = false,
  ) => {
    if (
      !acceptPreexistingShortPassword
      && isExplicitCloudEncryptionPasswordTooShort(encryptionPassword)
    ) {
      // 不直接拒绝：换机/重装用户重输的 v0.9.44 存量短口令必须有路可走。
      setShortPasswordConfirm({ action: 'save', allowInsecure: allowInsecureOverride });
      return;
    }

    const config = buildConfig(allowInsecureOverride);

    let published: cloudApi.CloudConfigPublishResponse;
    try {
      published = await cloudApi.publishCloudConfig(config, buildFormCredentials(), {
        encryptionPasswordIsPreexisting: acceptPreexistingShortPassword,
      });
    } catch (e: unknown) {
      console.error('Failed to publish cloud configuration:', e);
      // 发布失败即整体失败：旧凭据与旧配置仍然生效，表单草稿原样保留。
      // SECURE_STORE_* 给可行动的密钥库提示，其余按稳定 code 本地化。
      const secureMessage = markSecureStoreIssue(e, 'write');
      showGlobalNotification(
        'error',
        `${secureMessage ?? t('cloudStorage:messages.configPublishFailed')}: ${localizeCloudError(e)}`,
      );
      return;
    }

    setSecureStoreIssue(null);
    setAllowInsecure(published.config.allowInsecure ?? false);
    // 仅 UI 缓存；只有发布成功后才允许写，后端 SSOT 为准。
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(published.config));
    localStorage.setItem(cloudApi.CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY, '1');
    setConfigPhase('published');
    showGlobalNotification('success', t('cloudStorage:messages.configSaved'));
    onConfigChanged?.();

    // 凭据存在旗标经只读接口刷新（secret 值不回传 IPC）；刷新失败不影响
    // 发布结果，仅保留旧徽标。
    try {
      setCredentialStatus(await cloudApi.getCredentialStatus());
    } catch (e: unknown) {
      console.warn('Failed to refresh credential status after publish:', e);
    }

    // 发布成功后再刷新已发布配置的状态与版本列表；刷新失败只影响展示，
    // 不影响发布结果。
    try {
      const status = await cloudApi.getSyncStatus(config);
      setSyncStatus(status);
      const versionList = await cloudApi.listVersions(config);
      setVersions(versionList);
    } catch (e: unknown) {
      console.warn('Failed to refresh cloud status after publish:', e);
    }
  }, [buildConfig, buildFormCredentials, encryptionPassword, localizeCloudError, markSecureStoreIssue, t, onConfigChanged]);

  // 保存配置（先检查不安全连接）
  const saveConfig = useCallback(async () => {
    const config = buildConfig();
    if (
      (config.provider === 'webdav'
        && !webdavConfig.password.trim()
        && !credentialStatus.webdavPasswordConfigured) ||
      (config.provider === 's3'
        && !s3Config.secretAccessKey.trim()
        && !credentialStatus.s3SecretAccessKeyConfigured) ||
      (config.provider === 'ftp'
        && !ftpConfig.password.trim()
        && !credentialStatus.ftpPasswordConfigured)
    ) {
      showGlobalNotification('error', t('cloudStorage:errors.passwordRequired'));
      return;
    }

    // Public cleartext transports require an explicit, persisted acknowledgement.
    if (config.provider === 'ftp' && cloudApi.requiresInsecureTransportOptIn(config)) {
      setInsecureWarningAction('save');
      setShowInsecureFtpWarning(true);
      return;
    }

    if (config.provider === 'webdav' && cloudApi.requiresInsecureTransportOptIn(config)) {
      setInsecureWarningAction('save');
      setShowInsecureWebdavWarning(true);
      return;
    }

    // Public S3 has no insecure override. Loopback HTTP remains allowed.
    if (config.provider === 's3' && cloudApi.isPublicHttpEndpoint(s3Config.endpoint)) {
      showGlobalNotification('error', t('cloudStorage:s3.insecureWarning.description'));
      return;
    }

    await doSaveConfig(false);
  }, [buildConfig, credentialStatus, webdavConfig.password, s3Config.secretAccessKey, s3Config.endpoint, ftpConfig, t, doSaveConfig]);

  // 实际执行测试连接逻辑：草稿试连。表单配置与凭据只随本次 IPC 一次性传给
  // 后端 cloud_config_test_connection_draft，后端不写安全存储、不改 active
  // SSOT/generation。成功/失败都不落任何持久化（不写安全存储、不写后端
  // SSOT、不写本地 SSOT 缓存/迁移标记）——测试失败的配置永远停留在表单
  // 草稿里，本地「已发布」认知（configPhase）也不因测试而改变。
  const doTestConnection = useCallback(async (
    allowInsecureOverride = allowInsecure,
    acceptPreexistingShortPassword = false,
  ) => {
    if (
      !acceptPreexistingShortPassword
      && isExplicitCloudEncryptionPasswordTooShort(encryptionPassword)
    ) {
      setShortPasswordConfirm({ action: 'test', allowInsecure: allowInsecureOverride });
      return;
    }

    setTesting(true);
    setConnectionStatus('unknown');
    try {
      const config = buildConfig(allowInsecureOverride);
      await cloudApi.testConnectionDraft(config, buildFormCredentials(), {
        encryptionPasswordIsPreexisting: acceptPreexistingShortPassword,
      });
      // 测试成功也仍是「已测试的草稿」：不发布；状态/版本等「已发布」视图
      // 留到发布成功后再刷新，避免草稿结论与已发布数据混在一起。
      setConnectionStatus('connected');
      showGlobalNotification('success', t('cloudStorage:messages.connectionSuccess'));
    } catch (e: unknown) {
      setConnectionStatus('failed');
      // SECURE_STORE_*（后端在测试末尾只读探测 active generation 失败）
      // 优先给可行动提示，其余按稳定 code 本地化。草稿测试不回填凭据。
      const secureMessage = markSecureStoreIssue(e, 'read');
      showGlobalNotification(
        'error',
        `${t('cloudStorage:errors.connectionFailed')}: ${secureMessage ?? localizeCloudError(e)}`,
      );
    } finally {
      setTesting(false);
    }
  }, [
    allowInsecure,
    buildConfig,
    buildFormCredentials,
    encryptionPassword,
    localizeCloudError,
    markSecureStoreIssue,
    t,
  ]);

  // 确认保存不安全 FTP/WebDAV 配置
  const handleConfirmInsecureFtpSave = useCallback(async () => {
    setShowInsecureFtpWarning(false);
    if (insecureWarningAction === 'test') {
      await doTestConnection(true);
    } else {
      await doSaveConfig(true);
    }
    setInsecureWarningAction(null);
  }, [insecureWarningAction, doSaveConfig, doTestConnection]);

  // 确认保存不安全 WebDAV 配置
  const handleConfirmInsecureWebdavSave = useCallback(async () => {
    setShowInsecureWebdavWarning(false);
    if (insecureWarningAction === 'test') {
      await doTestConnection(true);
    } else {
      await doSaveConfig(true);
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
    // cloud_config_ssot_clear only succeeds after backend config and its
    // secure-store credential record are both removed.
    // The local copy is only a UI cache; clear it even when one backend cleanup
    // failed so stale credentials are never reintroduced by the WebView.
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    localStorage.removeItem(cloudApi.CLOUD_STORAGE_LEGACY_STORAGE_KEY);
    localStorage.setItem(cloudApi.CLOUD_STORAGE_SSOT_MIGRATED_STORAGE_KEY, '1');
    // 重置状态
    setOpProgress(null);
    setHasStoredFtpConfig(false);
    setWebdavConfig({ endpoint: '', username: '', password: '' });
    setS3Config({ endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '', region: '', pathStyle: false });
    setFtpConfig({ host: '', port: 21, username: '', password: '', useTls: false, endpoint: '' });
    setRoot('deep-student-sync');
    setAllowInsecure(false);
    setEncryptionPassword('');
    if (!clearFailed) {
      setCredentialStatus({
        webdavPasswordConfigured: false,
        s3SecretAccessKeyConfigured: false,
        ftpPasswordConfigured: false,
        encryptionPasswordConfigured: false,
      });
    }
    setConnectionStatus('unknown');
    setConfigPhase('draft');
    setSyncStatus(null);
    setVersions([]);
    showGlobalNotification(
      clearFailed ? 'error' : 'info',
      t(clearFailed ? 'cloudStorage:messages.configClearPartial' : 'cloudStorage:messages.configCleared'),
    );
    onConfigChanged?.();
  }, [t, onConfigChanged]);

  // 停用端到端加密：走后端显式 API，只删除加密密码、保留传输凭据。
  // 留空保存不是停用（保存的合并语义把空字段视为「保留现有值」），
  // 这里是唯一的停用入口，必须经 danger 确认框确认。
  // 注意：停用只影响本机密码，不会移除云端加密标记——已有标记的根目录
  // 之后的明文上传会被后端拒绝（见 enforce_encryption_policy_before_upload）。
  const disableEncryption = useCallback(async () => {
    try {
      const status = await cloudApi.clearEncryptionPassword();
      setCredentialStatus(status);
      setEncryptionPassword('');
      setShowEncryptionPwd(false);
      setSecureStoreIssue(null);
      showGlobalNotification('info', t('cloudStorage:encryption.disabledNotice'));
      onConfigChanged?.();
    } catch (e: unknown) {
      console.error('Failed to disable end-to-end encryption:', e);
      const secureMessage = markSecureStoreIssue(e, 'write');
      showGlobalNotification(
        'error',
        `${secureMessage ?? t('cloudStorage:encryption.disableFailed')}: ${getErrorMessage(e)}`,
      );
    }
  }, [markSecureStoreIssue, t, onConfigChanged]);

  const shouldShowFtpOption = FTP_STORAGE_EXPERIMENTAL_ENABLED || hasStoredFtpConfig || provider === 'ftp';
  // Android/移动端后端未提供 FTP 支持：复用 S3 禁用卡片模式（可见但不可选）
  const ftpDisabledOnMobile = isMobilePlatform();

  // 测试连接（先检查不安全连接）
  const testConnection = useCallback(async () => {
    const config = buildConfig();
    if (provider === 'ftp' && cloudApi.requiresInsecureTransportOptIn(config)) {
      setInsecureWarningAction('test');
      setShowInsecureFtpWarning(true);
      return;
    }

    if (provider === 'webdav' && cloudApi.requiresInsecureTransportOptIn(config)) {
      setInsecureWarningAction('test');
      setShowInsecureWebdavWarning(true);
      return;
    }

    if (provider === 's3' && cloudApi.isPublicHttpEndpoint(s3Config.endpoint)) {
      showGlobalNotification('error', t('cloudStorage:s3.insecureWarning.description'));
      return;
    }

    await doTestConnection(false);
  }, [provider, s3Config.endpoint, buildConfig, doTestConnection, t]);

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
      if (
        !endpoint
        || !webdavConfig.username.trim()
        || (!webdavConfig.password.trim() && !credentialStatus.webdavPasswordConfigured)
      ) return false;
      // Validate URL format and protocol
      try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
      } catch { return false; }
      return true;
    } else if (provider === 's3') {
      const endpoint = s3Config.endpoint.trim();
      if (
        !endpoint
        || !s3Config.bucket.trim()
        || !s3Config.accessKeyId.trim()
        || (!s3Config.secretAccessKey.trim() && !credentialStatus.s3SecretAccessKeyConfigured)
      ) return false;
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
      if (!endpoint || !username || (!password && !credentialStatus.ftpPasswordConfigured)) return false;
      try {
        const url = new URL(endpoint);
        if (!['ftp:', 'ftps:'].includes(url.protocol)) return false;
      } catch { return false; }
      return true;
    }
  }, [provider, webdavConfig, s3Config, ftpConfig, credentialStatus]);

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
    };
  }, []);

  const waitForGovernanceJob = useCallback(async (
    jobId: string,
    kind: 'export' | 'import',
    inactivityTimeoutMs = 15 * 60 * 1000
  ): Promise<BackupJobSummary> => {
    abortCtrlRef.current?.abort();
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    activeGovernanceJobRef.current = jobId;

    const startedAt = Date.now();
    const hardDeadlineMs = 24 * 60 * 60 * 1000;
    let lastActivityAt = startedAt;
    let lastSignature = '';
    try {
      while (
        Date.now() - lastActivityAt < inactivityTimeoutMs
        && Date.now() - startedAt < hardDeadlineMs
      ) {
        if (ctrl.signal.aborted) {
          throw new Error(`${kind} job polling cancelled (component unmounted)`);
        }

        const job = await DataGovernanceApi.getBackupJob(jobId);
        if (job) {
          const signature = `${job.status}|${job.phase}|${job.progress}|${job.message ?? ''}`;
          if (signature !== lastSignature) {
            lastSignature = signature;
            lastActivityAt = Date.now();
          }
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
        console.warn('[cloud-backup] failed to cancel stalled job:', error);
      });
      throw new Error(
        Date.now() - startedAt >= hardDeadlineMs
          ? `backup job exceeded maximum runtime: ${kind} (24h)`
          : `backup job made no progress: ${kind} (${Math.floor(inactivityTimeoutMs / 1000)}s)`
      );
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

  // 云端整包 ZIP 密码：输入框显式密码优先；否则仅在「已配置」时让后端读安全存储。
  // 导出：后端开关打开却读不到密码时 fail-closed，不会默默打成便携包。
  // 导入：后端只对密封 ZIP 套用 stored；便携包忽略 stored。
  // 不要把 secure store 密码读进 React state。
  const resolveCloudZipEncryptionArgs = useCallback((): {
    encryptionPassword?: string;
    useStoredCloudEncryptionPassword?: boolean;
  } => {
    const explicit = encryptionPassword.trim();
    if (explicit) {
      return { encryptionPassword: explicit };
    }
    if (credentialStatus.encryptionPasswordConfigured) {
      return { useStoredCloudEncryptionPassword: true };
    }
    return {};
  }, [credentialStatus.encryptionPasswordConfigured, encryptionPassword]);

  // 备份并上传到云端
  const handleBackupAndUpload = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      showGlobalNotification('warning', t('cloudStorage:errors.connectionFailed'));
      return;
    }
    if (isExplicitCloudEncryptionPasswordTooShort(encryptionPassword)) {
      showGlobalNotification(
        'error',
        t('cloudStorage:encryption.tooShort', { min: CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS }),
      );
      return;
    }
    setUploading(true);
    enterMaintenanceMode(t('cloudStorage:progress.maintenanceBackup'));
    setOpProgress({ operation: 'upload', stageIndex: 1, stageTotal: 4, stageLabel: t('cloudStorage:progress.backupDatabase'), bytesDone: 0, bytesTotal: 0, isTransferring: false, error: null });
    let uploadedArchiveSlotRestorable = true;
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
        const zipArgs = resolveCloudZipEncryptionArgs();
        const zipExportJob = await DataGovernanceApi.exportZip(
          backupId,
          undefined,
          undefined,
          undefined,
          zipArgs.encryptionPassword,
          zipArgs.useStoredCloudEncryptionPassword,
        );
        const zipExportSummary = await waitForGovernanceJob(zipExportJob.job_id, 'export');
        zipPath = resolveExportZipPath(zipExportSummary) ?? '';
        if (!zipPath) throw new Error('zip export path missing from export result');
        uploadedArchiveSlotRestorable = cloudApi.isImportedArchiveSlotRestorable(
          zipExportSummary.result?.stats,
        );
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.packageZipFailed', { error: localizeCloudError(e) }));
      }

      // 阶段 3/4：上传至云端（字节进度由 Tauri 事件驱动）
      setStage('upload', 3, 4, t('cloudStorage:progress.uploadCloud'));
      let result: cloudApi.UploadResult;
      try {
        const appVersion = await TauriAPI.getAppVersion();
        result = await cloudApi.uploadBackup(
          buildConfig(),
          zipPath,
          appVersion,
          undefined,
          uploadedArchiveSlotRestorable ? 'disaster_recovery' : 'partial_archive',
        );
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.uploadFileFailed', { error: localizeCloudError(e) }));
      }

      // 阶段 4/4：刷新状态
      setStage('upload', 4, 4, t('cloudStorage:progress.refreshStatus'));
      await refreshStatus();

      setOpProgress(null);
      showGlobalNotification('success', t('cloudStorage:upload.successDetail', { version: result.version.id }));
      if (!uploadedArchiveSlotRestorable) {
        showGlobalNotification('warning', t('cloudStorage:upload.portableArchiveUploaded'));
      }
      if (result.prunedVersions.length > 0) {
        showGlobalNotification('info', t('cloudStorage:upload.pruned', { count: result.prunedVersions.length }));
      }
    } catch (e: unknown) {
      const msg = getErrorMessage(e);
      setOpProgress(prev => prev ? { ...prev, error: msg } : null);
      showGlobalNotification('error', msg);
    } finally {
      exitMaintenanceMode();
      setUploading(false);
    }
  }, [
    buildConfig,
    connectionStatus,
    encryptionPassword,
    enterMaintenanceMode,
    exitMaintenanceMode,
    localizeCloudError,
    refreshStatus,
    resolveBackupId,
    resolveCloudZipEncryptionArgs,
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
    const version = cloudApi.findCloudBackupVersion(
      versionId,
      versions,
      syncStatus?.latestVersion,
    );
    if (cloudApi.isKnownPortableCloudBackup(version)) {
      showGlobalNotification('warning', t('cloudStorage:history.portableArchiveNotRestorable'));
      return;
    }
    setPendingRestoreVersionId(versionId);
    setRestoreConfirmOpen(true);
  }, [connectionStatus, syncStatus?.latestVersion, t, versions]);

  // 失败重试上下文：记录最近一次恢复的版本号，供进度面板「重试」使用
  const lastRestoreVersionIdRef = useRef<string | null>(null);

  // 从云端恢复（核心执行逻辑，确认框与重试按钮共用）
  //
  // 恢复是对既有密文的解密，故意不做口令最小长度校验：v0.9.44 允许任意
  // 长度口令，换机/重装用户重输的存量短口令必须能进入解密流程；口令错误
  // 由解封层 fail-closed（E_BACKUP_SEALED_DECRYPT_FAILED）。
  const performRestore = useCallback(async (versionId: string) => {
    const knownVersion = cloudApi.findCloudBackupVersion(
      versionId,
      versions,
      syncStatus?.latestVersion,
    );
    if (cloudApi.isKnownPortableCloudBackup(knownVersion)) {
      showGlobalNotification('warning', t('cloudStorage:history.portableArchiveNotRestorable'));
      return;
    }
    lastRestoreVersionIdRef.current = versionId;
    setDownloading(true);
    enterMaintenanceMode(t('cloudStorage:progress.maintenanceRestore'));
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
        throw new Error(t('cloudStorage:errors.downloadBackupFailed', { error: localizeCloudError(e) }));
      }

      // 阶段 2/3：导入 ZIP
      setStage('download', 2, 3, t('cloudStorage:progress.importZip'));
      let importedBackupId: string;
      let importSummary: BackupJobSummary;
      try {
        // cloud_sync_download has already rebuilt secrets from secure-store SSOT and
        // used that password to decrypt the outer DSBK object. Never forward the
        // still-populated React input as an explicit inner-ZIP password here:
        // v0.9.44 cloud backups decrypt to a legacy ZIP without
        // portable_secrets.dsbk, and that ZIP correctly rejects an explicit
        // password as inapplicable. Requesting the stored password lets the backend
        // apply it only when an 0824 full-fidelity ZIP actually has a sealed inner
        // payload; legacy ZIPs ignore it.
        const importJob = await DataGovernanceApi.importZip(
          downloadResult.localPath,
          undefined,
          undefined,
          credentialStatus.encryptionPasswordConfigured || undefined,
        );
        importSummary = await waitForGovernanceJob(importJob.job_id, 'import');
        importedBackupId = resolveBackupId(importSummary) ?? '';
        if (!importedBackupId) throw new Error('backup_id missing from import result');
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.importZipFailed', { error: localizeCloudError(e) }));
      }

      // 导入已写 recovery_kind / restorable：便携/部分归档不要再启动整槽恢复。
      // stats 缺失（旧后端）仍走 restore 门，由 E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE 兜底。
      if (!cloudApi.isImportedArchiveSlotRestorable(importSummary.result?.stats)) {
        throw new Error(
          t('cloudStorage:errors.restoreDatabaseFailed', {
            error: localizeCloudError({
              code: cloudApi.PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE,
              message: `[${cloudApi.PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE}] portable or partial archive`,
            }),
          }),
        );
      }

      // 整槽恢复前先看磁盘：与 Dashboard / 本地 ZIP 同一条预检，失败 fail-closed。
      let spaceCheck: Awaited<ReturnType<typeof DataGovernanceApi.checkDiskSpaceForRestore>>;
      try {
        spaceCheck = await DataGovernanceApi.checkDiskSpaceForRestore(importedBackupId);
      } catch (e: unknown) {
        throw new Error(
          t('cloudStorage:errors.restoreDatabaseFailed', { error: localizeCloudError(e) }),
        );
      }
      if (!spaceCheck.has_enough_space) {
        throw new Error(
          t('cloudStorage:errors.restoreInsufficientSpace', {
            required: (spaceCheck.required_bytes / 1024 / 1024 / 1024).toFixed(2),
            available: (spaceCheck.available_bytes / 1024 / 1024 / 1024).toFixed(2),
          }),
        );
      }

      // 阶段 3/3：恢复数据库
      setStage('download', 3, 3, t('cloudStorage:progress.restoreDatabase'));
      try {
        const restoreJob = await DataGovernanceApi.restoreBackup(importedBackupId);
        await waitForGovernanceJob(restoreJob.job_id, 'import');
      } catch (e: unknown) {
        throw new Error(t('cloudStorage:errors.restoreDatabaseFailed', { error: localizeCloudError(e) }));
      }

      setOpProgress(null);
      showGlobalNotification('success', t('cloudStorage:download.successRestart'));
      // The restored slot is pending activation. Continuing to edit the old
      // slot can create writes that disappear at the next launch, so cut over
      // immediately after a verified restore.
      requireMaintenanceRestart(t('cloudStorage:progress.maintenanceRestore'));
      await TauriAPI.restartApp();
      if (import.meta.env.DEV) {
        window.location.reload();
      }
    } catch (e: unknown) {
      const msg = getErrorMessage(e);
      setOpProgress(prev => prev ? { ...prev, error: msg } : null);
      showGlobalNotification('error', msg);
    } finally {
      // 切槽成功后 store 会因 requireMaintenanceRestart 拒绝撤掉写屏障。
      exitMaintenanceMode();
      setDownloading(false);
      setRestoreVersionId(null);
      setPendingRestoreVersionId(null);
    }
  }, [
    buildConfig,
    credentialStatus.encryptionPasswordConfigured,
    enterMaintenanceMode,
    exitMaintenanceMode,
    localizeCloudError,
    requireMaintenanceRestart,
    resolveBackupId,
    setStage,
    syncStatus?.latestVersion,
    t,
    versions,
    waitForGovernanceJob,
  ]);

  // 恢复确认框的确认回调
  const handleRestore = useCallback(async () => {
    const versionId = pendingRestoreVersionId;
    if (!versionId) return;
    const version = cloudApi.findCloudBackupVersion(
      versionId,
      versions,
      syncStatus?.latestVersion,
    );
    if (cloudApi.isKnownPortableCloudBackup(version)) {
      showGlobalNotification('warning', t('cloudStorage:history.portableArchiveNotRestorable'));
      setRestoreConfirmOpen(false);
      setPendingRestoreVersionId(null);
      return;
    }
    setRestoreConfirmOpen(false);
    await performRestore(versionId);
  }, [pendingRestoreVersionId, performRestore, syncStatus?.latestVersion, t, versions]);

  // 上传/下载失败后的重试：按失败操作类型重新触发完整流程
  const retryFailedOperation = useCallback(() => {
    if (!opProgress?.error) return;
    if (opProgress.operation === 'upload') {
      setOpProgress(null);
      void handleBackupAndUpload();
      return;
    }
    const versionId = lastRestoreVersionIdRef.current;
    if (!versionId) {
      setOpProgress(null);
      return;
    }
    setOpProgress(null);
    void performRestore(versionId);
  }, [opProgress, handleBackupAndUpload, performRestore]);

  // [R11-check] 执行云端仓库巡检（只读，不写入/删除任何云端对象）
  const handleRepoCheck = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      showGlobalNotification('warning', t('cloudStorage:errors.connectionFailed'));
      return;
    }
    setRepoChecking(true);
    setRepoCheckError(null);
    try {
      const report = await runCloudRepoCheck(buildConfig());
      setRepoCheckReport(report);
    } catch (e: unknown) {
      setRepoCheckReport(null);
      setRepoCheckError(localizeCloudError(e));
    } finally {
      setRepoChecking(false);
    }
  }, [buildConfig, connectionStatus, localizeCloudError, t]);

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
      showGlobalNotification('error', `${t('cloudStorage:errors.deleteFailed')}: ${localizeCloudError(e)}`);
    } finally {
      setPendingDeleteVersionId(null);
    }
  }, [buildConfig, localizeCloudError, pendingDeleteVersionId, refreshStatus, t]);

  const persistedInsecureRisk =
    allowInsecure && cloudApi.requiresInsecureTransportOptIn(buildConfig());
  const persistedInsecureRiskMessage =
    provider === 'ftp'
      ? t('cloudStorage:ftp.insecureWarning.description')
      : t('cloudStorage:webdav.insecureWarning.description');

  // 主要内容
  const content = (
    <div className={isDialog ? 'space-y-4' : 'space-y-6'}>
      {secureStoreIssue && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
        >
          <WarningCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium">{t('cloudStorage:messages.secureStoreIssueTitle')}</p>
            <p className="mt-0.5 text-xs leading-relaxed">{secureStoreIssue}</p>
          </div>
        </div>
      )}
      {persistedInsecureRisk && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <WarningCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
          <p className="leading-relaxed">{persistedInsecureRiskMessage}</p>
        </div>
      )}

      {/* 存储类型选择 - 卡片式单选（<sm 上下堆叠，400px 双列卡片文案过挤） */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DsButton
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
        </DsButton>
        <DsButton
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
        </DsButton>
        {shouldShowFtpOption && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => !ftpDisabledOnMobile && setProvider('ftp')}
            disabled={ftpDisabledOnMobile}
            className={`relative !h-auto !justify-start flex-col items-start gap-1 !rounded-lg border-2 !p-3 text-left ${
              ftpDisabledOnMobile
                ? 'opacity-50 border-border'
                : provider === 'ftp'
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-transparent hover:bg-[var(--interactive-hover)]'
            }`}
          >
            {provider === 'ftp' && !ftpDisabledOnMobile && (
              <div className="absolute right-2 top-2">
                <CheckCircle size={16} className="text-primary" />
              </div>
            )}
            <span className={`font-medium ${ftpDisabledOnMobile ? 'line-through' : ''}`}>
              {t('cloudStorage:provider.ftp')}
            </span>
            <span className={`text-xs line-clamp-2 whitespace-normal ${
              ftpDisabledOnMobile ? 'text-destructive/70' : 'text-warning'
            }`}>
              {ftpDisabledOnMobile
                ? t('cloudStorage:provider.ftpDisabledMobile')
                : t('cloudStorage:provider.ftpDescExperimental')}
            </span>
          </DsButton>
        )}
      </div>

      <Tabs
        value={provider}
        onValueChange={(v) => {
          if (v === 'ftp' && ftpDisabledOnMobile) return;
          setProvider(v as cloudApi.StorageProvider);
        }}
      >
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
                {/* flex-col 保持标题/提示纵排；coarse min-h-11 扩大开关联动标签的触达高度 */}
                <Label htmlFor="s3-path-style" className="ml-2 flex flex-col justify-center [@media(pointer:coarse)]:min-h-11">
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
        <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <WarningCircle size={16} className="text-warning shrink-0" />
            <Label htmlFor="cloud-encryption-password" className="font-medium">
              {t('cloudStorage:encryption.title')}
            </Label>
            {/* 加密状态徽标：来自后端安全存储的 presence 标记，非本地输入框状态 */}
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
                credentialStatus.encryptionPasswordConfigured
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-border bg-muted/40 text-muted-foreground'
              }`}
            >
              {credentialStatus.encryptionPasswordConfigured ? (
                <CheckCircle size={12} aria-hidden />
              ) : (
                <XCircle size={12} aria-hidden />
              )}
              {credentialStatus.encryptionPasswordConfigured
                ? t('cloudStorage:encryption.statusConfigured')
                : t('cloudStorage:encryption.statusNotConfigured')}
            </span>
          </div>
          <ApiKeyField
            id="cloud-encryption-password"
            placeholder={
              credentialStatus.encryptionPasswordConfigured
                ? t('cloudStorage:encryption.placeholderConfigured')
                : t('cloudStorage:encryption.placeholderUnset')
            }
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
          {/* 停用是显式操作：留空保存只会保留现有密码，绝不会静默停用加密 */}
          {credentialStatus.encryptionPasswordConfigured && (
            <DsButton
              size="sm"
              variant="outline"
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={() => setDisableEncryptionConfirmOpen(true)}
            >
              {t('cloudStorage:encryption.disableAction')}
            </DsButton>
          )}
        </div>

        {/* 三态状态徽标：未测试的草稿 / 测试中 / 已发布。草稿测试成功也只是
            「已测试的草稿」，点「保存配置」发布之前不会改变已发布配置。 */}
        {(testing || configPhase === 'published' || isConfigValid()) && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="cloud-config-phase">
            {testing ? (
              <>
                <CircleNotch size={14} className="animate-spin" />
                <span>{t('cloudStorage:phase.testing')}</span>
              </>
            ) : configPhase === 'published' ? (
              <>
                <ShieldCheck size={14} className="text-success" />
                <span>{t('cloudStorage:phase.published')}</span>
              </>
            ) : connectionStatus === 'connected' ? (
              <>
                <CheckCircle size={14} className="text-warning" />
                <span>{t('cloudStorage:phase.draftTested')}</span>
              </>
            ) : connectionStatus === 'failed' ? (
              <>
                <XCircle size={14} className="text-destructive" />
                <span>{t('cloudStorage:phase.draftTestFailed')}</span>
              </>
            ) : (
              <>
                <WarningCircle size={14} className="text-warning" />
                <span>{t('cloudStorage:phase.draftUntested')}</span>
              </>
            )}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex flex-wrap gap-2">
          <DsButton
            variant="outline"
            className="[@media(pointer:coarse)]:!min-h-11"
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
                {connectionStatus === 'connected' && <CheckCircle size={16} className="mr-2 text-success" />}
                {connectionStatus === 'failed' && <XCircle size={16} className="mr-2 text-destructive" />}
                {t('cloudStorage:actions.testConnection')}
              </>
            )}
          </DsButton>
          <DsButton
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={saveConfig}
            disabled={!isConfigValid()}
          >
            {t('cloudStorage:actions.save')}
          </DsButton>
          <DsButton
            variant="danger"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => setClearConfirmOpen(true)}
          >
            {t('cloudStorage:actions.clearConfig')}
          </DsButton>
        </div>

        {/* 同步状态 */}
        {syncStatus && (
          <div className="border rounded-lg p-4 space-y-3">
            <h4 className="font-medium flex items-center gap-2">
              {syncStatus.connected ? (
                <CheckCircle size={16} className="text-success" />
              ) : (
                <XCircle size={16} className="text-destructive" />
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
                <div className="col-span-2 space-y-2">
                  <div>
                    <span className="text-muted-foreground">{t('cloudStorage:status.latestVersion')}:</span>
                    <span className="ml-2 font-medium">
                      {syncStatus.latestVersion.id} ({cloudApi.formatFileSize(syncStatus.latestVersion.size)})
                      {syncStatus.latestVersion.recoveryKind === 'partial_archive'
                        ? ` · ${t('cloudStorage:history.portableArchive')}`
                        : syncStatus.latestVersion.recoveryKind === 'disaster_recovery'
                          ? ` · ${t('cloudStorage:history.fullFidelity')}`
                          : null}
                    </span>
                  </div>
                  <DsButton
                    size="sm"
                    variant="outline"
                    disabled={
                      downloading
                      || syncStatus.latestVersion.recoveryKind === 'partial_archive'
                    }
                    title={
                      syncStatus.latestVersion.recoveryKind === 'partial_archive'
                        ? t('cloudStorage:history.portableArchiveNotRestorable')
                        : t('cloudStorage:actions.downloadLatest')
                    }
                    onClick={() => openRestoreConfirm(syncStatus.latestVersion!.id)}
                  >
                    {t('cloudStorage:actions.downloadLatest')}
                  </DsButton>
                </div>
              )}
            </div>

            {/* [P11] 本机加密目录记忆写入失败：第二道明文防线降级，必须可见 */}
            {syncStatus.encryptionMemoryPersistFailure && (
              <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-sm">
                <WarningCircle size={16} className="mt-0.5 shrink-0 text-warning" />
                <span>
                  {t('cloudStorage:status.encryptionMemoryPersistFailed')}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({syncStatus.encryptionMemoryPersistFailure.code})
                  </span>
                </span>
              </div>
            )}

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
                  <div className="flex gap-2">
                    <DsButton
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs [@media(pointer:coarse)]:!min-h-11"
                      disabled={uploading || downloading}
                      onClick={retryFailedOperation}
                    >
                      {t('common:actions.retry')}
                    </DsButton>
                    <DsButton
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-muted-foreground [@media(pointer:coarse)]:!min-h-11"
                      onClick={() => setOpProgress(null)}
                    >
                      {t('common:actions.close')}
                    </DsButton>
                  </div>
                )}
              </div>
            )}

            {/* 快捷操作 */}
            <div className="flex flex-wrap gap-2 pt-2">
              <DsButton
                size="sm"
                className="[@media(pointer:coarse)]:!min-h-11"
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
              </DsButton>
              <DsButton
                size="sm"
                variant="outline"
                className="[@media(pointer:coarse)]:!min-h-11"
                onClick={() => setShowHistory(!showHistory)}
              >
                <ClockCounterClockwise size={16} className="mr-2" />
                {t('cloudStorage:actions.viewHistory')}
              </DsButton>
            </div>
            <p className="text-xs text-muted-foreground pt-1">
              {t('cloudStorage:actions.fullZipHint')}
            </p>
          </div>
        )}

        {/* 版本历史 */}
        {showHistory && (
          <div className="border rounded-lg p-4 space-y-3">
            <h4 className="font-medium">{t('cloudStorage:history.title')}</h4>
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('cloudStorage:history.empty')}</p>
            ) : (
              <CustomScrollArea className="h-64" viewportClassName="pr-1">
                <div className="space-y-2">
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
                        {version.recoveryKind === 'partial_archive'
                          ? ` • ${t('cloudStorage:history.portableArchive')}`
                          : version.recoveryKind === 'disaster_recovery'
                            ? ` • ${t('cloudStorage:history.fullFidelity')}`
                            : null}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <DsButton
                        size="sm"
                        variant="ghost"
                        className="[@media(pointer:coarse)]:!min-h-11"
                        title={
                          version.recoveryKind === 'partial_archive'
                            ? t('cloudStorage:history.portableArchiveNotRestorable')
                            : t('cloudStorage:history.restore')
                        }
                        disabled={downloading || version.recoveryKind === 'partial_archive'}
                        onClick={() => openRestoreConfirm(version.id)}
                      >
                        {downloading && restoreVersionId === version.id ? (
                          <CircleNotch size={16} className="animate-spin" />
                        ) : (
                          <Download size={16} />
                        )}
                      </DsButton>
                      {currentDeviceId === version.deviceId && (
                        isSmallScreen && confirmingDeleteVersionId === version.id ? (
                        // P2-12 移动端两段式行内确认：再点一次执行删除
                        <DsButton
                          size="sm"
                          variant="danger"
                          className="whitespace-nowrap [@media(pointer:coarse)]:!min-h-11"
                          onClick={() => {
                            setConfirmingDeleteVersionId(null);
                            void handleDeleteVersion();
                          }}
                        >
                          <Trash size={14} />
                          {t('common:actions.confirm_delete')}
                        </DsButton>
                      ) : (
                        <DsButton
                          size="sm"
                          variant="ghost"
                          className="[@media(pointer:coarse)]:!min-h-11"
                          title={t('cloudStorage:history.delete')}
                          aria-label={t('cloudStorage:history.delete')}
                          onClick={() => {
                            if (isSmallScreen) {
                              setPendingDeleteVersionId(version.id);
                              setConfirmingDeleteVersionId(version.id);
                              return;
                            }
                            openDeleteConfirm(version.id);
                          }}
                        >
                          <Trash size={16} className="text-destructive" />
                        </DsButton>
                        )
                      )}
                    </div>
                  </div>
                  ))}
                </div>
              </CustomScrollArea>
            )}
          </div>
        )}

        {/* [R11-check] 云端仓库巡检：独立入口区（restic `check` 档，只读不修） */}
        {syncStatus && (
          <div className="border rounded-lg p-4 space-y-3">
            <h4 className="font-medium flex items-center gap-2">
              <ShieldCheck size={16} />
              {t('cloudStorage:repoCheck.title')}
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('cloudStorage:repoCheck.description')}
            </p>
            <DsButton
              size="sm"
              variant="outline"
              disabled={repoChecking || uploading || downloading || connectionStatus !== 'connected'}
              onClick={() => void handleRepoCheck()}
            >
              {repoChecking ? (
                <>
                  <CircleNotch size={16} className="mr-2 animate-spin" />
                  {t('cloudStorage:repoCheck.running')}
                </>
              ) : (
                <>
                  <ShieldCheck size={16} className="mr-2" />
                  {t('cloudStorage:repoCheck.run')}
                </>
              )}
            </DsButton>

            {repoCheckError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                <WarningCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <p className="min-w-0 leading-relaxed break-words">
                  {t('cloudStorage:repoCheck.failed')}: {repoCheckError}
                </p>
              </div>
            )}

            {repoCheckReport && (
              <div className="space-y-3 text-sm">
                {/* 结论徽标：全绿 / 有问题 / 不完整（截断时绝不显示全绿） */}
                {repoCheckReport.status === 'ok' && (
                  <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-success">
                    <CheckCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
                    <p className="font-medium">{t('cloudStorage:repoCheck.statusOk')}</p>
                  </div>
                )}
                {repoCheckReport.status === 'problemsFound' && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-destructive">
                    <XCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
                    <p className="font-medium">
                      {t('cloudStorage:repoCheck.statusProblems', { count: repoCheckReport.problems.length })}
                    </p>
                  </div>
                )}
                {repoCheckReport.status === 'incomplete' && (
                  <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-warning">
                    <WarningCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
                    <p className="font-medium">{t('cloudStorage:repoCheck.statusIncomplete')}</p>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  {t('cloudStorage:repoCheck.summary', {
                    versions: repoCheckReport.versionsReferenced,
                    objects: repoCheckReport.objectsChecked,
                    bytes: cloudApi.formatFileSize(repoCheckReport.bytesVerified),
                  })}
                  {' • '}
                  {t('cloudStorage:repoCheck.checkedAt')}: {cloudApi.formatTimestamp(repoCheckReport.checkedAt)}
                </p>
                {repoCheckReport.encryptionMarkerPresent && (
                  <p className="text-xs text-muted-foreground">{t('cloudStorage:repoCheck.encryptedRepo')}</p>
                )}
                {repoCheckReport.listingTruncated && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                    {t('cloudStorage:repoCheck.truncatedNotice')}
                  </div>
                )}
                {repoCheckReport.orphanObjects > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('cloudStorage:repoCheck.orphanCount', { count: repoCheckReport.orphanObjects })}
                  </p>
                )}

                {/* 问题清单 */}
                {repoCheckReport.problems.length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-sm font-medium">{t('cloudStorage:repoCheck.problemsTitle')}</h5>
                    {repoCheckReport.problemsTruncated && (
                      <p className="text-xs text-muted-foreground">
                        {t('cloudStorage:repoCheck.problemsTruncated', { count: repoCheckReport.problems.length })}
                      </p>
                    )}
                    <CustomScrollArea className="max-h-64" viewportClassName="pr-1">
                      <div className="space-y-2">
                        {repoCheckReport.problems.map((problem, index) => (
                          <div
                            key={`${problem.kind}-${problem.objectKey ?? ''}-${index}`}
                            className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs"
                          >
                            <div className="font-medium text-destructive">
                              {t(`cloudStorage:repoCheck.problemKind.${problem.kind}`, {
                                defaultValue: problem.kind,
                              })}
                              {problem.versionId && (
                                <span className="ml-1 font-normal text-muted-foreground">
                                  ({problem.versionId})
                                </span>
                              )}
                            </div>
                            {problem.objectKey && (
                              <div className="mt-0.5 break-all font-mono text-muted-foreground">
                                {problem.objectKey}
                              </div>
                            )}
                            <div className="mt-0.5 leading-relaxed text-muted-foreground">{problem.detail}</div>
                          </div>
                        ))}
                      </div>
                    </CustomScrollArea>
                  </div>
                )}

                {/* 人话处置指引：发现坏对象后该做什么 */}
                {repoCheckReport.status !== 'ok' && (
                  <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
                    <h5 className="text-sm font-medium">{t('cloudStorage:repoCheck.guidance.title')}</h5>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('cloudStorage:repoCheck.guidance.readOnly')}
                    </p>
                    {repoCheckReport.problems.some((p) => BAD_OBJECT_KINDS.has(p.kind)) && (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('cloudStorage:repoCheck.guidance.badObject')}
                      </p>
                    )}
                    {repoCheckReport.orphanObjects > 0 && (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('cloudStorage:repoCheck.guidance.orphan')}
                      </p>
                    )}
                    {repoCheckReport.problems.some((p) => MANIFEST_KINDS.has(p.kind)) && (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('cloudStorage:repoCheck.guidance.manifest')}
                      </p>
                    )}
                    {(repoCheckReport.listingTruncated
                      || repoCheckReport.problems.some((p) => p.kind === 'objectReadFailed')) && (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('cloudStorage:repoCheck.guidance.incomplete')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
    </div>
  );

  const pendingRestoreVersion = cloudApi.findCloudBackupVersion(
    pendingRestoreVersionId,
    versions,
    syncStatus?.latestVersion,
  );

  // 恢复确认对话框
  const restoreConfirmDialog = (
    <DsAlertDialog
      open={restoreConfirmOpen}
      onOpenChange={setRestoreConfirmOpen}
      title={t('cloudStorage:download.confirmTitle')}
      description={t('cloudStorage:download.warningDetail')}
      confirmText={t('cloudStorage:download.confirm')}
      cancelText={t('cloudStorage:download.cancel')}
      confirmVariant="warning"
      disabled={cloudApi.isKnownPortableCloudBackup(pendingRestoreVersion)}
      onConfirm={handleRestore}
    >
      {pendingRestoreVersionId && (
        <p className="text-sm font-medium">
          {t('cloudStorage:download.confirmVersion', { version: pendingRestoreVersionId })}
        </p>
      )}
      {pendingRestoreVersion?.recoveryKind === 'partial_archive' ? (
        <p className="mt-1 text-sm text-destructive">
          {t('cloudStorage:download.confirmKnownPortable')}
        </p>
      ) : pendingRestoreVersion?.recoveryKind === 'disaster_recovery' ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {t('cloudStorage:download.confirmKnownFull')}
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          {t('cloudStorage:download.confirmUnknownKind')}
        </p>
      )}
      <p className="mt-1 text-sm font-medium text-destructive">{t('cloudStorage:download.warning')}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t('cloudStorage:download.partialArchiveNotice')}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t('cloudStorage:download.restartNotice')}</p>
    </DsAlertDialog>
  );

  // 清除配置确认对话框（danger：涉及凭据与加密密码删除，必须显式确认）
  const clearConfirmDialog = (
    <DsAlertDialog
      open={clearConfirmOpen}
      onOpenChange={setClearConfirmOpen}
      title={t('cloudStorage:clearConfirm.title')}
      description={t('cloudStorage:clearConfirm.description')}
      confirmText={t('cloudStorage:clearConfirm.confirm')}
      cancelText={t('common:actions.cancel')}
      confirmVariant="danger"
      onConfirm={() => {
        setClearConfirmOpen(false);
        void clearConfig();
      }}
    >
      <p className="text-sm font-medium text-destructive">
        {t('cloudStorage:clearConfirm.encryptionWarning')}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('cloudStorage:clearConfirm.cloudFilesKept')}
      </p>
    </DsAlertDialog>
  );

  // 停用端到端加密确认对话框（danger：删除本机加密密码，未另存则已加密备份永久不可解密）。
  // [R06-e2ee-copy] 第二段说明与后端 R02 上传策略一致：已写入加密标记
  // （.encryption-marker）的云端根目录会拒绝明文上传，而不是静默降级为明文；
  // 用户需重新填写原密码或更换云端根目录才能继续备份。
  const disableEncryptionConfirmDialog = (
    <DsAlertDialog
      open={disableEncryptionConfirmOpen}
      onOpenChange={setDisableEncryptionConfirmOpen}
      title={t('cloudStorage:encryption.disableConfirm.title')}
      description={t('cloudStorage:encryption.disableConfirm.description')}
      confirmText={t('cloudStorage:encryption.disableConfirm.confirm')}
      cancelText={t('common:actions.cancel')}
      confirmVariant="danger"
      onConfirm={() => {
        setDisableEncryptionConfirmOpen(false);
        void disableEncryption();
      }}
    >
      <p className="text-sm font-medium text-destructive">
        {t('cloudStorage:encryption.disableConfirm.existingBackupsWarning')}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('cloudStorage:encryption.disableConfirm.futureUploadsPlaintext')}
      </p>
    </DsAlertDialog>
  );

  // 删除确认对话框
  const deleteConfirmDialog = (
    <DsAlertDialog
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
    <DsAlertDialog
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
    <DsAlertDialog
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

  // 短口令确认对话框：新设口令要求 8 字符起；确认「这是旧口令」则按存量
  // 口令保存（v0.9.44 无长度限制，解密既有备份不受长度约束）。
  const shortPasswordConfirmDialog = (
    <DsAlertDialog
      open={shortPasswordConfirm !== null}
      onOpenChange={(open) => { if (!open) setShortPasswordConfirm(null); }}
      title={t('cloudStorage:encryption.preexistingShortConfirm.title', {
        min: CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS,
      })}
      description={t('cloudStorage:encryption.preexistingShortConfirm.description', {
        min: CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS,
      })}
      confirmText={t('cloudStorage:encryption.preexistingShortConfirm.confirm')}
      cancelText={t('common:actions.cancel')}
      confirmVariant="warning"
      onConfirm={() => {
        const pending = shortPasswordConfirm;
        setShortPasswordConfirm(null);
        if (!pending) return;
        if (pending.action === 'save') {
          void doSaveConfig(pending.allowInsecure, true);
        } else {
          void doTestConnection(pending.allowInsecure, true);
        }
      }}
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
        {clearConfirmDialog}
        {disableEncryptionConfirmDialog}
        {insecureFtpWarningDialog}
        {insecureWebdavWarningDialog}
        {shortPasswordConfirmDialog}
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
      {clearConfirmDialog}
      {disableEncryptionConfirmDialog}
      {insecureFtpWarningDialog}
      {insecureWebdavWarningDialog}
      {shortPasswordConfirmDialog}
    </>
  );
};

export default CloudStorageSection;
