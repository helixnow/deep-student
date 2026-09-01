/**
 * OCR 策略设置区块
 * 简洁风格：简洁、无边框、hover 效果
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, CircleNotch } from '@phosphor-icons/react';
import { SettingRow, SwitchRow, SettingsSlider, GroupTitle } from './settingsTabPrimitives';
import { Switch } from '@/components/ui/shad/Switch';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/lib/utils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// 分组标题

// 子分组标题
const SubGroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-2 mt-6 first:mt-0">
    <h4 className="text-sm font-medium text-foreground/80">{title}</h4>
  </div>
);

// 分组卡片容器：与设置本体一致的圆角灰卡
const GroupCard = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-2xl bg-muted px-3 py-3 sm:px-4">
    <div className="space-y-px">{children}</div>
  </div>
);

// 设置行

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
      showGlobalNotification('success', t('common:config_saved'));
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
      showGlobalNotification('success', t('settings:ocr.reset_success'));
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
        <GroupTitle title={t('settings:ocr.title')} />
        <div className="flex items-center justify-center py-6">
          <CircleNotch size={20} className="animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <GroupTitle 
        title={t('settings:ocr.title')}
        actions={
          <DsButton
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={saving}
            className="gap-1"
          >
            <ArrowCounterClockwise size={12} />
            {t('common:actions.reset')}
          </DsButton>
        }
      />

      {/* 基本设置 */}
      <SubGroupTitle title={t('settings:ocr.general.title')} />
      <GroupCard>
        <SwitchRow
          title={t('settings:ocr.general.enabled')}
          description={t('settings:ocr.general.enabled_desc')}
          checked={config.enabled}
          onCheckedChange={(v) => handleToggle('enabled', 'ocr.enabled', v)}
          disabled={saving}
        />

        <SwitchRow
          title={t('settings:ocr.general.skip_multimodal')}
          description={t('settings:ocr.general.skip_multimodal_desc')}
          checked={config.skipForMultimodal}
          onCheckedChange={(v) => handleToggle('skipForMultimodal', 'ocr.skip_for_multimodal', v)}
          disabled={saving || !config.enabled}
        />
      </GroupCard>

      {/* 图片识别 */}
      <SubGroupTitle title={t('settings:ocr.images.title')} />
      <GroupCard>
        <SwitchRow
          title={t('settings:ocr.images.enabled')}
          description={t('settings:ocr.images.enabled_desc')}
          checked={config.ocrImages}
          onCheckedChange={(v) => handleToggle('ocrImages', 'ocr.images', v)}
          disabled={saving || !config.enabled}
        />
      </GroupCard>

      {/* PDF 识别 */}
      <SubGroupTitle title={t('settings:ocr.pdf.title')} />
      <GroupCard>
        <SwitchRow
          title={t('settings:ocr.pdf.enabled')}
          description={t('settings:ocr.pdf.enabled_desc')}
          checked={config.ocrScannedPdf}
          onCheckedChange={(v) => handleToggle('ocrScannedPdf', 'ocr.scanned_pdf', v)}
          disabled={saving || !config.enabled}
        />

        <SettingRow controlClassName="md:w-[200px]"
          title={t('settings:ocr.pdf.threshold')}
          description={t('settings:ocr.pdf.threshold_desc')}
        >
          <SettingsSlider
            value={config.pdfTextThreshold}
            min={0}
            max={5000}
            step={50}
            onChange={handleThresholdChange}
            disabled={saving || !config.enabled || !config.ocrScannedPdf}
            suffix={` ${t('common:unit.chars', 'chars')}`}
          />
        </SettingRow>
      </GroupCard>

      {/* 说明提示 */}
      <div className="mt-6 py-3 px-1">
        <p className="text-xs text-muted-foreground/60 leading-relaxed">
          {t('settings:ocr.tip')}
        </p>
      </div>
    </div>
  );
};

export default OcrSettingsSection;
