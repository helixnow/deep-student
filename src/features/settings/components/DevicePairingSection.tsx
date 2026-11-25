import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  QrCode,
  Camera,
  ImageSquare,
  Copy,
  DownloadSimple,
  Shuffle,
  CheckCircle,
  WarningCircle,
  Upload,
  Download,
  EyeSlash,
  StopCircle,
  Sparkle,
  Key,
  CloudArrowUp,
  CircleNotch,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import { SettingsGroup, SwitchRow } from './settingsTabPrimitives';
import {
  QrCodeSvg,
  renderQrCodeSvgString,
} from '../utils/qrCodeSvg';
import {
  applyPairingCode,
  createPairingCode,
  type PairingSettings as PairingSettingsStore,
  type PairingSummary as Summary,
} from '../../../../host/plugins/sync/src/device-pairing';

const PAIRING_CODE_EXPIRED_TOKEN = 'E_PAIRING_CODE_EXPIRED';

import { decodePairingFrame, decodePairingImage } from '../utils/decodePairingQr';
import * as cloudApi from '@/utils/cloudStorageApi';
import { useGlobalSyncStore } from '@/stores/syncStatusStore';
import {
  isEnglishUiLanguage,
  localizeBackendErrorText,
} from './data-governance/localizeCloudError';
import { probeStoredCloudConfigured } from './QuickSyncNowButton';

export const ipcPairingSettings: PairingSettingsStore = {
  get: async (key) => {
    const direct = await invoke<string | null>('get_setting', { key });
    if (direct !== null && direct !== undefined && direct !== '') {
      return direct;
    }
    if (key === 'cloud_storage.config.safe_v1') {
      try {
        const resolved =
          (await cloudApi.resolveCloudStorageConfig()) ??
          cloudApi.loadStoredCloudStorageConfigSafe();
        if (resolved) {
          return JSON.stringify(cloudApi.toSafeCloudStorageConfig(resolved));
        }
      } catch {
        // Ignore fallback failure in isolated unit-test environments
      }
    }
    return direct;
  },
  save: async (key, value) => {
    await invoke('save_setting', { key, value });
    if (key === 'cloud_storage.config.safe_v1') {
      try {
        await invoke('cloud_config_ssot_save', { config: JSON.parse(value) });
      } catch {
        // Fallback for unit-test invoke mocks without cloud_config_ssot_save
      }
    }
  },
  getSecret: async (key) => {
    if (key === 'cloud_storage_credentials') {
      try {
        const creds = await invoke<string | Record<string, unknown> | null>(
          'data_governance_pairing_get_cloud_credentials',
        );
        if (typeof creds === 'string') {
          return creds.trim() ? creds : null;
        }
        if (creds && typeof creds === 'object' && !Array.isArray(creds)) {
          return Object.keys(creds).length > 0 ? JSON.stringify(creds) : null;
        }
        // Authoritative <appDataDir>/.secure/ explicitly returned null: do not resurrect
        // stale/deleted passwords from slot-scoped `get_setting('cloud_storage_credentials')`.
        if (creds === null) {
          return null;
        }
      } catch {
        // Fallback only when pairing credential IPC is unavailable (e.g. legacy test mocks)
      }
    }
    return invoke<string | null>('get_setting', { key });
  },
  saveSecret: async (key, value) => {
    if (key === 'cloud_storage_credentials') {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const credentials = {
        ...(typeof parsed.webdavPassword === 'string' && parsed.webdavPassword.trim() ? { webdavPassword: parsed.webdavPassword } : {}),
        ...(typeof parsed.s3SecretAccessKey === 'string' && parsed.s3SecretAccessKey.trim() ? { s3SecretAccessKey: parsed.s3SecretAccessKey } : {}),
        ...(typeof parsed.ftpPassword === 'string' && parsed.ftpPassword.trim() ? { ftpPassword: parsed.ftpPassword } : {}),
        ...(typeof parsed.encryptionPassword === 'string' && parsed.encryptionPassword.trim() ? { encryptionPassword: parsed.encryptionPassword } : {}),
      };
      let savedAuthoritatively = false;
      try {
        const saved = await invoke<boolean>('data_governance_pairing_save_cloud_credentials', {
          credentials: Object.keys(credentials).length > 0 ? credentials : null,
        });
        if (saved === true) {
          savedAuthoritatively = true;
        }
      } catch {
        // Fall through to legacy secure credential command
      }
      if (!savedAuthoritatively) {
        try {
          if (Object.keys(credentials).length > 0) {
            const res = await invoke('secure_save_cloud_credentials', {
              credentials,
              encryptionPasswordIsPreexisting: true,
            });
            if (res !== undefined) savedAuthoritatively = true;
          } else {
            const res = await invoke('secure_delete_cloud_credentials');
            if (res !== undefined) savedAuthoritatively = true;
          }
        } catch {
          // Fallback for isolated unit-test invoke mocks without secure credential commands
        }
      }
      if (savedAuthoritatively) {
        try {
          await invoke('delete_setting', { key: 'cloud_storage_credentials' });
        } catch {
          // Best-effort cleanup of legacy slot-scoped mirror
        }
        return;
      }
    }
    await invoke('save_setting', { key, value });
  },
  listByPrefix: async (prefix) => {
    const rows = await invoke<
      Array<[string, string] | { key: string; value: string; updatedAt?: string }>
    >('get_settings_by_prefix', { prefix });
    return (rows ?? []).map((row) =>
      Array.isArray(row)
        ? { key: row[0], value: row[1], updatedAt: '' }
        : { key: row.key, value: row.value, updatedAt: row.updatedAt ?? '' },
    );
  },
};

function describeSummary(
  summary: Summary,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const notIncluded = t('sync:pairing.summaryNotIncluded', { defaultValue: '未包含' });
  const syncLabel = t('sync:pairing.summarySync', { defaultValue: '同步' });
  const noSyncLabel = t('sync:pairing.summaryNoSync', { defaultValue: '不同步' });
  const skillsLabel =
    summary.includeSkills === null ? notIncluded : summary.includeSkills ? syncLabel : noSyncLabel;
  const pluginsLabel =
    summary.includePlugins === null ? notIncluded : summary.includePlugins ? syncLabel : noSyncLabel;
  return t('sync:pairing.summaryFormat', {
    cloud: summary.cloudProvider ?? notIncluded,
    llmProviders: summary.llmProviders,
    skills: skillsLabel,
    plugins: pluginsLabel,
    defaultValue: `云存储：${summary.cloudProvider ?? notIncluded} · AI 供应商：${summary.llmProviders} 个 · 技能：${skillsLabel} · 插件：${pluginsLabel}`,
  });
}

function generateRandomSixDigitPin(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return String(buf[0]! % 1_000_000).padStart(6, '0');
  }
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function extractCloudEndpointFromRecord(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cfg = raw as {
    provider?: unknown;
    webdav?: { endpoint?: unknown };
    s3?: { endpoint?: unknown };
    ftp?: { host?: unknown; port?: unknown; useTls?: unknown };
  };
  if (cfg.provider === 'webdav' && typeof cfg.webdav?.endpoint === 'string' && cfg.webdav.endpoint.trim()) {
    return cfg.webdav.endpoint.trim();
  }
  if (cfg.provider === 's3' && typeof cfg.s3?.endpoint === 'string' && cfg.s3.endpoint.trim()) {
    return cfg.s3.endpoint.trim();
  }
  if (cfg.provider === 'ftp' && typeof cfg.ftp?.host === 'string' && cfg.ftp.host.trim()) {
    const scheme = cfg.ftp.useTls ? 'ftps' : 'ftp';
    const portSuffix = typeof cfg.ftp.port === 'number' && cfg.ftp.port > 0 ? `:${cfg.ftp.port}` : '';
    return `${scheme}://${cfg.ftp.host.trim()}${portSuffix}`;
  }
  return null;
}

async function probeCloudEndpointContext(
  allowBackendResolve = true,
): Promise<cloudApi.EndpointNetworkContext | null> {
  try {
    const cached = cloudApi.loadStoredCloudStorageConfigSafe();
    const cachedEndpoint = extractCloudEndpointFromRecord(cached);
    if (cachedEndpoint) {
      return cloudApi.classifyEndpointNetworkContext(cachedEndpoint);
    }
  } catch {
    // Ignore local cache parse failure
  }
  try {
    const rawSetting = await invoke<string | null>('get_setting', {
      key: 'cloud_storage.config.safe_v1',
    });
    if (typeof rawSetting === 'string' && rawSetting.trim()) {
      const endpoint = extractCloudEndpointFromRecord(JSON.parse(rawSetting));
      if (endpoint) {
        return cloudApi.classifyEndpointNetworkContext(endpoint);
      }
    }
  } catch {
    // Ignore setting probe failure
  }
  if (allowBackendResolve) {
    try {
      const resolved = await cloudApi.resolveCloudStorageConfig();
      const resolvedEndpoint = extractCloudEndpointFromRecord(resolved);
      if (resolvedEndpoint) {
        return cloudApi.classifyEndpointNetworkContext(resolvedEndpoint);
      }
    } catch {
      // Ignore backend resolution failure
    }
  }
  return null;
}

function localizePairingError(
  caughtError: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
  language?: string,
): string {
  const code =
    caughtError && typeof caughtError === 'object' && 'code' in caughtError
      ? (caughtError as { code?: unknown }).code
      : undefined;
  const raw = getErrorMessage(caughtError).trim();
  if (
    (typeof code === 'string' && code === PAIRING_CODE_EXPIRED_TOKEN)
    || raw.includes(PAIRING_CODE_EXPIRED_TOKEN)
    || raw.includes('配对码已过期')
  ) {
    return t('sync:pairing.codeExpiredError', {
      defaultValue: '该配对码已过期（默认有效期 15 分钟）。请在原设备重新生成新的配对码后再接入。',
    });
  }
  if (raw.includes('不支持的配对码格式')) {
    return t('sync:pairing.invalidFormatError', {
      defaultValue: '不支持的配对码格式，请粘贴有效的 DSPAIR1 配对码。',
    });
  }
  if (raw.includes('PIN 不正确或配对码已损坏')) {
    return t('sync:pairing.invalidPinOrCorruptedError', {
      defaultValue: '6 位 PIN 不正确或配对码已损坏，请核对后重试。',
    });
  }
  if (raw.includes('请输入 6 位数字 PIN')) {
    return t('sync:pairing.invalidPinLengthError', {
      defaultValue: '请输入 6 位数字 PIN。',
    });
  }
  if (raw.includes('不支持的配对配置') || raw.includes('配对配置包含不支持的设置')) {
    return t('sync:pairing.unsupportedPayloadError', {
      defaultValue: '不支持的配对配置内容。',
    });
  }
  return localizeBackendErrorText(raw, language);
}

interface PairingFallbackCopy {
  copyPairingCodeBtn: string;
  qrDecodeEmptyError: string;
  qrImageReadError: (reason: string) => string;
  pasteCodeInsteadBtn: string;
  retryImportImageBtn: string;
}

function getPairingFallbackCopy(language?: string): PairingFallbackCopy {
  if (isEnglishUiLanguage(language)) {
    return {
      copyPairingCodeBtn: 'Copy pairing code',
      qrDecodeEmptyError:
        'Could not detect a sync pairing QR code in this image. Try instead: 1) Copy and paste the pairing text code below; 2) Crop tightly around the QR code area (keeping its white border) and retry; 3) Use the 6-digit pairing PIN from the source device.',
      qrImageReadError: (reason: string) =>
        `Failed to read QR image (${reason}). Try instead: 1) Copy and paste the pairing text code below; 2) Crop tightly around the QR code area and retry; 3) Use the 6-digit pairing PIN from the source device.`,
      pasteCodeInsteadBtn: 'Paste pairing code instead',
      retryImportImageBtn: 'Choose another image',
    };
  }
  return {
    copyPairingCodeBtn: '复制配对码',
    qrDecodeEmptyError:
      '未能从所选图片中识别出同步二维码。可改用：1) 复制配对文本码粘贴导入；2) 仅裁剪二维码区域（保留白边）后重试；3) 使用原设备显示的 6 位配对码完成接入。',
    qrImageReadError: (reason: string) =>
      `读取二维码图片失败（${reason}）。可改用：1) 复制配对文本码粘贴导入；2) 仅裁剪二维码区域后重试；3) 使用 6 位配对码完成接入。`,
    pasteCodeInsteadBtn: '改用粘贴配对码',
    retryImportImageBtn: '重新选择图片',
  };
}

export interface DevicePairingSectionProps {
  onApplied?: () => void;
  /** 可选同步触发器：发送端可一键推送快照，接收端接入后可一键拉取数据 */
  onRunSync?: (direction: 'upload' | 'download' | 'bidirectional') => void | boolean | Promise<void | boolean>;
  /** 本机是否已配置云存储 */
  cloudConfigured?: boolean;
}

export function DevicePairingSection({
  onApplied,
  onRunSync,
  cloudConfigured,
}: DevicePairingSectionProps) {
  const { t, i18n } = useTranslation(['sync', 'cloudStorage', 'common']);
  const [skills, setSkills] = useState(true);
  const [plugins, setPlugins] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // 模式切换：send（本机生成二维码） vs receive（扫码/导入接入）
  const [activeMode, setActiveMode] = useState<'send' | 'receive'>('send');
  const [storedCloudConfigured, setStoredCloudConfigured] = useState<boolean>(() => {
    try {
      return Boolean(cloudApi.loadStoredCloudStorageConfigSafe());
    } catch {
      return false;
    }
  });
  const [endpointContext, setEndpointContext] = useState<cloudApi.EndpointNetworkContext | null>(() => {
    try {
      const cached = cloudApi.loadStoredCloudStorageConfigSafe();
      const endpoint = extractCloudEndpointFromRecord(cached);
      return endpoint ? cloudApi.classifyEndpointNetworkContext(endpoint) : null;
    } catch {
      return null;
    }
  });
  const cloudProbeSeqRef = useRef(0);

  const refreshStoredCloudConfig = useCallback(
    async (allowBackendResolve = true): Promise<boolean> => {
      const seq = ++cloudProbeSeqRef.current;
      const [found, context] = await Promise.all([
        probeStoredCloudConfigured({ allowBackendResolve }),
        probeCloudEndpointContext(allowBackendResolve),
      ]);
      if (seq === cloudProbeSeqRef.current) {
        setStoredCloudConfigured(found);
        setEndpointContext(context);
      }
      return found;
    },
    [],
  );

  useEffect(() => {
    // When parent passes cloudConfigured (e.g. CloudStorageSection), avoid
    // racing parent's initial resolveCloudStorageConfig() call on mount.
    void refreshStoredCloudConfig(cloudConfigured === undefined);
  }, [cloudConfigured, activeMode, refreshStoredCloudConfig]);

  useEventRegistry(
    [
      {
        target: 'window',
        type: 'data-governance:cloud-config-changed',
        listener: () => { void refreshStoredCloudConfig(true); },
      },
      {
        target: 'window',
        type: 'storage',
        listener: () => { void refreshStoredCloudConfig(true); },
      },
      {
        target: 'window',
        type: 'focus',
        listener: () => { void refreshStoredCloudConfig(true); },
      },
    ],
    [refreshStoredCloudConfig],
  );

  const effectiveCloudConfigured = Boolean(cloudConfigured || storedCloudConfigured);

  // 发送端状态
  const [pin, setPin] = useState('');
  const [cloud, setCloud] = useState(true);
  const [llm, setLlm] = useState(false);
  const [prefs, setPrefs] = useState(true);
  const [code, setCode] = useState('');
  const [generatedPinDisplay, setGeneratedPinDisplay] = useState('');
  const [generatedExpiresAt, setGeneratedExpiresAt] = useState<number | null>(null);

  // 接收端状态
  const [incoming, setIncoming] = useState('');
  const [applyPin, setApplyPin] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraHint, setCameraHint] = useState<string | null>(null);
  const [appliedSuccess, setAppliedSuccess] = useState(false);
  const [runningBiSync, setRunningBiSync] = useState(false);
  const [decodingImage, setDecodingImage] = useState(false);
  const [qrImportError, setQrImportError] = useState(false);
  const [highlightPasteBox, setHighlightPasteBox] = useState(false);

  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const endpointWarnings: string[] = [];
  if (endpointContext) {
    if (endpointContext.isLoopback) {
      endpointWarnings.push(
        t('sync:pairing.endpointWarningLoopback', {
          host: endpointContext.host,
          defaultValue: `提示：当前云存储地址（${endpointContext.host}）指向本机回环地址，其他设备无法访问 localhost/127.0.0.1。跨设备配对前请改为局域网 IP 或公网域名。`,
        }),
      );
    } else if (endpointContext.isPrivateLan) {
      endpointWarnings.push(
        t('sync:pairing.endpointWarningPrivateLan', {
          host: endpointContext.host,
          defaultValue: `提示：当前云存储地址（${endpointContext.host}）为局域网内网地址，跨设备同步时请确保两台设备处于同一局域网/Wi-Fi 环境。`,
        }),
      );
    }
    if (endpointContext.isHttpUnderHttps) {
      endpointWarnings.push(
        t('sync:pairing.endpointWarningHttpUnderHttps', {
          host: endpointContext.host,
          defaultValue: `提示：当前处于 HTTPS 网页端，但云存储地址为明文 HTTP（${endpointContext.host}）。如遇浏览器拦截混合内容请求，请为存储服务启用 HTTPS 或改用桌面客户端。`,
        }),
      );
    }
  }

  const fallbackCopy = getPairingFallbackCopy(i18n?.language);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const codeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const incomingTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const applyPinInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = codeTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) {
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [code]);

  const resolveSyncFailureReason = useCallback(
    (caughtError: unknown, fallbackKey: string, fallbackText: string): string => {
      const language = i18n?.language;
      const rawCaught = caughtError ? getErrorMessage(caughtError).trim() : '';
      if (rawCaught) {
        return localizeBackendErrorText(rawCaught, language);
      }
      const storeError = useGlobalSyncStore.getState().progress?.error?.trim();
      if (storeError) {
        return localizeBackendErrorText(storeError, language);
      }
      return t(fallbackKey, { defaultValue: fallbackText });
    },
    [i18n?.language, t],
  );

  const cameraSession = useRef(0);
  const stopCamera = useCallback(() => {
    cameraSession.current++;
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  async function load() {
    const values = await Promise.all(
      ['sync.include_skills', 'sync.include_plugins'].map((key) =>
        invoke<string | null>('get_setting', { key }),
      ),
    );
    setSkills(values[0] !== 'false');
    setPlugins(values[1] !== 'false');
    setLoaded(true);
  }

  useEffect(() => {
    void load().catch((e) => setError(getErrorMessage(e)));
  }, []);

  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    setQrImportError(false);
    setHighlightPasteBox(false);
    try {
      await action();
    } catch (e) {
      setError(localizePairingError(e, t, i18n?.language));
    } finally {
      setBusy(false);
    }
  }

  const focusManualPasteInput = useCallback(() => {
    stopCamera();
    setCameraHint(null);
    setHighlightPasteBox(true);
    if (activeMode !== 'receive') {
      setActiveMode('receive');
      setTimeout(() => {
        incomingTextareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        incomingTextareaRef.current?.focus();
      }, 0);
      return;
    }
    incomingTextareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    incomingTextareaRef.current?.focus();
  }, [activeMode, stopCamera]);

  const toggle = (key: string, value: boolean, update: (value: boolean) => void) =>
    void work(async () => {
      await invoke('save_setting', { key, value: String(value) });
      update(value);
    });

  const handleGenerateQr = (alsoPushSnapshot = false, forceRandomPin = false) =>
    void work(async () => {
      await refreshStoredCloudConfig();
      const targetPin =
        !forceRandomPin && /^\d{6}$/.test(pin) ? pin : generateRandomSixDigitPin();
      if (targetPin !== pin) {
        setPin(targetPin);
      }
      if (alsoPushSnapshot) {
        try {
          await invoke('save_setting', {
            key: 'data_governance.pending_full_snapshot_push',
            value: String(Date.now()),
          });
        } catch {
          // Ignore when unit-test invoke mocks do not handle this setting key
        }
        try {
          if (onRunSync) {
            let pushed: void | boolean;
            try {
              pushed = await onRunSync('upload');
            } catch (syncErr) {
              const reason = resolveSyncFailureReason(
                syncErr,
                'sync:pairing.pushSnapshotFailedFallback',
                '请检查云存储配置、网络或权限后重试',
              );
              setError(
                t('sync:pairing.pushSnapshotFailed', {
                  error: reason,
                  defaultValue: `推送本机最新快照失败：${reason}`,
                }),
              );
              return;
            }
            if (pushed === false) {
              const reason = resolveSyncFailureReason(
                null,
                'sync:pairing.pushSnapshotFailedFallback',
                '请检查云存储配置、网络或权限后重试',
              );
              const pushFailedMessage = t('sync:pairing.pushSnapshotFailed', {
                error: reason,
                defaultValue: `推送本机最新快照失败：${reason}`,
              });
              setError(pushFailedMessage);
              return;
            }
          }
        } finally {
          try {
            await invoke('save_setting', {
              key: 'data_governance.pending_full_snapshot_push',
              value: '',
            });
          } catch {
            // ignore cleanup failure
          }
        }
      }
      const result = await createPairingCode(ipcPairingSettings, {
        pin: targetPin,
        includeCloudConfig: cloud,
        includeLlmKeys: llm,
        includeSyncPrefs: prefs,
      });
      setCode(result.pairingCode);
      setGeneratedPinDisplay(targetPin);
      setGeneratedExpiresAt(result.expiresAt ?? null);
      const summary = describeSummary(result.summary, t);
      if (alsoPushSnapshot) {
        const pushedMsg = t('sync:pairing.qrGeneratedAndPushedStatus', {
          summary,
          defaultValue: `已生成配对码并推送最新快照（${summary}）`,
        });
        setStatus(pushedMsg);
        showGlobalNotification('success', pushedMsg);
      } else {
        setStatus(
          t('sync:pairing.qrGeneratedStatus', {
            summary,
            defaultValue: `已生成同步二维码（${summary}）`,
          }),
        );
      }
    });

  const handleDownloadQrSvg = () => {
    if (!code) return;
    try {
      const svgString = renderQrCodeSvgString(code, { size: 480, margin: 4 });
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const now = new Date();
      const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      a.download = `deepstudent-sync-qr-${ymd}.svg`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(
        t('sync:pairing.qrDownloadedStatus', {
          defaultValue: '同步二维码图片已下载',
        }),
      );
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };

  const handleStartCameraScan = async () => {
    setError('');
    setCameraHint(null);
    if (cameraActive) {
      stopCamera();
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setCameraHint(
        t('sync:pairing.cameraUnavailable', {
          defaultValue: '当前设备环境未暴露摄像头接口，请使用「从二维码图片导入」或直接粘贴配对码。',
        }),
      );
      return;
    }

    const session = ++cameraSession.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      if (session !== cameraSession.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      mediaStreamRef.current = stream;
      setCameraActive(true);
      const canvas = document.createElement('canvas');
      let decoding = false;
      scanTimerRef.current = setInterval(async () => {
        const video = videoRef.current;
        if (!video || decoding) return;
        if (video.srcObject !== stream) video.srcObject = stream;
        if (video.readyState < 2) return;
        decoding = true;
        try {
          const decoded = await decodePairingFrame(
            canvas,
            video,
            video.videoWidth,
            video.videoHeight,
            { mode: 'fast' },
          );
          if (decoded && cameraSession.current === session) {
            setIncoming(decoded);
            setQrImportError(false);
            setHighlightPasteBox(false);
            setStatus(
              t('sync:pairing.cameraRecognized', {
                defaultValue: '已通过摄像头识别到同步二维码，请输入 6 位 PIN 完成接入',
              }),
            );
            stopCamera();
            applyPinInputRef.current?.focus();
          }
        } catch (e) {
          if (cameraSession.current === session) {
            stopCamera();
            const errMsg = getErrorMessage(e);
            setCameraHint(
              t('sync:pairing.cameraDecodeFailed', {
                error: errMsg,
                defaultValue: `无法解码摄像头画面：${errMsg}`,
              }),
            );
          }
        } finally {
          decoding = false;
        }
      }, 350);
    } catch (e) {
      if (cameraSession.current !== session) return;
      stopCamera();
      const errMsg = getErrorMessage(e);
      setCameraHint(
        t('sync:pairing.cameraStartFailed', {
          error: errMsg,
          defaultValue: `无法开启摄像头（${errMsg}），请使用「从二维码图片导入」或直接粘贴配对码。`,
        }),
      );
    }
  };

  const handleImportQrImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError('');
    setStatus('');
    setQrImportError(false);
    setHighlightPasteBox(false);
    setDecodingImage(true);

    try {
      const decoded = await decodePairingImage(file);
      if (decoded) {
        setIncoming(decoded);
        setQrImportError(false);
        setHighlightPasteBox(false);
        setStatus(
          t('sync:pairing.imageRecognized', {
            defaultValue: '已从二维码图片识别配对码，请输入 6 位 PIN 完成接入',
          }),
        );
        applyPinInputRef.current?.focus();
        return;
      }
      setQrImportError(true);
      setError(fallbackCopy.qrDecodeEmptyError);
    } catch (e) {
      const errMsg = localizeBackendErrorText(getErrorMessage(e), i18n?.language);
      setQrImportError(true);
      setError(fallbackCopy.qrImageReadError(errMsg));
    } finally {
      setDecodingImage(false);
    }
  };

  const handleApplyPairing = (triggerPullAfter = false) =>
    void work(async () => {
      const normalizedIncoming = incoming.trim();
      const result = await applyPairingCode(ipcPairingSettings, {
        pairingCode: normalizedIncoming,
        pin: applyPin.trim(),
      });
      await load();
      await refreshStoredCloudConfig();
      window.dispatchEvent(new CustomEvent('data-governance:cloud-config-changed'));
      onApplied?.();
      setIncoming('');
      setApplyPin('');
      setAppliedSuccess(true);
      const summary = describeSummary(result.summary, t);
      setStatus(
        t('sync:pairing.codeAppliedStatus', {
          summary,
          defaultValue: `配置已接入。${summary}`,
        }),
      );
      if (triggerPullAfter && onRunSync) {
        let pulled: void | boolean;
        try {
          pulled = await onRunSync('download');
        } catch (pullErr) {
          const reason = resolveSyncFailureReason(
            pullErr,
            'sync:pairing.applyPullFailedFallback',
            '请点击下方「立即执行双向云同步」重试',
          );
          setError(
            t('sync:pairing.applyPullFailedStatus', {
              error: reason,
              defaultValue: `配置已接入，但拉取云端数据失败：${reason}`,
            }),
          );
          return;
        }
        if (pulled === false) {
          const reason = resolveSyncFailureReason(
            null,
            'sync:pairing.applyPullFailedFallback',
            '请点击下方「立即执行双向云同步」重试',
          );
          setError(
            t('sync:pairing.applyPullFailedStatus', {
              error: reason,
              defaultValue: `配置已接入，但拉取云端数据失败：${reason}`,
            }),
          );
          return;
        }
      setStatus(
        t('sync:pairing.codeAppliedAndPulledStatus', {
          summary,
          defaultValue: `配置已接入并已完成云端数据拉取。${summary}`,
        }),
      );
      }
    });

  const handleRunPostPairingSync = () =>
    void work(async () => {
      if (!onRunSync) return;
      setRunningBiSync(true);
      try {
        let synced: void | boolean;
        try {
          synced = await onRunSync('bidirectional');
        } catch (syncErr) {
          const reason = resolveSyncFailureReason(
            syncErr,
            'sync:pairing.biSyncFailedFallback',
            '请检查云存储配置、网络或凭据后重试',
          );
          setError(
            t('sync:pairing.biSyncFailedStatus', {
              error: reason,
              defaultValue: `双向云同步失败：${reason}`,
            }),
          );
          return;
        }
        if (synced === false) {
          const reason = resolveSyncFailureReason(
            null,
            'sync:pairing.biSyncFailedFallback',
            '请检查云存储配置、网络或凭据后重试',
          );
          setError(
            t('sync:pairing.biSyncFailedStatus', {
              error: reason,
              defaultValue: `双向云同步失败：${reason}`,
            }),
          );
          return;
        }
        const completedMsg = t('sync:pairing.biSyncSuccessStatus', {
          defaultValue: '双向云同步已完成。',
        });
        setStatus(completedMsg);
        showGlobalNotification('success', completedMsg);
      } finally {
        setRunningBiSync(false);
      }
    });

  return (
    <div className="space-y-6" data-testid="device-pairing-section">
      {/* 1. 同步内容扩展（技能与插件） */}
      <SettingsGroup
        title={t('sync:pairing.extensionsTitle', { defaultValue: '同步内容扩展（技能与插件）' })}
        description={t('sync:pairing.extensionsDesc', {
          defaultValue: '随云同步传输可移植文件；不会自动授予插件信任，移动端自动跳过桌面专用插件。',
        })}
      >
        <SwitchRow
          title={t('sync:pairing.syncSkillsTitle', { defaultValue: '同步自定义技能与市场技能' })}
          description={t('sync:pairing.syncSkillsDesc', {
            defaultValue: '将 .skills 目录中的自定义技能随云端同步分发到其他设备',
          })}
          checked={skills}
          disabled={!loaded || busy}
          onCheckedChange={(value) => toggle('sync.include_skills', value, setSkills)}
        />
        <SwitchRow
          title={t('sync:pairing.syncPluginsTitle', { defaultValue: '同步插件与工坊自制插件' })}
          description={t('sync:pairing.syncPluginsDesc', {
            defaultValue: '跨设备同步已安装插件包与自制插件源码',
          })}
          checked={plugins}
          disabled={!loaded || busy}
          onCheckedChange={(value) => toggle('sync.include_plugins', value, setPlugins)}
        />
      </SettingsGroup>

      {/* 2. 扫码同步 & 局域网/跨端一键配对中心 */}
      <SettingsGroup
        title={t('sync:pairing.cardTitle', { defaultValue: '扫码同步与跨设备一键配对' })}
        description={t('sync:pairing.cardDesc', {
          defaultValue:
            '无需在新设备繁琐输入 WebDAV / S3 地址、端到端加密密码或 AI 密钥。使用 6 位 PIN 端到端加密生成二维码，另一台设备扫码或导入即可一键完成配对并同步数据。',
        })}
        actions={
          <div
            className="inline-flex items-center rounded-lg bg-muted p-0.5 border border-border/40"
            role="tablist"
            aria-label={t('sync:pairing.modeSwitchAria', { defaultValue: '配对模式切换' })}
          >
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={activeMode === 'send'}
              onClick={() => {
                stopCamera();
                setQrImportError(false);
                setHighlightPasteBox(false);
                setActiveMode('send');
              }}
              className={cn(
                '!h-auto gap-1.5 rounded-md !border-0 px-2.5 py-1 text-xs font-medium transition-colors',
                activeMode === 'send'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <QrCode size={14} />
              {t('sync:pairing.tabSend', { defaultValue: '本机生成二维码' })}
            </DsButton>
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={activeMode === 'receive'}
              onClick={() => setActiveMode('receive')}
              className={cn(
                '!h-auto gap-1.5 rounded-md !border-0 px-2.5 py-1 text-xs font-medium transition-colors',
                activeMode === 'receive'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Camera size={14} />
              {t('sync:pairing.tabReceive', { defaultValue: '新设备扫码 / 接入' })}
            </DsButton>
          </div>
        }
      >
        <div className="space-y-4 px-1 py-2">
          {activeMode === 'send' ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
              {/* 左侧：配置项与生成控制 */}
              <fieldset className="space-y-3 min-w-0" disabled={busy}>
                <legend className="text-sm font-medium text-foreground mb-1">
                  {t('sync:pairing.sendTitle', { defaultValue: '在当前设备生成同步二维码' })}
                </legend>
                <div className="space-y-2 rounded-xl bg-background/55 border border-border/30 p-3">
                  <label className="flex items-center gap-2.5 text-sm text-foreground/90 cursor-pointer [@media(pointer:coarse)]:min-h-9">
                    <Checkbox
                      checked={cloud}
                      onCheckedChange={(checked) => setCloud(Boolean(checked))}
                    />
                    <span>
                      {t('sync:pairing.includeCloud', {
                        defaultValue: '云同步配置与密码（WebDAV / S3 / 端到端加密密钥）',
                      })}
                    </span>
                  </label>
                  {cloud && !effectiveCloudConfigured && (
                    <div
                      role="status"
                      data-testid="pairing-cloud-not-configured-warning"
                      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
                    >
                      <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
                      <span>
                        {t('sync:pairing.cloudNotConfiguredWarning', {
                          defaultValue:
                            '当前尚未保存云存储配置：勾选此项不会包含任何可用的云存储凭据，请先保存云存储配置后再重新生成配对码。',
                        })}
                      </span>
                    </div>
                  )}
                  {cloud && effectiveCloudConfigured && endpointWarnings.length > 0 && (
                    <div
                      role="status"
                      data-testid="pairing-lan-endpoint-warning"
                      className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
                    >
                      {endpointWarnings.map((warningText, index) => (
                        <div key={index} className="flex items-start gap-2">
                          <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
                          <span className="leading-relaxed">{warningText}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <label className="flex items-center gap-2.5 text-sm text-foreground/90 cursor-pointer [@media(pointer:coarse)]:min-h-9">
                    <Checkbox
                      checked={llm}
                      onCheckedChange={(checked) => setLlm(Boolean(checked))}
                    />
                    <span>
                      {t('sync:pairing.includeLlm', {
                        defaultValue: 'AI 供应商配置与 API 密钥',
                      })}
                    </span>
                  </label>
                  <label className="flex items-center gap-2.5 text-sm text-foreground/90 cursor-pointer [@media(pointer:coarse)]:min-h-9">
                    <Checkbox
                      checked={prefs}
                      onCheckedChange={(checked) => setPrefs(Boolean(checked))}
                    />
                    <span>
                      {t('sync:pairing.includeExtensions', {
                        defaultValue: '技能 / 插件同步偏好',
                      })}
                    </span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="device-pairing-generate-pin"
                      className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"
                    >
                      <Key size={13} />
                      {t('sync:pairing.pinLabel', { defaultValue: '生成 PIN（6 位数字）' })}
                    </label>
                    <DsButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-primary"
                      onClick={() => setPin(generateRandomSixDigitPin())}
                      disabled={busy}
                    >
                      <Shuffle size={13} className="mr-1" />
                      {t('sync:pairing.generateRandomPin', { defaultValue: '随机生成 6 位 PIN' })}
                    </DsButton>
                  </div>
                  <Input
                    id="device-pairing-generate-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={6}
                    placeholder={t('sync:pairing.pinPlaceholder', {
                      defaultValue: '输入 6 位数字 PIN（或点击右侧随机生成）',
                    })}
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    className="max-w-xs font-mono tabular-nums tracking-widest"
                  />
                  <p className="text-xs text-muted-foreground/80">
                    {t('sync:pairing.pinE2eeHint', {
                      defaultValue:
                        '配对码采用端到端加密保护，仅凭二维码无法反解，需在新设备输入同一 6 位 PIN。',
                    })}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <DsButton
                    variant="primary"
                    size="sm"
                    disabled={busy || !/^\d{6}$/.test(pin) || !(cloud || llm || prefs)}
                    onClick={() => handleGenerateQr(false)}
                    data-testid="generate-pairing-qr-btn"
                  >
                    <QrCode size={15} className="mr-1.5" />
                    {t('sync:pairing.generateQrBtn', { defaultValue: '生成同步二维码' })}
                  </DsButton>

                  <DsButton
                    variant="outline"
                    size="sm"
                    disabled={busy || !(cloud || llm || prefs)}
                    onClick={() => handleGenerateQr(false, true)}
                    title={t('sync:pairing.quickRandomTitle', {
                      defaultValue: '自动生成 6 位随机 PIN 并立即生成二维码',
                    })}
                  >
                    <Sparkle size={14} className="mr-1.5" />
                    {t('sync:pairing.quickRandomBtn', {
                      defaultValue: '一键随机 PIN 生成二维码',
                    })}
                  </DsButton>

                  {onRunSync && effectiveCloudConfigured && (
                    <DsButton
                      variant="outline"
                      size="sm"
                      disabled={busy || !(cloud || llm || prefs)}
                      onClick={() => handleGenerateQr(true)}
                    >
                      <CloudArrowUp size={15} className="mr-1.5" />
                      {t('sync:pairing.generateAndPushBtn', {
                        defaultValue: '生成并立即推送本机最新快照',
                      })}
                    </DsButton>
                  )}
                </div>
              </fieldset>

              {/* 右侧：高清 SVG 二维码展示卡片 */}
              {code ? (
                <div
                  className="flex w-full min-w-0 flex-col items-center justify-center rounded-xl bg-background/70 border border-border/35 p-4 space-y-3 lg:min-w-[264px] lg:max-w-[320px]"
                  data-testid="device-pairing-qr-panel"
                >
                  <div className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/5">
                    <QrCodeSvg value={code} size={216} margin={4} className="max-w-full h-auto" />
                  </div>
                  {generatedPinDisplay && (
                    <div className="text-center space-y-0.5">
                      <div className="text-2xs text-muted-foreground">
                        {t('sync:pairing.pinDisplayLabel', { defaultValue: '配对解密 PIN' })}
                      </div>
                      <div
                        className="font-mono text-lg font-semibold tracking-[0.28em] text-foreground tabular-nums"
                        data-testid="device-pairing-pin-display"
                      >
                        {generatedPinDisplay}
                      </div>
                    </div>
                  )}
                  {generatedExpiresAt !== null && (
                    <p
                      data-testid="device-pairing-expiry-hint"
                      className="text-center text-2xs text-muted-foreground"
                    >
                      {t('sync:pairing.codeExpiresHint', {
                        time: new Date(generatedExpiresAt).toLocaleTimeString(
                          isEnglishUiLanguage(i18n?.language) ? 'en-US' : 'zh-CN',
                          { hour: '2-digit', minute: '2-digit' },
                        ),
                        defaultValue: `配对码 15 分钟内有效（将于 ${new Date(generatedExpiresAt).toLocaleTimeString()} 过期），超时请在原设备重新生成。`,
                      })}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center justify-center gap-1.5">
                    <DsButton
                      type="button"
                      variant="primary"
                      size="sm"
                      data-testid="copy-pairing-code-btn"
                      onClick={() =>
                        void work(async () => {
                          if (!(await copyTextToClipboard(code))) {
                            throw new Error(
                              t('sync:pairing.copyFailedError', {
                                defaultValue: '复制失败，请手动复制',
                              }),
                            );
                          }
                          const copiedMsg = t('sync:pairing.codeCopiedStatus', {
                            defaultValue: '配对码已复制',
                          });
                          setStatus(copiedMsg);
                          showGlobalNotification('success', copiedMsg);
                        })
                      }
                    >
                      <Copy size={13} className="mr-1" />
                      {fallbackCopy.copyPairingCodeBtn}
                    </DsButton>
                    <DsButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleDownloadQrSvg}
                      data-testid="download-pairing-qr-btn"
                    >
                      <DownloadSimple size={13} className="mr-1" />
                      {t('sync:pairing.downloadQrBtn', { defaultValue: '下载二维码' })}
                    </DsButton>
                  </div>
                  <div className="w-full min-w-0 space-y-1.5">
                    <label className="block text-2xs text-muted-foreground">
                      {t('sync:pairing.encryptedCodeLabel', { defaultValue: '加密配对码' })}
                      <textarea
                        ref={codeTextareaRef}
                        data-testid="device-pairing-code-output"
                        aria-label={t('sync:pairing.encryptedCodeAria', {
                          defaultValue: '生成的加密配对码',
                        })}
                        readOnly
                        value={code}
                        rows={Math.max(4, Math.ceil(code.length / 34))}
                        className="mt-1 h-auto max-h-none w-full resize-none overflow-visible whitespace-pre-wrap break-all select-all rounded-lg border border-border/40 bg-background p-2.5 font-mono text-2xs leading-relaxed text-muted-foreground"
                      />
                    </label>
                    <div className="flex flex-wrap items-center justify-center gap-1.5">
                      <DsButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCode('');
                          setPin('');
                          setGeneratedPinDisplay('');
                          setGeneratedExpiresAt(null);
                        }}
                      >
                        <EyeSlash size={13} className="mr-1" />
                        {t('sync:pairing.clearCodeBtn', { defaultValue: '隐藏并清除' })}
                      </DsButton>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="hidden lg:flex flex-col items-center justify-center rounded-xl border border-dashed border-border/45 bg-background/35 px-6 py-8 text-center w-[240px]">
                  <QrCode size={40} className="text-muted-foreground/40 mb-2" />
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('sync:pairing.emptyQrTitle', { defaultValue: '尚未生成同步二维码' })}
                  </p>
                  <p className="mt-1 text-2xs text-muted-foreground/70 leading-relaxed">
                    {t('sync:pairing.emptyQrDesc', {
                      defaultValue: '输入或随机生成 6 位 PIN 后，点击左侧按钮即可在此展示高清二维码',
                    })}
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* 接收端：扫码 / 导入二维码图片 / 粘贴配对码 */
            <fieldset className="space-y-4" disabled={busy}>
              <legend className="text-sm font-medium text-foreground">
                {t('sync:pairing.receiveTitle', { defaultValue: '在新设备扫码或粘贴配对码接入' })}
              </legend>

              {/* 快捷扫码与图片导入工具栏 */}
              <div className="flex flex-wrap items-center gap-2">
                <DsButton
                  type="button"
                  variant={cameraActive ? 'danger' : 'outline'}
                  size="sm"
                  onClick={() => void handleStartCameraScan()}
                  data-testid="camera-scan-pairing-btn"
                >
                  {cameraActive ? (
                    <>
                      <StopCircle size={14} className="mr-1.5" />
                      {t('sync:pairing.stopCameraScan', { defaultValue: '停止摄像头扫码' })}
                    </>
                  ) : (
                    <>
                      <Camera size={14} className="mr-1.5" />
                      {t('sync:pairing.startCameraScan', { defaultValue: '使用摄像头扫码' })}
                    </>
                  )}
                </DsButton>

                <DsButton
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={decodingImage}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="import-qr-image-btn"
                >
                  <ImageSquare size={14} className="mr-1.5" />
                  {t('sync:pairing.importQrImage', { defaultValue: '从二维码图片导入' })}
                </DsButton>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/svg+xml,image/png,image/jpeg,image/webp,.svg,.png,.jpg,.jpeg,.webp"
                  className="hidden"
                  data-testid="import-qr-file-input"
                  aria-label={t('sync:pairing.importQrAria', {
                    defaultValue: '选择同步二维码图片',
                  })}
                  onChange={(e) => void handleImportQrImage(e)}
                />
              </div>

              {error && qrImportError && (
                <div
                  role="alert"
                  data-testid="pairing-qr-import-error"
                  className="rounded-xl bg-destructive/5 border border-destructive/25 px-3 py-2.5 text-xs text-destructive space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <WarningCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
                    <span className="leading-relaxed">{error}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-5">
                    <DsButton
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={focusManualPasteInput}
                      data-testid="pairing-qr-fallback-paste-btn"
                    >
                      <Copy size={13} className="mr-1.5" />
                      {fallbackCopy.pasteCodeInsteadBtn}
                    </DsButton>
                    <DsButton
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={decodingImage}
                      onClick={() => fileInputRef.current?.click()}
                      data-testid="pairing-qr-retry-import-btn"
                    >
                      <ImageSquare size={13} className="mr-1.5" />
                      {fallbackCopy.retryImportImageBtn}
                    </DsButton>
                  </div>
                </div>
              )}

              {cameraActive && (
                <div className="rounded-xl border border-border/40 bg-background/70 p-3 space-y-2 max-w-sm">
                  <video
                    autoPlay
                    ref={videoRef}
                    muted
                    playsInline
                    className="w-full rounded-lg bg-black/90 aspect-square object-cover"
                  />
                  <p className="text-xs text-muted-foreground text-center">
                    {t('sync:pairing.cameraAimHint', {
                      defaultValue: '请将另一台设备上的同步二维码置于取景框中央',
                    })}
                  </p>
                </div>
              )}

              {cameraHint && (
                <div className="rounded-xl bg-background/60 border border-border/35 px-3 py-2 text-xs text-muted-foreground">
                  {cameraHint}
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                <label className="block text-xs font-medium text-muted-foreground">
                  {t('sync:pairing.pasteCodeLabel', {
                    defaultValue: '粘贴 DSPAIR1 配对码（或通过上方扫码自动填入）',
                  })}
                  <textarea
                    ref={incomingTextareaRef}
                    data-testid="pairing-code-paste-input"
                    value={incoming}
                    onChange={(e) => {
                      setIncoming(e.target.value);
                      if (highlightPasteBox) setHighlightPasteBox(false);
                      if (qrImportError && e.target.value.trim()) {
                        setQrImportError(false);
                        setError('');
                      }
                    }}
                    rows={3}
                    placeholder="DSPAIR1:..."
                    className={cn(
                      'mt-1.5 w-full rounded-xl border bg-background/80 p-2.5 font-mono text-xs text-foreground transition-shadow',
                      highlightPasteBox
                        ? 'border-primary ring-2 ring-primary/35'
                        : 'border-border/40',
                    )}
                  />
                </label>

                <div className="space-y-2">
                  <label className="block text-xs font-medium text-muted-foreground space-y-1.5">
                    <span>
                      {t('sync:pairing.receivePinLabel', { defaultValue: '配对 PIN（6 位数字）' })}
                    </span>
                    <Input
                      ref={applyPinInputRef}
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      placeholder={t('sync:pairing.receivePinPlaceholder', {
                        defaultValue: '6 位数字 PIN',
                      })}
                      value={applyPin}
                      onChange={(e) => setApplyPin(e.target.value.replace(/\D/g, ''))}
                      className="font-mono tabular-nums tracking-widest"
                    />
                  </label>
                  <p className="text-2xs text-muted-foreground/80 leading-relaxed">
                    {t('sync:pairing.applyHint', {
                      defaultValue:
                        '接入将更新配对码包含的云存储与 AI 配置；技能与插件在下一次云同步时自动下载。',
                    })}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <DsButton
                  variant="primary"
                  size="sm"
                  disabled={
                    busy ||
                    !incoming.trim().startsWith('DSPAIR1:') ||
                    !/^\d{6}$/.test(applyPin)
                  }
                  onClick={() => handleApplyPairing(false)}
                  data-testid="apply-pairing-code-btn"
                >
                  <CheckCircle size={15} className="mr-1.5" />
                  {t('sync:pairing.applyBtn', { defaultValue: '一键接入配置' })}
                </DsButton>

                {onRunSync && (
                  <DsButton
                    variant="outline"
                    size="sm"
                    disabled={
                      busy ||
                      !incoming.trim().startsWith('DSPAIR1:') ||
                      !/^\d{6}$/.test(applyPin)
                    }
                    onClick={() => handleApplyPairing(true)}
                  >
                    <Download size={14} className="mr-1.5" />
                    {t('sync:pairing.applyAndPullBtn', { defaultValue: '接入并立即拉取云端数据' })}
                  </DsButton>
                )}

                {appliedSuccess && onRunSync && (
                  <DsButton
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    data-testid="pairing-run-bisync-btn"
                    onClick={handleRunPostPairingSync}
                  >
                    {runningBiSync ? (
                      <>
                        <CircleNotch size={14} className="mr-1.5 animate-spin" />
                        {t('sync:pairing.biSyncRunningBtn', { defaultValue: '正在双向同步...' })}
                      </>
                    ) : (
                      <>
                        <Upload size={14} className="mr-1.5" />
                        {t('sync:pairing.runBiSyncBtn', { defaultValue: '立即执行双向云同步' })}
                      </>
                    )}
                  </DsButton>
                )}
              </div>

              {appliedSuccess && endpointWarnings.length > 0 && (
                <div
                  role="status"
                  data-testid="pairing-applied-lan-warning"
                  className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
                >
                  {endpointWarnings.map((warningText, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <WarningCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
                      <span className="leading-relaxed">{warningText}</span>
                    </div>
                  ))}
                </div>
              )}
            </fieldset>
          )}

          {status && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-xl bg-background/60 border border-border/35 px-3 py-2 text-xs text-foreground"
            >
              <CheckCircle size={14} className="text-success shrink-0" />
              <span>{status}</span>
            </div>
          )}
          {error && !(qrImportError && activeMode === 'receive') && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-xl bg-destructive/5 border border-destructive/25 px-3 py-2 text-xs text-destructive"
            >
              <WarningCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </SettingsGroup>
    </div>
  );
}

export default DevicePairingSection;
