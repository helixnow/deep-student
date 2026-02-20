/**
 * 外部搜索设置 Tab 组件
 * 整合所有外部搜索相关设置
 * Notion 风格：简洁、无边框、hover 效果
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { Input } from '../ui/shad/Input';
import { SettingSection } from './SettingsCommon';
import { EngineSettingsSection } from './EngineSettingsSection';
import WebSearchAdvancedConfig from '../WebSearchAdvancedConfig';

/**
 * Sanitise a comma-or-newline-separated domain list:
 *  - split by comma or newline
 *  - trim whitespace
 *  - strip protocol (http:// / https://)
 *  - strip trailing slashes and paths
 *  - remove entries with spaces (invalid domains)
 *  - deduplicate & drop empties
 */
function cleanDomainList(raw: string): string {
  const seen = new Set<string>();
  return raw
    .split(/[,\n]+/)
    .map((s) => {
      let d = s.trim();
      // strip protocol
      d = d.replace(/^https?:\/\//i, '');
      // strip trailing path / slash
      d = d.replace(/\/.*$/, '');
      // remove entries containing spaces (invalid domain)
      if (d.includes(' ')) return '';
      return d;
    })
    .filter((d) => {
      if (!d) return false;
      const key = d.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(', ');
}

// 内部组件：设置行 - Notion 风格（无 icon，与 ModelAssignmentRow 保持一致的结构）
const SettingRow = ({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={cn("group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors overflow-hidden", className)}>
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="w-full sm:w-[280px] flex-shrink-0 [&>div]:w-full [&_button]:w-full flex items-center justify-end sm:justify-start">
      {children}
    </div>
  </div>
);

// 分组标题
const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-8 first:mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

interface ExternalSearchTabProps {
  config: any;
  setConfig: (fn: (prev: any) => any) => void;
}

export const ExternalSearchTab: React.FC<ExternalSearchTabProps> = ({
  config,
  setConfig,
}) => {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="space-y-1 pb-10 text-left animate-in fade-in duration-500">
      <SettingSection 
        title={t('settings:sections.external_search_title')} 
        description={t('settings:sections.external_search_desc')}
        hideHeader
      >
        {/* 1. 搜索引擎配置 */}
        <div className="mt-2">
          <EngineSettingsSection config={config} setConfig={setConfig} />
        </div>

        {/* 2. 高级搜索配置 */}
        <div className="mt-8">
          <GroupTitle title={t('settings:sections.advanced_search_title')} />
          <div className="space-y-px">
            {/* 🔧 修复 #4: 移除 onConfigChange 中的重复通知，各 handler 已自行通知 */}
            <WebSearchAdvancedConfig 
              onConfigChange={() => {
                // 不再发通知，避免与 WebSearchAdvancedConfig 内部通知重复
              }}
            />
          </div>
        </div>

        {/* 3. 注入文本长度配置 */}
        <div className="mt-8">
          <GroupTitle title={t('settings:sections.injection_settings_title')} />
          <div className="space-y-px">
            <SettingRow
              title={t('settings:field_labels.snippet_max_chars')}
              description={t('settings:sections.snippet_truncate_desc')}
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={50}
                  max={2000}
                  value={config.webSearchInjectSnippetMax}
                  onChange={(e) => {
                    const v = parseInt(e.target.value || '180', 10) || 180;
                    setConfig(prev => ({ ...prev, webSearchInjectSnippetMax: Math.min(2000, Math.max(50, v)) }));
                  }}
                  className="!w-24 h-8 text-xs bg-transparent"
                />
                <span className="text-[11px] text-muted-foreground/70">{t('common:units.chars')}</span>
              </div>
            </SettingRow>
            <SettingRow
              title={t('settings:field_labels.total_max_chars')}
              description={t('settings:sections.total_length_limit_desc')}
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={200}
                  max={20000}
                  value={config.webSearchInjectTotalMax}
                  onChange={(e) => {
                    const v = parseInt(e.target.value || '1900', 10) || 1900;
                    setConfig(prev => ({ ...prev, webSearchInjectTotalMax: Math.min(20000, Math.max(200, v)) }));
                  }}
                  className="!w-24 h-8 text-xs bg-transparent"
                />
                <span className="text-[11px] text-muted-foreground/70">{t('common:units.chars')}</span>
              </div>
            </SettingRow>
          </div>
        </div>

        {/* 4. 站点过滤配置 */}
        <div className="mt-8">
          <GroupTitle title={t('settings:sections.site_filter_title')} />
          <p className="px-1 mb-2 text-[11px] text-muted-foreground/70 leading-relaxed">
            {t('settings:placeholders.domain_list_hint')}
          </p>
          <div className="space-y-px">
            <SettingRow
              title={t('settings:field_labels.whitelist_sites')}
              description={t('settings:sections.whitelist_desc')}
            >
              <Input
                type="text"
                value={config.webSearchWhitelist}
                onChange={(e) => setConfig(prev => ({ ...prev, webSearchWhitelist: e.target.value }))}
                onBlur={(e) => {
                  const cleaned = cleanDomainList(e.target.value);
                  if (cleaned !== config.webSearchWhitelist) {
                    setConfig(prev => ({ ...prev, webSearchWhitelist: cleaned }));
                  }
                }}
                placeholder={t('settings:placeholders.whitelist_example')}
                className="h-8 text-xs bg-transparent"
              />
            </SettingRow>
            <SettingRow
              title={t('settings:field_labels.blacklist_sites')}
              description={t('settings:sections.blacklist_desc')}
            >
              <Input
                type="text"
                value={config.webSearchBlacklist}
                onChange={(e) => setConfig(prev => ({ ...prev, webSearchBlacklist: e.target.value }))}
                onBlur={(e) => {
                  const cleaned = cleanDomainList(e.target.value);
                  if (cleaned !== config.webSearchBlacklist) {
                    setConfig(prev => ({ ...prev, webSearchBlacklist: cleaned }));
                  }
                }}
                placeholder={t('settings:placeholders.blacklist_example')}
                className="h-8 text-xs bg-transparent"
              />
            </SettingRow>
          </div>
        </div>
      </SettingSection>
    </div>
  );
};

export default ExternalSearchTab;
