/**
 * PDF 阅读器设置区块
 * 简洁风格：简洁、无边框、hover 效果
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise } from '@phosphor-icons/react';
import { SettingRow, SwitchRow, SettingsSlider, GroupTitle } from './settingsTabPrimitives';
import { Switch } from '@/components/ui/shad/Switch';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { usePdfSettingsStore } from '@/features/pdf/stores/pdfSettingsStore';
import { cn } from '@/lib/utils';
import { AppSelect } from '@/components/ui/app-menu';

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
        actions={
          <DsButton
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="gap-1 [@media(pointer:coarse)]:!min-h-11"
          >
            <ArrowCounterClockwise size={12} />
            {t('common:actions.reset')}
          </DsButton>
        }
      />

      {/* 渲染性能 */}
      <SubGroupTitle title={t('settings:pdf.performance.title')} />
      <GroupCard>
        <SettingRow controlClassName="md:w-[200px]"
          title={t('settings:pdf.performance.maxDpr')}
          description={t('settings:pdf.performance.maxDprDesc')}
        >
          <SettingsSlider
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
          <SettingRow controlClassName="md:w-[200px]"
            title={t('settings:pdf.performance.scrollDpr')}
            description={t('settings:pdf.performance.scrollDprDesc')}
          >
            <SettingsSlider
              value={settings.scrollDpr}
              min={0.5}
              max={2.0}
              step={0.5}
              onChange={(v) => updateSetting('scrollDpr', v)}
            />
          </SettingRow>
        )}

        <SettingRow controlClassName="md:w-[200px]"
          title={t('settings:pdf.performance.overscan')}
          description={t('settings:pdf.performance.overscanDesc')}
        >
          <SettingsSlider
            value={settings.virtualizerOverscan}
            min={1}
            max={6}
            step={1}
            onChange={(v) => updateSetting('virtualizerOverscan', v)}
          />
        </SettingRow>
      </GroupCard>

      {/* 文本层 */}
      <SubGroupTitle title={t('settings:pdf.textLayer.title')} />
      <GroupCard>
        <SwitchRow
          title={t('settings:pdf.textLayer.enable')}
          description={t('settings:pdf.textLayer.enableDesc')}
          checked={settings.enableTextLayerByDefault}
          onCheckedChange={(v) => updateSetting('enableTextLayerByDefault', v)}
        />

        <SettingRow controlClassName="md:w-[200px]"
          title={t('settings:pdf.textLayer.range')}
          description={t('settings:pdf.textLayer.rangeDesc')}
        >
          <SettingsSlider
            value={settings.textLayerRange}
            min={0}
            max={5}
            step={1}
            onChange={(v) => updateSetting('textLayerRange', v)}
            suffix={t('settings:pdf.pages')}
          />
        </SettingRow>
      </GroupCard>

      {/* 批注层 */}
      <SubGroupTitle title={t('settings:pdf.annotationLayer.title')} />
      <GroupCard>
        <SwitchRow
          title={t('settings:pdf.annotationLayer.enable')}
          description={t('settings:pdf.annotationLayer.enableDesc')}
          checked={settings.enableAnnotationLayerByDefault}
          onCheckedChange={(v) => updateSetting('enableAnnotationLayerByDefault', v)}
        />

        <SettingRow controlClassName="md:w-[200px]"
          title={t('settings:pdf.annotationLayer.range')}
          description={t('settings:pdf.annotationLayer.rangeDesc')}
        >
          <SettingsSlider
            value={settings.annotationLayerRange}
            min={0}
            max={5}
            step={1}
            onChange={(v) => updateSetting('annotationLayerRange', v)}
            suffix={t('settings:pdf.pages')}
          />
        </SettingRow>
      </GroupCard>

      {/* 缩略图 */}
      <SubGroupTitle title={t('settings:pdf.thumbnail.title')} />
      <GroupCard>
        <SettingRow controlClassName="md:w-[200px]"
          title={t('settings:pdf.thumbnail.width')}
          description={t('settings:pdf.thumbnail.widthDesc')}
        >
          <SettingsSlider
            value={settings.thumbnailWidth}
            min={60}
            max={160}
            step={20}
            onChange={(v) => updateSetting('thumbnailWidth', v)}
            suffix="px"
          />
        </SettingRow>

        <SettingRow controlClassName="md:w-[200px]"
          title={t('settings:pdf.thumbnail.dpr')}
          description={t('settings:pdf.thumbnail.dprDesc')}
        >
          <SettingsSlider
            value={settings.thumbnailDpr}
            min={0.5}
            max={2.0}
            step={0.5}
            onChange={(v) => updateSetting('thumbnailDpr', v)}
          />
        </SettingRow>
      </GroupCard>

      {/* 默认视图 */}
      <SubGroupTitle title={t('settings:pdf.defaultView.title')} />
      <GroupCard>
        <SettingRow controlClassName="md:w-[200px]"
          title={t('settings:pdf.defaultView.scale')}
          description={t('settings:pdf.defaultView.scaleDesc')}
        >
          <SettingsSlider
            value={settings.defaultScale}
            min={0.5}
            max={2.0}
            step={0.25}
            onChange={(v) => updateSetting('defaultScale', v)}
            suffix="x"
          />
        </SettingRow>

        <SettingRow controlClassName="md:w-[200px]"
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
            className="bg-transparent hover:bg-[var(--interactive-hover)] transition-colors [@media(pointer:coarse)]:!h-11"
            width={80}
          />
        </SettingRow>
      </GroupCard>
    </div>
  );
};

export default PdfSettingsSection;

