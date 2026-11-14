import React, { useCallback, useEffect, useRef, useState } from 'react';
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
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import { SettingsGroup, SwitchRow } from './settingsTabPrimitives';
import {
  QrCodeSvg,
  renderQrCodeSvgString,
  extractPairingCodeFromText,
} from '../utils/qrCodeSvg';
import {
  applyPairingCode,
  createPairingCode,
  type PairingSettings as PairingSettingsStore,
  type PairingSummary as Summary,
} from '../../../../host/plugins/sync/src/device-pairing';

interface BarcodeDetectorLike {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
}

type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => BarcodeDetectorLike;

function getBarcodeDetectorCtor(): BarcodeDetectorConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  return typeof candidate === 'function' ? candidate : null;
}

export const ipcPairingSettings: PairingSettingsStore = {
  get: (key) => invoke<string | null>('get_setting', { key }),
  save: async (key, value) => {
    await invoke('save_setting', { key, value });
  },
  getSecret: (key) => invoke<string | null>('get_setting', { key }),
  saveSecret: async (key, value) => {
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

function describeSummary(summary: Summary): string {
  return `云存储：${summary.cloudProvider ?? '未包含'} · AI 供应商：${summary.llmProviders} 个 · 技能：${
    summary.includeSkills === null ? '未包含' : summary.includeSkills ? '同步' : '不同步'
  } · 插件：${
    summary.includePlugins === null ? '未包含' : summary.includePlugins ? '同步' : '不同步'
  }`;
}

function generateRandomSixDigitPin(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return String(buf[0]! % 1_000_000).padStart(6, '0');
  }
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

export interface DevicePairingSectionProps {
  onApplied?: () => void;
  /** 可选同步触发器：发送端可一键推送快照，接收端接入后可一键拉取数据 */
  onRunSync?: (direction: 'upload' | 'download' | 'bidirectional') => void;
  /** 本机是否已配置云存储 */
  cloudConfigured?: boolean;
}

export function DevicePairingSection({
  onApplied,
  onRunSync,
  cloudConfigured = false,
}: DevicePairingSectionProps) {
  const [skills, setSkills] = useState(true);
  const [plugins, setPlugins] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // 模式切换：send（本机生成二维码） vs receive（扫码/导入接入）
  const [activeMode, setActiveMode] = useState<'send' | 'receive'>('send');

  // 发送端状态
  const [pin, setPin] = useState('');
  const [cloud, setCloud] = useState(true);
  const [llm, setLlm] = useState(false);
  const [prefs, setPrefs] = useState(true);
  const [code, setCode] = useState('');
  const [generatedPinDisplay, setGeneratedPinDisplay] = useState('');

  // 接收端状态
  const [incoming, setIncoming] = useState('');
  const [applyPin, setApplyPin] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraHint, setCameraHint] = useState<string | null>(null);
  const [appliedSuccess, setAppliedSuccess] = useState(false);

  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopCamera = useCallback(() => {
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
    try {
      await action();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (key: string, value: boolean, update: (value: boolean) => void) =>
    void work(async () => {
      await invoke('save_setting', { key, value: String(value) });
      update(value);
    });

  const handleGenerateQr = (alsoPushSnapshot = false) =>
    void work(async () => {
      const targetPin = /^\d{6}$/.test(pin) ? pin : generateRandomSixDigitPin();
      if (targetPin !== pin) {
        setPin(targetPin);
      }
      const result = await createPairingCode(ipcPairingSettings, {
        pin: targetPin,
        includeCloudConfig: cloud,
        includeLlmKeys: llm,
        includeSyncPrefs: prefs,
      });
      setCode(result.pairingCode);
      setGeneratedPinDisplay(targetPin);
      setStatus(`已生成同步二维码（${describeSummary(result.summary)}）`);
      if (alsoPushSnapshot && onRunSync) {
        onRunSync('upload');
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
      a.download = `deepstudent-sync-qr-${new Date().toISOString().slice(0, 10)}.svg`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus('同步二维码图片已下载');
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
      setCameraHint('当前设备环境未暴露摄像头接口，请使用「从二维码图片导入」或直接粘贴配对码。');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      mediaStreamRef.current = stream;
      setCameraActive(true);

      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      });

      const DetectorCtor = getBarcodeDetectorCtor();
      if (!DetectorCtor) {
        setCameraHint(
          '当前系统 WebView 暂不支持实时 BarcodeDetector 解码，您可截图保存二维码后点击「从二维码图片导入」或直接粘贴配对码。',
        );
        return;
      }

      const detector = new DetectorCtor({ formats: ['qr_code'] });
      scanTimerRef.current = setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return;
        try {
          const barcodes = await detector.detect(videoRef.current);
          for (const item of barcodes) {
            const extracted = extractPairingCodeFromText(item.rawValue ?? '');
            if (extracted) {
              setIncoming(extracted);
              setStatus('已通过摄像头识别到同步二维码，请输入 6 位 PIN 完成接入');
              stopCamera();
              return;
            }
          }
        } catch {
          // 忽略单帧识别错误
        }
      }, 350);
    } catch (e) {
      stopCamera();
      setCameraHint(
        `无法开启摄像头（${getErrorMessage(e)}），请使用「从二维码图片导入」或直接粘贴配对码。`,
      );
    }
  };

  const handleImportQrImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError('');
    setStatus('');

    try {
      // 1. 优先检查文本/SVG 内嵌的 DSPAIR1 元数据（对本应用导出的二维码 100% 离线零依赖识别）
      const textContent = await file.text().catch(() => '');
      const fromText = extractPairingCodeFromText(textContent);
      if (fromText) {
        setIncoming(fromText);
        setStatus('已从二维码文件中读取配对码，请输入 6 位 PIN 完成接入');
        return;
      }

      // 2. 若是普通光栅截图（PNG/JPG/WebP），使用浏览器 BarcodeDetector 解码
      const DetectorCtor = getBarcodeDetectorCtor();
      if (DetectorCtor && typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file);
        try {
          const detector = new DetectorCtor({ formats: ['qr_code'] });
          const results = await detector.detect(bitmap);
          for (const res of results) {
            const extracted = extractPairingCodeFromText(res.rawValue ?? '');
            if (extracted) {
              setIncoming(extracted);
              setStatus('已从二维码图片识别配对码，请输入 6 位 PIN 完成接入');
              return;
            }
          }
        } finally {
          bitmap.close?.();
        }
      }

      setError('未能从所选图片中识别出 DSPAIR1 同步配对码，请优先导入本应用下载的 SVG 二维码或直接粘贴配对码文本。');
    } catch (e) {
      setError(`读取二维码图片失败：${getErrorMessage(e)}`);
    }
  };

  const handleApplyPairing = (triggerPullAfter = false) =>
    void work(async () => {
      const result = await applyPairingCode(ipcPairingSettings, {
        pairingCode: incoming.trim(),
        pin: applyPin,
      });
      await load();
      onApplied?.();
      setIncoming('');
      setApplyPin('');
      setAppliedSuccess(true);
      setStatus(`配置已接入。${describeSummary(result.summary)}`);
      if (triggerPullAfter && onRunSync) {
        onRunSync('download');
      }
    });

  return (
    <div className="space-y-6" data-testid="device-pairing-section">
      {/* 1. 同步内容扩展（技能与插件） */}
      <SettingsGroup
        title="同步内容扩展（技能与插件）"
        description="随云同步传输可移植文件；不会自动授予插件信任，移动端自动跳过桌面专用插件。"
      >
        <SwitchRow
          title="同步自定义技能与市场技能"
          description="将 .skills 目录中的自定义技能随云端同步分发到其他设备"
          checked={skills}
          disabled={!loaded || busy}
          onCheckedChange={(value) => toggle('sync.include_skills', value, setSkills)}
        />
        <SwitchRow
          title="同步插件与工坊自制插件"
          description="跨设备同步已安装插件包与自制插件源码"
          checked={plugins}
          disabled={!loaded || busy}
          onCheckedChange={(value) => toggle('sync.include_plugins', value, setPlugins)}
        />
      </SettingsGroup>

      {/* 2. 扫码同步 & 局域网/跨端一键配对中心 */}
      <SettingsGroup
        title="扫码同步与跨设备一键配对"
        description="无需在新设备繁琐输入 WebDAV / S3 地址、端到端加密密码或 AI 密钥。使用 6 位 PIN 端到端加密生成二维码，另一台设备扫码或导入即可一键完成配对并同步数据。"
        actions={
          <div
            className="inline-flex items-center rounded-lg bg-muted p-0.5 border border-border/40"
            role="tablist"
            aria-label="配对模式切换"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === 'send'}
              onClick={() => {
                stopCamera();
                setActiveMode('send');
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-9',
                activeMode === 'send'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <QrCode size={14} />
              本机生成二维码
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === 'receive'}
              onClick={() => setActiveMode('receive')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-9',
                activeMode === 'receive'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Camera size={14} />
              新设备扫码 / 接入
            </button>
          </div>
        }
      >
        <div className="space-y-4 px-1 py-2">
          {activeMode === 'send' ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
              {/* 左侧：配置项与生成控制 */}
              <fieldset className="space-y-3 min-w-0" disabled={busy}>
                <legend className="text-sm font-medium text-foreground mb-1">
                  在当前设备生成同步二维码
                </legend>
                <div className="space-y-2 rounded-xl bg-background/55 border border-border/30 p-3">
                  <label className="flex items-center gap-2.5 text-sm text-foreground/90 cursor-pointer [@media(pointer:coarse)]:min-h-9">
                    <Checkbox
                      checked={cloud}
                      onCheckedChange={(checked) => setCloud(Boolean(checked))}
                    />
                    <span>云同步配置与密码（WebDAV / S3 / 端到端加密密钥）</span>
                  </label>
                  <label className="flex items-center gap-2.5 text-sm text-foreground/90 cursor-pointer [@media(pointer:coarse)]:min-h-9">
                    <Checkbox
                      checked={llm}
                      onCheckedChange={(checked) => setLlm(Boolean(checked))}
                    />
                    <span>AI 供应商配置与 API 密钥</span>
                  </label>
                  <label className="flex items-center gap-2.5 text-sm text-foreground/90 cursor-pointer [@media(pointer:coarse)]:min-h-9">
                    <Checkbox
                      checked={prefs}
                      onCheckedChange={(checked) => setPrefs(Boolean(checked))}
                    />
                    <span>技能 / 插件同步偏好</span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="device-pairing-generate-pin"
                      className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"
                    >
                      <Key size={13} />
                      生成 PIN（6 位数字）
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
                      随机生成 6 位 PIN
                    </DsButton>
                  </div>
                  <Input
                    id="device-pairing-generate-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={6}
                    placeholder="输入 6 位数字 PIN（或点击右侧随机生成）"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    className="max-w-xs font-mono tabular-nums tracking-widest"
                  />
                  <p className="text-xs text-muted-foreground/80">
                    配对码采用 PBKDF2-SHA256 + AES-256-GCM 加密，仅凭二维码无法反解，需在新设备输入同一 6 位 PIN。
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
                    生成同步二维码
                  </DsButton>

                  <DsButton
                    variant="outline"
                    size="sm"
                    disabled={busy || !(cloud || llm || prefs)}
                    onClick={() => handleGenerateQr(false)}
                    title="自动生成 6 位随机 PIN 并立即生成二维码"
                  >
                    <Sparkle size={14} className="mr-1.5" />
                    一键随机 PIN 生成二维码
                  </DsButton>

                  {onRunSync && cloudConfigured && (
                    <DsButton
                      variant="outline"
                      size="sm"
                      disabled={busy || !(cloud || llm || prefs)}
                      onClick={() => handleGenerateQr(true)}
                    >
                      <CloudArrowUp size={15} className="mr-1.5" />
                      生成并立即推送本机最新快照
                    </DsButton>
                  )}
                </div>
              </fieldset>

              {/* 右侧：高清 SVG 二维码展示卡片 */}
              {code ? (
                <div
                  className="flex flex-col items-center justify-center rounded-xl bg-background/70 border border-border/35 p-4 space-y-3 min-w-[240px]"
                  data-testid="device-pairing-qr-panel"
                >
                  <div className="rounded-xl bg-white p-2.5 shadow-sm ring-1 ring-black/5">
                    <QrCodeSvg value={code} size={196} margin={3} />
                  </div>
                  {generatedPinDisplay && (
                    <div className="text-center space-y-0.5">
                      <div className="text-2xs text-muted-foreground">配对解密 PIN</div>
                      <div
                        className="font-mono text-lg font-semibold tracking-[0.28em] text-foreground tabular-nums"
                        data-testid="device-pairing-pin-display"
                      >
                        {generatedPinDisplay}
                      </div>
                    </div>
                  )}
                  <div className="w-full space-y-1.5">
                    <label className="block text-2xs text-muted-foreground">
                      加密配对码
                      <textarea
                        aria-label="生成的加密配对码"
                        readOnly
                        value={code}
                        rows={2}
                        className="mt-1 w-full break-all rounded-lg border border-border/40 bg-background p-2 font-mono text-2xs text-muted-foreground"
                      />
                    </label>
                    <div className="flex flex-wrap items-center justify-center gap-1.5">
                      <DsButton
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void work(async () => {
                            if (!(await copyTextToClipboard(code))) {
                              throw new Error('复制失败，请手动复制');
                            }
                            setStatus('配对码已复制');
                          })
                        }
                      >
                        <Copy size={13} className="mr-1" />
                        一键复制
                      </DsButton>
                      <DsButton
                        variant="outline"
                        size="sm"
                        onClick={handleDownloadQrSvg}
                        data-testid="download-pairing-qr-btn"
                      >
                        <DownloadSimple size={13} className="mr-1" />
                        下载二维码
                      </DsButton>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setCode('');
                          setPin('');
                          setGeneratedPinDisplay('');
                        }}
                      >
                        <EyeSlash size={13} className="mr-1" />
                        隐藏并清除
                      </DsButton>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="hidden lg:flex flex-col items-center justify-center rounded-xl border border-dashed border-border/45 bg-background/35 px-6 py-8 text-center w-[240px]">
                  <QrCode size={40} className="text-muted-foreground/40 mb-2" />
                  <p className="text-xs font-medium text-muted-foreground">
                    尚未生成同步二维码
                  </p>
                  <p className="mt-1 text-2xs text-muted-foreground/70 leading-relaxed">
                    输入或随机生成 6 位 PIN 后，点击左侧按钮即可在此展示高清二维码
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* 接收端：扫码 / 导入二维码图片 / 粘贴配对码 */
            <fieldset className="space-y-4" disabled={busy}>
              <legend className="text-sm font-medium text-foreground">
                在新设备扫码或粘贴配对码接入
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
                      停止摄像头扫码
                    </>
                  ) : (
                    <>
                      <Camera size={14} className="mr-1.5" />
                      使用摄像头扫码
                    </>
                  )}
                </DsButton>

                <DsButton
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="import-qr-image-btn"
                >
                  <ImageSquare size={14} className="mr-1.5" />
                  从二维码图片导入
                </DsButton>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/svg+xml,image/png,image/jpeg,image/webp,.svg,.png,.jpg,.jpeg,.webp"
                  className="hidden"
                  aria-label="选择同步二维码图片"
                  onChange={(e) => void handleImportQrImage(e)}
                />
              </div>

              {cameraActive && (
                <div className="rounded-xl border border-border/40 bg-background/70 p-3 space-y-2 max-w-sm">
                  <video
                    ref={videoRef}
                    muted
                    playsInline
                    className="w-full rounded-lg bg-black/90 aspect-square object-cover"
                  />
                  <p className="text-xs text-muted-foreground text-center">
                    请将另一台设备上的同步二维码置于取景框中央
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
                  粘贴 DSPAIR1 配对码（或通过上方扫码自动填入）
                  <textarea
                    value={incoming}
                    onChange={(e) => setIncoming(e.target.value)}
                    rows={3}
                    placeholder="DSPAIR1:..."
                    className="mt-1.5 w-full rounded-xl border border-border/40 bg-background/80 p-2.5 font-mono text-xs text-foreground"
                  />
                </label>

                <div className="space-y-2">
                  <label className="block text-xs font-medium text-muted-foreground space-y-1.5">
                    <span>配对 PIN（6 位数字）</span>
                    <Input
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      placeholder="6 位数字 PIN"
                      value={applyPin}
                      onChange={(e) => setApplyPin(e.target.value.replace(/\D/g, ''))}
                      className="font-mono tabular-nums tracking-widest"
                    />
                  </label>
                  <p className="text-2xs text-muted-foreground/80 leading-relaxed">
                    接入将更新配对码包含的云存储与 AI 配置；技能与插件在下一次云同步时自动下载。
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
                  一键接入配置
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
                    接入并立即拉取云端数据
                  </DsButton>
                )}

                {appliedSuccess && onRunSync && (
                  <DsButton
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => onRunSync('bidirectional')}
                  >
                    <Upload size={14} className="mr-1.5" />
                    立即执行双向云同步
                  </DsButton>
                )}
              </div>
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
          {error && (
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
