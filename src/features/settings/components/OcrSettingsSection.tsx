/**
 * OCR 策略设置区块
 * Notion 风格：简洁、无边框、hover 效果
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, CircleNotch } from '@phosphor-icons/react';
import { Switch } from '@/components/ui/shad/Switch';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/lib/utils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// 分组标题
const GroupTitle = ({ title, rightSlot }: { title: string; rightSlot?: React.ReactNode }) => (
  <div className="px-1 mb-3 mt-0 flex items-center justify-between">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
    {rightSlot}
  </div>
);

// 子分组标题
const SubGroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-2 mt-6 first:mt-0">
    <h4 className="text-sm font-medium text-foreground/80">{title}</h4>
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
  <div className="group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 rounded overflow-hidden">
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="w-[200px] flex-shrink-0">
      {children}
    </div>
  </div>
);

// 带开关的设置行
const SwitchRow = ({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) => (
  <div className="group flex items-center justify-between gap-4 py-2.5 px-1 rounded">
    <div className="flex-1 min-w-0">
      <h3 className={cn("text-sm leading-tight", disabled ? "text-muted-foreground/50" : "text-foreground/90")}>{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
  </div>
);

/** OCR 策略配置接口 */
interface OcrStrategyConfig {
  enabled: boolean;
  skipForMultimodal: boolean;
  pdfTextThreshold: number;
  ocrImages: boolean;
  ocrScannedPdf: boolean;
}

/** 
 * 默认配置 
 * ★ 2026-01 修复：skipForMultimodal 默认改为 false
 * 确保总是执行 OCR，保证文本索引有内容（用于 RAG 检索和文本模型注入）
 */
const DEFAULT_CONFIG: OcrStrategyConfig = {
  enabled: true,
  skipForMultimodal: false,
  pdfTextThreshold: 100,
  ocrImages: true,
  ocrScannedPdf: true,
};

/** 滑块组件 - 紧凑版 */
const Slider: React.FC<{
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  showValue?: boolean;
  suffix?: string;
}> = ({ value, min, max, step, onChange, disabled, showValue = true, suffix = '' }) => (
  <div className="flex items-center gap-2">
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      disabled={disabled}
      className={cn(
        "flex-1 h-1.5 bg-muted rounded-full appearance-none cursor-pointer accent-primary",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    />
    {showValue && (
      <span className="text-[11px] text-muted-foreground/70 min-w-[3.5rem] text-right">
        {value}{suffix}
      </span>
    )}
  </div>
);

export const OcrSettingsSection: React.FC = () => {
  const { t } = useTranslation(['settings', 'common']);
  const [config, setConfig] = useState<OcrStrategyConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 加载配置（并行读取所有 key）
  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      const getSetting = (key: string) => invoke<string | null>('get_setting', { key }).catch(() => null);

      const [enabled, skipForMultimodal, threshold, ocrImages, ocrScannedPdf] = await Promise.all([
        getSetting('ocr.enabled'),
        getSetting('ocr.skip_for_multimodal'),
        getSetting('ocr.pdf_text_threshold'),
        getSetting('ocr.images'),
        getSetting('ocr.scanned_pdf'),
      ]);

      const parseBool = (v: string | null, fallback: boolean) =>
        v !== null ? v.toLowerCase() === 'true' : fallback;

      const parsedThreshold = threshold !== null ? parseInt(threshold, 10) : NaN;

      setConfig({
        enabled: parseBool(enabled, DEFAULT_CONFIG.enabled),
        skipForMultimodal: parseBool(skipForMultimodal, DEFAULT_CONFIG.skipForMultimodal),
        pdfTextThreshold: !isNaN(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : DEFAULT_CONFIG.pdfTextThreshold,
        ocrImages: parseBool(ocrImages, DEFAULT_CONFIG.ocrImages),
        ocrScannedPdf: parseBool(ocrScannedPdf, DEFAULT_CONFIG.ocrScannedPdf),
      });
    } catch (error: unknown) {
      console.error('加载 OCR 配置失败:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // 保存单个设置（抛出异常以便调用方回滚）
  const saveSetting = useCallback(async (key: string, value: string) => {
    try {
      setSaving(true);
      await invoke('save_setting', { key, value });
      showGlobalNotification('success', t('common:config_saved', '配置已保存'));
    } finally {
      setSaving(false);
    }
  }, [t]);

  // 处理开关变更（乐观更新 + 失败回滚）
  const handleToggle = useCallback(async (key: keyof OcrStrategyConfig, settingKey: string, value: boolean) => {
    // 🔧 R2-8: 主开关关闭时不允许修改子开关
    if (key !== 'enabled' && !config.enabled) return;
    const oldValue = config[key];
    setConfig(prev => ({ ...prev, [key]: value }));
    try {
      await saveSetting(settingKey, String(value));
    } catch (err: unknown) {
      // Rollback on failure
      setConfig(prev => ({ ...prev, [key]: oldValue }));
      debugLog.error('[OcrSettings] Failed to save setting:', err);
      showGlobalNotification('error', t('settings:ocr.saveFailed', 'Failed to save setting'));
    }
  }, [saveSetting, config, t]);

  // 处理阈值变更（乐观更新 + 失败回滚）
  const handleThresholdChange = useCallback(async (value: number) => {
    if (!config.enabled) return;
    // 🔧 R1-9: clamp 上限与滑块 max(5000) 保持一致
    const clamped = Math.max(0, Math.min(5000, Math.floor(value)));
    const oldValue = config.pdfTextThreshold;
    setConfig(prev => ({ ...prev, pdfTextThreshold: clamped }));
    try {
      await saveSetting('ocr.pdf_text_threshold', String(clamped));
    } catch (err: unknown) {
      // Rollback on failure
      setConfig(prev => ({ ...prev, pdfTextThreshold: oldValue }));
      debugLog.error('[OcrSettings] Failed to save threshold:', err);
      showGlobalNotification('error', t('settings:ocr.saveFailed', 'Failed to save setting'));
    }
  }, [saveSetting, config.enabled, config.pdfTextThreshold, t]);

  // 重置为默认值（并行写入所有 key）
  const handleReset = useCallback(async () => {
    try {
      setSaving(true);
      const save = (key: string, value: string) => invoke('save_setting', { key, value });
      await Promise.all([
        save('ocr.enabled', 'true'),
        save('ocr.skip_for_multimodal', 'false'),
        save('ocr.pdf_text_threshold', '100'),
        save('ocr.images', 'true'),
        save('ocr.scanned_pdf', 'true'),
      ]);
      setConfig(DEFAULT_CONFIG);
      showGlobalNotification('success', t('settings:ocr.reset_success', '设置已重置为默认值'));
    } catch (error: unknown) {
      console.error('重置设置失败:', error);
      showGlobalNotification('error', t('common:messages.error.update_failed', { error: String(error) }));
    } finally {
      setSaving(false);
    }
  }, [t]);

  if (loading) {
    return (
      <div>
        <GroupTitle title={t('settings:ocr.title', 'OCR 识别设置')} />
        <div className="flex items-center justify-center py-6">
          <CircleNotch size={20} className="animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <GroupTitle 
        title={t('settings:ocr.title', 'OCR 识别设置')}
        rightSlot={
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={saving}
            className="gap-1"
          >
            <ArrowCounterClockwise size={12} />
            {t('common:actions.reset', '重置')}
          </NotionButton>
        }
      />

      {/* 基本设置 */}
      <SubGroupTitle title={t('settings:ocr.general.title', '基本设置')} />
      <div className="space-y-px">
        <SwitchRow
          title={t('settings:ocr.general.enabled', '启用自动 OCR')}
          description={t('settings:ocr.general.enabled_desc', '上传图片或扫描版 PDF 时自动进行文字识别')}
          checked={config.enabled}
          onCheckedChange={(v) => handleToggle('enabled', 'ocr.enabled', v)}
          disabled={saving}
        />

        <SwitchRow
          title={t('settings:ocr.general.skip_multimodal', '多模态模型跳过 OCR')}
          description={t('settings:ocr.general.skip_multimodal_desc', '当前聊天模型支持图片理解时，跳过 OCR')}
          checked={config.skipForMultimodal}
          onCheckedChange={(v) => handleToggle('skipForMultimodal', 'ocr.skip_for_multimodal', v)}
          disabled={saving || !config.enabled}
        />
      </div>

      {/* 图片识别 */}
      <SubGroupTitle title={t('settings:ocr.images.title', '图片识别')} />
      <div className="space-y-px">
        <SwitchRow
          title={t('settings:ocr.images.enabled', '图片自动 OCR')}
          description={t('settings:ocr.images.enabled_desc', '上传图片时自动进行文字识别')}
          checked={config.ocrImages}
          onCheckedChange={(v) => handleToggle('ocrImages', 'ocr.images', v)}
          disabled={saving || !config.enabled}
        />
      </div>

      {/* PDF 识别 */}
      <SubGroupTitle title={t('settings:ocr.pdf.title', 'PDF 识别')} />
      <div className="space-y-px">
        <SwitchRow
          title={t('settings:ocr.pdf.enabled', '扫描版 PDF 自动 OCR')}
          description={t('settings:ocr.pdf.enabled_desc', '当 PDF 提取的文本少于阈值时，自动进行多页 OCR')}
          checked={config.ocrScannedPdf}
          onCheckedChange={(v) => handleToggle('ocrScannedPdf', 'ocr.scanned_pdf', v)}
          disabled={saving || !config.enabled}
        />

        <SettingRow
          title={t('settings:ocr.pdf.threshold', 'PDF 文本阈值')}
          description={t('settings:ocr.pdf.threshold_desc', '提取的文本字符数少于此值时，触发 OCR')}
        >
          <Slider
            value={config.pdfTextThreshold}
            min={0}
            max={5000}
            step={50}
            onChange={handleThresholdChange}
            disabled={saving || !config.enabled || !config.ocrScannedPdf}
            suffix={` ${t('common:unit.chars', 'chars')}`}
          />
        </SettingRow>
      </div>

      {/* 说明提示 */}
      <div className="mt-6 py-3 px-1">
        <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
          {t('settings:ocr.tip', 'OCR 会使用配置的 OCR 模型进行文字识别。对于多页 PDF，会逐页进行识别并支持断点续传。')}
        </p>
      </div>
    </div>
  );
};

export default OcrSettingsSection;
