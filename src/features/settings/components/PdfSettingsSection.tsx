/**
 * PDF 阅读器设置区块
 * 简洁风格：简洁、无边框、hover 效果
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise } from '@phosphor-icons/react';
import { Switch } from '@/components/ui/shad/Switch';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { usePdfSettingsStore } from '@/features/pdf/stores/pdfSettingsStore';
import { cn } from '@/lib/utils';
import { AppSelect } from '@/components/ui/app-menu';

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
  // 双栏切换点与 isSmallScreen（<768）对齐，避免 640-767px 移动模式下出现桌面双栏行
  <div className="group flex flex-col md:flex-row md:items-start gap-2 py-2.5 px-1 rounded overflow-hidden">
    <div className="flex-1 min-w-0 pt-1.5 md:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    {/* 移动端占满行宽（提高滑块可用行程），≥md 才收敛为固定列宽 */}
    <div className="w-full md:w-[200px] flex-shrink-0">
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
  // 整行可点切换，开关本体 stopPropagation 避免双重切换
  <div
    className="group flex cursor-pointer items-center justify-between gap-4 py-2.5 px-1 rounded"
    onClick={() => {
      if (!disabled) onCheckedChange(!checked);
    }}
  >
    <div className="flex-1 min-w-0">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </span>
  </div>
);

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
      className="settings-range-slider flex-1 h-1.5 bg-muted rounded-full appearance-none cursor-pointer disabled:opacity-50"
    />
    {showValue && (
      <span className="text-xs text-muted-foreground/70 min-w-[2.5rem] text-right">
        {value}{suffix}
      </span>
    )}
  </div>
);

export const PdfSettingsSection: React.FC = () => {
  const { t } = useTranslation(['settings', 'pdf', 'common']);
  const { settings, updateSetting, resetSettings } = usePdfSettingsStore();

  const handleReset = useCallback(() => {
    resetSettings();
    showGlobalNotification('success', t('settings:pdf.reset_success'));
  }, [resetSettings, t]);

  return (
    <div>
      <GroupTitle 
        title={t('settings:pdf.title')}
        rightSlot={
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleReset}
            className="gap-1"
          >
            <ArrowCounterClockwise size={12} />
            {t('common:actions.reset')}
          </DsButton>
        }
      />

      {/* 渲染性能 */}
      <SubGroupTitle title={t('settings:pdf.performance.title')} />
      <div className="space-y-px">
        <SettingRow
          title={t('settings:pdf.performance.maxDpr')}
          description={t('settings:pdf.performance.maxDprDesc')}
        >
          <Slider
            value={settings.maxDevicePixelRatio}
            min={1.0}
            max={3.0}
            step={0.5}
            onChange={(v) => updateSetting('maxDevicePixelRatio', v)}
          />
        </SettingRow>

        <SwitchRow
          title={t('settings:pdf.performance.scrollDowngrade')}
          description={t('settings:pdf.performance.scrollDowngradeDesc')}
          checked={settings.enableScrollDprDowngrade}
          onCheckedChange={(v) => updateSetting('enableScrollDprDowngrade', v)}
        />

        {settings.enableScrollDprDowngrade && (
          <SettingRow
            title={t('settings:pdf.performance.scrollDpr')}
            description={t('settings:pdf.performance.scrollDprDesc')}
          >
            <Slider
              value={settings.scrollDpr}
              min={0.5}
              max={2.0}
              step={0.5}
              onChange={(v) => updateSetting('scrollDpr', v)}
            />
          </SettingRow>
        )}

        <SettingRow
          title={t('settings:pdf.performance.overscan')}
          description={t('settings:pdf.performance.overscanDesc')}
        >
          <Slider
            value={settings.virtualizerOverscan}
            min={1}
            max={6}
            step={1}
            onChange={(v) => updateSetting('virtualizerOverscan', v)}
          />
        </SettingRow>
      </div>

      {/* 文本层 */}
      <SubGroupTitle title={t('settings:pdf.textLayer.title')} />
      <div className="space-y-px">
        <SwitchRow
          title={t('settings:pdf.textLayer.enable')}
          description={t('settings:pdf.textLayer.enableDesc')}
          checked={settings.enableTextLayerByDefault}
          onCheckedChange={(v) => updateSetting('enableTextLayerByDefault', v)}
        />

        <SettingRow
          title={t('settings:pdf.textLayer.range')}
          description={t('settings:pdf.textLayer.rangeDesc')}
        >
          <Slider
            value={settings.textLayerRange}
            min={0}
            max={5}
            step={1}
            onChange={(v) => updateSetting('textLayerRange', v)}
            suffix={t('settings:pdf.pages')}
          />
        </SettingRow>
      </div>

      {/* 批注层 */}
      <SubGroupTitle title={t('settings:pdf.annotationLayer.title')} />
      <div className="space-y-px">
        <SwitchRow
          title={t('settings:pdf.annotationLayer.enable')}
          description={t('settings:pdf.annotationLayer.enableDesc')}
          checked={settings.enableAnnotationLayerByDefault}
          onCheckedChange={(v) => updateSetting('enableAnnotationLayerByDefault', v)}
        />

        <SettingRow
          title={t('settings:pdf.annotationLayer.range')}
          description={t('settings:pdf.annotationLayer.rangeDesc')}
        >
          <Slider
            value={settings.annotationLayerRange}
            min={0}
            max={5}
            step={1}
            onChange={(v) => updateSetting('annotationLayerRange', v)}
            suffix={t('settings:pdf.pages')}
          />
        </SettingRow>
      </div>

      {/* 缩略图 */}
      <SubGroupTitle title={t('settings:pdf.thumbnail.title')} />
      <div className="space-y-px">
        <SettingRow
          title={t('settings:pdf.thumbnail.width')}
          description={t('settings:pdf.thumbnail.widthDesc')}
        >
          <Slider
            value={settings.thumbnailWidth}
            min={60}
            max={160}
            step={20}
            onChange={(v) => updateSetting('thumbnailWidth', v)}
            suffix="px"
          />
        </SettingRow>

        <SettingRow
          title={t('settings:pdf.thumbnail.dpr')}
          description={t('settings:pdf.thumbnail.dprDesc')}
        >
          <Slider
            value={settings.thumbnailDpr}
            min={0.5}
            max={2.0}
            step={0.5}
            onChange={(v) => updateSetting('thumbnailDpr', v)}
          />
        </SettingRow>
      </div>

      {/* 默认视图 */}
      <SubGroupTitle title={t('settings:pdf.defaultView.title')} />
      <div className="space-y-px">
        <SettingRow
          title={t('settings:pdf.defaultView.scale')}
          description={t('settings:pdf.defaultView.scaleDesc')}
        >
          <Slider
            value={settings.defaultScale}
            min={0.5}
            max={2.0}
            step={0.25}
            onChange={(v) => updateSetting('defaultScale', v)}
            suffix="x"
          />
        </SettingRow>

        <SettingRow
          title={t('settings:pdf.defaultView.mode')}
          description={t('settings:pdf.defaultView.modeDesc')}
        >
          <AppSelect
            value={settings.defaultViewMode}
            onValueChange={(v) => updateSetting('defaultViewMode', v as 'single' | 'dual')}
            options={[
              { value: 'single', label: t('settings:pdf.defaultView.single') },
              { value: 'dual', label: t('settings:pdf.defaultView.dual') },
            ]}
            variant="outline"
            className="bg-transparent hover:bg-[var(--interactive-hover)] transition-colors"
            width={80}
          />
        </SettingRow>
      </div>
    </div>
  );
};

export default PdfSettingsSection;

