import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { showGlobalNotification } from './UnifiedNotification';
import { getErrorMessage } from '../utils/errorUtils';
import { Switch } from './ui/shad/Switch';
import { Input } from './ui/shad/Input';
import { AppSelect } from './ui/app-menu';
import { Textarea } from './ui/shad/Textarea';

// 内部组件：带开关的设置行 - Notion 风格
const SwitchRow = ({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) => (
  <div className="group flex items-center justify-between gap-4 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors">
    <div className="flex-1 min-w-0">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </div>
);

// 内部组件：设置行 - Notion 风格
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
  <div className={cn("group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors", className)}>
    <div className="flex-1 min-w-0 pt-1.5">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
          {description}
        </p>
      )}
    </div>
    <div className="flex-shrink-0">
      {children}
    </div>
  </div>
);

interface RerankerConfig {
  enabled: boolean;
  top_k?: number;
}

interface CnWhitelistConfig {
  enabled: boolean;
  use_default_list: boolean;
  custom_sites?: string[];
}

// 🔧 修复 #1/#7: Provider 策略相关类型和常量已移除（死代码清理）
// Provider 策略仅由 EngineSettingsSection 管理，避免双重管理覆写风险

interface WebSearchAdvancedConfigProps {
  onConfigChange?: () => void;
}

const clampTopK = (value: number) => Math.min(20, Math.max(3, value));

const WebSearchAdvancedConfigInner: React.FC<WebSearchAdvancedConfigProps> = ({
  onConfigChange,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [loading, setLoading] = useState(true);

  const [rerankerConfig, setRerankerConfig] = useState<RerankerConfig>({
    enabled: false,
    top_k: 10,
  });
  const [topKInput, setTopKInput] = useState('10');
  const [assignedRerankerLabel, setAssignedRerankerLabel] = useState<string>('');
  const [tavilySearchDepth, setTavilySearchDepth] = useState<
    'basic' | 'advanced'
  >('basic');

  const [cnWhitelistConfig, setCnWhitelistConfig] = useState<CnWhitelistConfig>({
    enabled: false,
    use_default_list: true,
    custom_sites: [],
  });
  const [cnDefaultSites, setCnDefaultSites] = useState<string[]>([]);
  const [customSitesDraft, setCustomSitesDraft] = useState('');

  useEffect(() => {
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    try {
      setLoading(true);
      // 🔧 修复 #1/#7: 移除 get_provider_strategies_config 调用（策略仅由 EngineSettingsSection 管理）
      const [cnWhitelistResult, tavilyDepthOpt] =
        await Promise.all([
        invoke<{ default_sites: string[]; user_config: CnWhitelistConfig }>(
          'get_cn_whitelist_config'
        ),
        invoke<string | null>('get_setting', {
          key: 'web_search.tavily.search_depth',
        }).catch(() => null),
      ]);

      const rerankerEnabledOpt = await invoke<string | null>('get_setting', {
        key: 'web_search.reranker.enabled',
      }).catch(() => null);
      const rerankerTopKOpt = await invoke<string | null>('get_setting', {
        key: 'web_search.reranker.top_k',
      }).catch(() => null);

      const enabled = (rerankerEnabledOpt ?? 'false') === 'true';
      const topK = clampTopK(
        parseInt(rerankerTopKOpt ?? `${rerankerConfig.top_k ?? 10}`, 10)
      );
      setRerankerConfig({ enabled, top_k: topK });
      setTopKInput(String(topK));

      setCnWhitelistConfig(cnWhitelistResult.user_config);
      setCnDefaultSites(cnWhitelistResult.default_sites ?? []);
      setCustomSitesDraft(
        (cnWhitelistResult.user_config.custom_sites ?? []).join('\n')
      );

      const depth = (tavilyDepthOpt ?? 'basic').trim().toLowerCase();
      setTavilySearchDepth(depth === 'advanced' ? 'advanced' : 'basic');

      try {
        const assignments = await invoke<{
          reranker_model_config_id?: string | null;
        }>('get_model_assignments');
        const rerankerId = assignments?.reranker_model_config_id;
        if (rerankerId) {
          const apiConfigs = await invoke<any[]>('get_api_configurations');
          const target = (apiConfigs || []).find(
            (config) => config.id === rerankerId
          );
          if (target) {
            setAssignedRerankerLabel(`${target.name} (${target.model})`);
          } else {
            setAssignedRerankerLabel(`ID: ${rerankerId}`);
          }
        } else {
          setAssignedRerankerLabel(
            t('settings:advanced_search.reranker.unassigned', '未配置')
          );
        }
      } catch (error: unknown) {
        setAssignedRerankerLabel(
          t('settings:advanced_search.messages.load_model_failed', '加载失败')
        );
        console.warn('Failed to load reranker assignments', error);
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      showGlobalNotification(
        'error',
        t('settings:advanced_search.messages.load_failed', { error: message })
      );
    } finally {
      setLoading(false);
    }
  };

  const handleRerankerToggle = async (checked: boolean) => {
    const nextConfig = { ...rerankerConfig, enabled: checked };
    try {
      await saveRerankerConfig(nextConfig);
      showGlobalNotification(
        'success',
        t('settings:advanced_search.messages.reranker_saved')
      );
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      showGlobalNotification(
        'error',
        t('settings:advanced_search.messages.save_failed', { error: message })
      );
    }
  };

  const handleRerankerTopKBlur = async () => {
    const parsed = parseInt(topKInput.trim(), 10);
    if (Number.isNaN(parsed)) {
      setTopKInput(String(rerankerConfig.top_k ?? 10));
      return;
    }
    const clamped = clampTopK(parsed);
    if (clamped !== parsed) {
      setTopKInput(String(clamped));
    }
    if (clamped === rerankerConfig.top_k) {
      return;
    }
    const nextConfig = { ...rerankerConfig, top_k: clamped };
    try {
      await saveRerankerConfig(nextConfig);
      showGlobalNotification(
        'success',
        t('settings:advanced_search.messages.reranker_saved')
      );
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      showGlobalNotification(
        'error',
        t('settings:advanced_search.messages.save_failed', { error: message })
      );
      setTopKInput(String(rerankerConfig.top_k ?? 10));
    }
  };

  const handleTavilyDepthChange = async (value: string) => {
    const next = value === 'advanced' ? 'advanced' : 'basic';
    const previous = tavilySearchDepth;
    setTavilySearchDepth(next);
    try {
      await invoke('save_setting', {
        key: 'web_search.tavily.search_depth',
        value: next,
      });
      showGlobalNotification(
        'success',
        t('settings:advanced_search.tavily_depth.saved', '已保存 Tavily 搜索深度设置')
      );
      onConfigChange?.();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      setTavilySearchDepth(previous);
      showGlobalNotification(
        'error',
        t('settings:advanced_search.messages.save_failed', { error: message })
      );
    }
  };

  const saveRerankerConfig = async (config: RerankerConfig) => {
    await Promise.all([
      invoke('save_setting', {
        key: 'web_search.reranker.enabled',
        value: String(config.enabled),
      }),
      invoke('save_setting', {
        key: 'web_search.reranker.top_k',
        value: String(config.top_k ?? 10),
      }),
    ]);
    setRerankerConfig(config);
    onConfigChange?.();
  };

  const saveCnWhitelistConfig = async (config: CnWhitelistConfig) => {
    await Promise.all([
      invoke('save_setting', {
        key: 'web_search.cn_whitelist.enabled',
        value: String(config.enabled),
      }),
      invoke('save_setting', {
        key: 'web_search.cn_whitelist.use_default',
        value: String(config.use_default_list),
      }),
      invoke('save_setting', {
        key: 'web_search.cn_whitelist.custom_sites',
        value: (config.custom_sites ?? []).join(','),
      }),
    ]);
    setCnWhitelistConfig(config);
    onConfigChange?.();
  };

  const handleCnWhitelistToggle = async (checked: boolean) => {
    try {
      await saveCnWhitelistConfig({ ...cnWhitelistConfig, enabled: checked });
      showGlobalNotification(
        'success',
        t('settings:advanced_search.messages.whitelist_saved')
      );
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      showGlobalNotification(
        'error',
        t('settings:advanced_search.messages.save_failed', { error: message })
      );
    }
  };

  const handleCnDefaultToggle = async (checked: boolean) => {
    try {
      await saveCnWhitelistConfig({
        ...cnWhitelistConfig,
        use_default_list: checked,
      });
      showGlobalNotification(
        'success',
        t('settings:advanced_search.messages.whitelist_saved')
      );
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      showGlobalNotification(
        'error',
        t('settings:advanced_search.messages.save_failed', { error: message })
      );
    }
  };

  const handleCustomSitesBlur = async () => {
    const sites = customSitesDraft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      await saveCnWhitelistConfig({
        ...cnWhitelistConfig,
        custom_sites: sites,
      });
      showGlobalNotification(
        'success',
        t('settings:advanced_search.messages.whitelist_saved')
      );
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      showGlobalNotification(
        'error',
        t('settings:advanced_search.messages.save_failed', { error: message })
      );
    }
  };

  // 🔧 修复 #1/#7: 移除 handleStrategyPatch, handleStrategyNumberChange, handleStrategySave, providerList 死代码
  // Provider 策略编辑和保存已统一由 EngineSettingsSection 负责

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-muted-foreground/70">
        <RefreshCw className="mr-2 h-3 w-3 animate-spin" />
        {t('common:loading', '加载中…')}
      </div>
    );
  }

  return (
    <div className="space-y-px">
      {/* 搜索结果重排器 */}
      <SwitchRow
        title={t('settings:advanced_search.reranker.title')}
        description={t('settings:advanced_search.reranker.description')}
        checked={rerankerConfig.enabled}
        onCheckedChange={handleRerankerToggle}
      />
      {rerankerConfig.enabled && (
        <div className="ml-1 pl-3 border-l-2 border-border/30 space-y-px animate-in slide-in-from-top-2 duration-200">
          <SettingRow
            title={t('settings:advanced_search.reranker.current_model')}
            description={t('settings:advanced_search.reranker.model_hint')}
          >
            <div className="px-3 py-1.5 rounded-md bg-muted/50 text-xs text-foreground/80 truncate">
              {assignedRerankerLabel ||
                t('settings:advanced_search.reranker.unassigned', '未配置')}
            </div>
          </SettingRow>
          <SettingRow
            title={t('settings:advanced_search.reranker.top_k_label')}
            description={t('settings:advanced_search.reranker.top_k_hint')}
          >
            <Input
              type="number"
              min={3}
              max={20}
              step={1}
              value={topKInput}
              onChange={(event) => setTopKInput(event.target.value)}
              onBlur={handleRerankerTopKBlur}
              className="!w-20 h-8 text-xs bg-transparent"
            />
          </SettingRow>
        </div>
      )}

      {/* Tavily 搜索深度 */}
      <SettingRow
        title={t('settings:advanced_search.tavily_depth.title', 'Tavily 搜索深度')}
        description={t('settings:advanced_search.tavily_depth.description', '仅影响 Tavily 搜索，advanced 可获取更深入的结果。')}
      >
        <AppSelect value={tavilySearchDepth} onValueChange={handleTavilyDepthChange}
          options={[
            { value: 'basic', label: t('settings:advanced_search.tavily_depth.basic_label', 'Basic') },
            { value: 'advanced', label: t('settings:advanced_search.tavily_depth.advanced_label', 'Advanced') },
          ]}
          size="sm"
          variant="ghost"
          className="h-8 text-xs bg-transparent hover:bg-muted/20 transition-colors"
          width={100}
        />
      </SettingRow>

      {/* 中文可信站点模板 */}
      <SwitchRow
        title={t('settings:advanced_search.whitelist.title')}
        description={t('settings:advanced_search.whitelist.description')}
        checked={cnWhitelistConfig.enabled}
        onCheckedChange={handleCnWhitelistToggle}
      />
      {cnWhitelistConfig.enabled && (
        <div className="ml-1 pl-3 border-l-2 border-border/30 space-y-2 animate-in slide-in-from-top-2 duration-200">
          {/* 使用默认列表开关 */}
          <SwitchRow
            title={t('settings:advanced_search.whitelist.use_default_label')}
            description={t('settings:advanced_search.whitelist.use_default_hint', { count: cnDefaultSites.length })}
            checked={cnWhitelistConfig.use_default_list}
            onCheckedChange={handleCnDefaultToggle}
          />

          {/* 默认站点预览 */}
          {cnWhitelistConfig.use_default_list && cnDefaultSites.length > 0 && (
            <div className="px-3 py-2 rounded-md bg-muted/30">
              <p className="text-[11px] font-medium text-foreground/80 mb-1.5">
                {t('settings:advanced_search.whitelist.default_preview_title')}
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground/70 md:grid-cols-3">
                {cnDefaultSites.slice(0, 9).map((site) => (
                  <span key={site}>• {site}</span>
                ))}
              </div>
              {cnDefaultSites.length > 9 && (
                <p className="mt-1.5 text-[11px] text-muted-foreground/60">
                  {t('settings:advanced_search.whitelist.default_preview_more', {
                    count: cnDefaultSites.length - 9,
                  })}
                </p>
              )}
            </div>
          )}

          {/* 自定义站点 */}
          <div className="py-2.5 px-1">
            <label className="text-xs font-medium text-foreground/80 block mb-1.5">
              {t('settings:advanced_search.whitelist.custom_label')}
            </label>
            <Textarea
              rows={3}
              value={customSitesDraft}
              onChange={(event) => setCustomSitesDraft(event.target.value)}
              onBlur={handleCustomSitesBlur}
              placeholder={t('settings:advanced_search.whitelist.custom_placeholder')}
              className="text-xs bg-transparent resize-none"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default WebSearchAdvancedConfigInner;
