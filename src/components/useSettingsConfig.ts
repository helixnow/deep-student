// @ts-nocheck
import { useCallback } from 'react';
import { ApiConfig, ModelAssignments } from '../types';
import { showGlobalNotification } from './UnifiedNotification';
import { getErrorMessage } from '../utils/errorUtils';
import { debugLog } from '../debug-panel/debugMasterSwitch';
import { normalizeMcpToolList } from './settings/mcpUtils';
import { DEFAULT_STDIO_ARGS, DEFAULT_STDIO_ARGS_STORAGE } from './settings/constants';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { ThemeMode, ThemePalette } from '../hooks/useTheme';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;
const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
const invoke = isTauri ? tauriInvoke : null;

const normalizeThemeMode = (value: unknown): ThemeMode => {
  if (value === 'dark' || value === 'auto') return value;
  return 'light';
};

export function useSettingsConfig(deps: any) {
  const { setLoading, setExtra, setActiveTab, activeTab, modelAssignments, vendors, modelProfiles, resolvedApiConfigs, refreshVendors, refreshProfiles, refreshApiConfigsFromBackend, persistAssignments, saving, setSaving, t, config, setConfig, loading, updateIndicatorRaf } = deps;

const normalizeThemePalette = (value: unknown): ThemePalette => {
  if (value === 'colorsafe' || value === 'accessible') return 'muted';
  const validPalettes: ThemePalette[] = ['default', 'purple', 'green', 'orange', 'pink', 'teal', 'muted', 'paper', 'custom'];
  if (validPalettes.includes(value as ThemePalette)) return value as ThemePalette;
  return 'default';
};

  const loadConfig = async () => {
    setLoading(true);
    try {
      if (invoke) {
        // 使用新的专用API配置管理命令
        const results = await Promise.all([
          invoke('get_api_configurations').catch(() => []) as Promise<ApiConfig[]>,
          invoke('get_model_assignments').catch(() => ({
            model2_config_id: null,
            anki_card_model_config_id: null,
            qbank_ai_grading_model_config_id: null,
            reranker_model_config_id: null,
            exam_sheet_ocr_model_config_id: null,
            translation_model_config_id: null,
            chat_title_model_config_id: null,
            // 多模态知识库模型（嵌入模型通过维度管理设置）
            vl_reranker_model_config_id: null,
            memory_decision_model_config_id: null,
          })) as Promise<{
            model2_config_id: string | null,
            anki_card_model_config_id: string | null,
            qbank_ai_grading_model_config_id: string | null,
            reranker_model_config_id: string | null,
            exam_sheet_ocr_model_config_id: string | null,
            translation_model_config_id: string | null,
            chat_title_model_config_id: string | null,
            // 多模态知识库模型（嵌入模型通过维度管理设置）
            vl_reranker_model_config_id: string | null,
            memory_decision_model_config_id: string | null,
          }>,
          invoke('get_setting', { key: 'auto_save' }).catch(() => 'true') as Promise<string>,
          invoke('get_setting', { key: 'theme' }).catch(() => 'light') as Promise<string>,
          invoke('get_setting', { key: 'theme_palette' }).catch(() => 'default') as Promise<string>,
          invoke('get_setting', { key: 'debug_mode' }).catch(() => 'false') as Promise<string>,
          invoke('get_setting', { key: 'rag_enabled' }).catch(() => 'false') as Promise<string>,
          invoke('get_setting', { key: 'rag_top_k' }).catch(() => '5') as Promise<string>,
          invoke('get_setting', { key: 'anki_connect_enabled' }).catch(() => 'false') as Promise<string>,

          // MCP 工具协议设置（移除全局启用项）
          invoke('get_setting', { key: 'mcp.transport.command' }).catch(() => 'npx') as Promise<string>,
          invoke('get_setting', { key: 'mcp.transport.args' }).catch(() => DEFAULT_STDIO_ARGS_STORAGE) as Promise<string>,
          invoke('get_setting', { key: 'mcp.transport.type' }).catch(() => 'stdio') as Promise<string>,
          invoke('get_setting', { key: 'mcp.transport.url' }).catch(() => 'ws://localhost:8000') as Promise<string>,
          invoke('get_setting', { key: 'mcp.tools.advertise_all_tools' }).catch(() => 'false') as Promise<string>,
          invoke('get_setting', { key: 'mcp.tools.whitelist' }).catch(() => 'read_file, write_file, list_directory') as Promise<string>,
          invoke('get_setting', { key: 'mcp.tools.blacklist' }).catch(() => 'delete_file, execute_command, rm, sudo') as Promise<string>,
          // 多工具配置（JSON）
          invoke('get_setting', { key: 'mcp.tools.list' }).catch(() => '[]') as Promise<string>,
          invoke('get_setting', { key: 'mcp.performance.timeout_ms' }).catch(() => '15000') as Promise<string>,
          invoke('get_setting', { key: 'mcp.performance.rate_limit_per_second' }).catch(() => '10') as Promise<string>,
          invoke('get_setting', { key: 'mcp.performance.cache_max_size' }).catch(() => '500') as Promise<string>,
          invoke('get_setting', { key: 'mcp.performance.cache_ttl_ms' }).catch(() => '300000') as Promise<string>,

          // Web Search 设置（移除全局启用项）
          invoke('get_setting', { key: 'web_search.engine' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.timeout_ms' }).catch(() => '15000') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.google_cse' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.google_cse.cx' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.serpapi' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.tavily' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.brave' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.searxng.endpoint' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.searxng.api_key' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.zhipu' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.api_key.bocha' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.site_whitelist' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.site_blacklist' }).catch(() => '') as Promise<string>,
          invoke('get_setting', { key: 'web_search.inject.snippet_max_chars' }).catch(() => '180') as Promise<string>,
          invoke('get_setting', { key: 'web_search.inject.total_max_chars' }).catch(() => '1900') as Promise<string>,
        ]);

        // 解构赋值
        const [
          apiConfigs, 
          modelAssignments, 
          autoSave, 
          theme, 
          themePaletteSetting,
          debugMode, 
          ragEnabled, 
          ragTopK, 
          ankiConnectEnabled, 

          // MCP 工具协议设置（无全局启用项）
          mcpCommand,
          mcpArgs,
          mcpTransportType,
          mcpUrl,
          mcpAdvertiseAll,
          mcpWhitelist,
          mcpBlacklist,
          mcpToolsJson,
          mcpTimeoutMs,
          mcpRateLimit,
          mcpCacheMax,
          mcpCacheTtlMs,
          // Web Search 设置（无全局启用项）
          webEngine,
          webTimeoutMs,
          webGoogleKey,
          webGoogleCx,
          webSerpKey,
          webTavilyKey,
          webBraveKey,
          webSearxngEndpoint,
          webSearxngKey,
          webZhipuKey,
          webBochaKey,
          webWhitelist,
          webBlacklist,
          webInjectSnippet,
          webInjectTotal,
        ] = results;

        // 处理API配置的字段映射（snake_case to camelCase）
        const mappedApiConfigs = (apiConfigs || []).map((config: any) => ({
          ...config,
          maxOutputTokens: config.maxOutputTokens,
          temperature: config.temperature,
        }));

        const parsedMcpTimeout = (() => {
          const parsed = parseInt(mcpTimeoutMs || '15000', 10);
          return Number.isFinite(parsed) ? parsed : 15000;
        })();
        const parsedMcpRateLimit = (() => {
          const parsed = parseInt(mcpRateLimit || '10', 10);
          return Number.isFinite(parsed) ? parsed : 10;
        })();
        const parsedMcpCacheMax = (() => {
          const parsed = parseInt(mcpCacheMax || '500', 10);
          return Number.isFinite(parsed) ? parsed : 500;
        })();
        const parsedMcpCacheTtl = (() => {
          const parsed = parseInt(mcpCacheTtlMs || '300000', 10);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300000;
        })();

        const parsedMcpTools = (() => {
          try {
            return JSON.parse(mcpToolsJson || '[]');
          } catch {
            return [];
          }
        })();
        const normalizedMcpTools = normalizeMcpToolList(parsedMcpTools);

        const migratedCommandSegments = (() => {
          if (typeof mcpCommand === 'string' && /@modelcontextprotocol\//.test(mcpCommand || '')) {
            const pieces = mcpCommand.split(' ').filter(Boolean);
            if (pieces.length > 1) {
              return pieces;
            }
          }
          return null;
        })();
        const normalizedMcpCommand = (() => {
          if (migratedCommandSegments && migratedCommandSegments.length > 0) {
            return migratedCommandSegments[0];
          }
          if (typeof mcpCommand === 'string' && mcpCommand.trim().length > 0) {
            return mcpCommand.trim();
          }
          return 'npx';
        })();
        const normalizedMcpArgsString = (() => {
          let argsArray: string[] = [];
          if (migratedCommandSegments && migratedCommandSegments.length > 1) {
            argsArray = migratedCommandSegments.slice(1);
          } else if (typeof mcpArgs === 'string' && mcpArgs.trim().length > 0) {
            argsArray = mcpArgs
              .split(',')
              .map(segment => segment.trim())
              .filter(Boolean);
          }
          if (argsArray.length === 0) {
            argsArray = [...DEFAULT_STDIO_ARGS];
          }
          return argsArray.join(',');
        })();

        const newConfig = {
          apiConfigs: mappedApiConfigs,
          model2ConfigId: modelAssignments?.model2_config_id || '',
          ankiCardModelConfigId: modelAssignments?.anki_card_model_config_id || '',
          qbank_ai_grading_model_config_id: modelAssignments?.qbank_ai_grading_model_config_id || '',
          rerankerModelConfigId: modelAssignments?.reranker_model_config_id || '',
          chat_title_model_config_id: modelAssignments?.chat_title_model_config_id || '',
          exam_sheet_ocr_model_config_id: modelAssignments?.exam_sheet_ocr_model_config_id || '',
          translation_model_config_id: modelAssignments?.translation_model_config_id || '',
          // 多模态知识库模型配置（嵌入模型通过维度管理设置）
          vl_reranker_model_config_id: modelAssignments?.vl_reranker_model_config_id || '',
          memory_decision_model_config_id: modelAssignments?.memory_decision_model_config_id || '',
          autoSave: (autoSave || 'true') === 'true',
          theme: normalizeThemeMode(theme),
          themePalette: normalizeThemePalette(themePaletteSetting),
          debugMode: (debugMode || 'false') === 'true',
          ragEnabled: (ragEnabled || 'false') === 'true',
          ragTopK: parseInt(ragTopK || '5', 10),
          ankiConnectEnabled: (ankiConnectEnabled || 'false') === 'true',

          // MCP 工具协议设置（不再设置全局启用项）
          mcpCommand: normalizedMcpCommand,
          mcpTransportType: (mcpTransportType === 'websocket' ? 'websocket' : 'stdio') as 'stdio' | 'websocket',
          mcpUrl: mcpUrl || 'ws://localhost:8000',
          mcpArgs: normalizedMcpArgsString,
          mcpAdvertiseAll: (mcpAdvertiseAll || 'false') === 'true',
          mcpWhitelist: mcpWhitelist || 'read_file, write_file, list_directory',
          mcpBlacklist: mcpBlacklist || 'delete_file, execute_command, rm, sudo',
          mcpTimeoutMs: parsedMcpTimeout,
          mcpRateLimit: parsedMcpRateLimit,
          mcpCacheMax: parsedMcpCacheMax,
          mcpCacheTtlMs: parsedMcpCacheTtl,
          mcpTools: normalizedMcpTools,

          // Web Search 设置（UI 层存储，仅供保存使用）
          // 为保持与其他页面一致，全部使用简单原生控件，不在此定义专门类型
          // 外部搜索设置（不再设置全局启用项）
          webSearchEngine: webEngine || '',
          webSearchTimeoutMs: parseInt(webTimeoutMs || '15000', 10),
          webSearchGoogleKey: webGoogleKey || '',
          webSearchGoogleCx: webGoogleCx || '',
          webSearchSerpApiKey: webSerpKey || '',
          webSearchTavilyKey: webTavilyKey || '',
          webSearchBraveKey: webBraveKey || '',
          webSearchSearxngEndpoint: webSearxngEndpoint || '',
          webSearchSearxngKey: webSearxngKey || '',
          webSearchZhipuKey: webZhipuKey || '',
          webSearchBochaKey: webBochaKey || '',
          webSearchWhitelist: webWhitelist || '',
          webSearchBlacklist: webBlacklist || '',
          webSearchInjectSnippetMax: parseInt(webInjectSnippet || '180', 10) || 180,
          webSearchInjectTotalMax: parseInt(webInjectTotal || '1900', 10) || 1900,
        };
        
        console.log('加载的配置:', {
          apiConfigs: newConfig.apiConfigs.length,
          model2ConfigId: newConfig.model2ConfigId,
          modelAssignments
        });
        
        setConfig(newConfig);

        // 注意：不要用后端存储的 theme/themePalette 覆盖前端 useTheme 的状态
        // useTheme 使用 localStorage 作为主题的 single source of truth
        // 后端存储可能是旧值，会导致从暗色模式意外切换回亮色模式
        // 相反，我们应该将前端的主题状态同步到 config 中（已在 useEffect 中处理）
      } else {
        // 浏览器环境 - 支持从旧键名迁移
        let savedConfig = localStorage.getItem('deep-student-config');
        if (!savedConfig) {
          // 尝试从旧键名迁移
          const oldConfig = localStorage.getItem('ai-mistake-manager-config');
          if (oldConfig) {
            savedConfig = oldConfig;
            // 保存到新键名
            localStorage.setItem('deep-student-config', oldConfig);
            // 删除旧键名
            localStorage.removeItem('ai-mistake-manager-config');
            console.log('✅ 已自动迁移配置从旧键名到新键名');
          }
        }
        if (savedConfig) {
          try {
            const parsed = JSON.parse(savedConfig);
            const normalized = normalizeMcpToolList((parsed as any)?.mcpTools ?? (parsed as any)?.mcpServers);
            setConfig(prev => ({
              ...prev,
              ...parsed,
              theme: normalizeThemeMode((parsed as any)?.theme),
              themePalette: normalizeThemePalette((parsed as any)?.themePalette),
              mcpTools: normalized,
            }));
          } catch (e) {
            console.error('Browser config load failed:', e);
          }
        }
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('Config load failed:', error);
      showGlobalNotification('error', t('settings:mcp.load_config_failed', { error: errorMessage }));
    } finally {
      setLoading(false);
    }
  };
  const handleSave = useCallback(async (silent = false) => {
    setSaving(true);
    try {
      if (invoke) {
        await Promise.all([
          invoke('save_setting', { key: 'auto_save', value: config.autoSave.toString() }),
          invoke('save_setting', { key: 'theme', value: config.theme }),
          invoke('save_setting', { key: 'theme_palette', value: config.themePalette ?? 'default' }),
          invoke('save_setting', { key: 'rag_enabled', value: config.ragEnabled.toString() }),
          invoke('save_setting', { key: 'rag_top_k', value: config.ragTopK.toString() }),
          invoke('save_setting', { key: 'anki_connect_enabled', value: config.ankiConnectEnabled.toString() }),
          invoke('save_setting', { key: 'debug_mode', value: config.debugMode.toString() }),
          // MCP 工具协议设置保存（移除全局启用项）
          invoke('save_setting', { key: 'mcp.transport.type', value: String(config.mcpTransportType || 'stdio') }),
          invoke('save_setting', { key: 'mcp.transport.command', value: config.mcpCommand }),
          invoke('save_setting', { key: 'mcp.transport.args', value: config.mcpArgs }),
          invoke('save_setting', { key: 'mcp.transport.url', value: String(config.mcpUrl || '') }),
          invoke('save_setting', { key: 'mcp.tools.advertise_all_tools', value: config.mcpAdvertiseAll.toString() }),
          invoke('save_setting', { key: 'mcp.tools.whitelist', value: config.mcpWhitelist }),
          invoke('save_setting', { key: 'mcp.tools.blacklist', value: config.mcpBlacklist }),
          invoke('save_setting', { key: 'mcp.performance.timeout_ms', value: String(config.mcpTimeoutMs ?? 15000) }),
          invoke('save_setting', { key: 'mcp.performance.rate_limit_per_second', value: String(config.mcpRateLimit ?? 10) }),
          invoke('save_setting', { key: 'mcp.performance.cache_max_size', value: String(config.mcpCacheMax ?? 500) }),
          invoke('save_setting', { key: 'mcp.performance.cache_ttl_ms', value: String(config.mcpCacheTtlMs ?? 300000) }),
          // 保存多工具配置（过滤掉内置服务器）
          invoke('save_setting', { key: 'mcp.tools.list', value: JSON.stringify((normalizedMcpServers || []).filter((s: any) => s.id !== BUILTIN_SERVER_ID)) }),
          // 强制使用前端SDK模式
          invoke('save_setting', { key: 'mcp.mode', value: 'frontend' }),

          // Web Search 设置保存
          // 外部搜索保存（移除全局启用项）
          invoke('save_setting', { key: 'web_search.engine', value: (config as any).webSearchEngine ?? '' }),
          invoke('save_setting', { key: 'web_search.timeout_ms', value: String((config as any).webSearchTimeoutMs ?? 15000) }),
          invoke('save_setting', { key: 'web_search.api_key.google_cse', value: (config as any).webSearchGoogleKey ?? '' }),
          invoke('save_setting', { key: 'web_search.google_cse.cx', value: (config as any).webSearchGoogleCx ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.serpapi', value: (config as any).webSearchSerpApiKey ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.tavily', value: (config as any).webSearchTavilyKey ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.brave', value: (config as any).webSearchBraveKey ?? '' }),
          invoke('save_setting', { key: 'web_search.searxng.endpoint', value: (config as any).webSearchSearxngEndpoint ?? '' }),
          invoke('save_setting', { key: 'web_search.searxng.api_key', value: (config as any).webSearchSearxngKey ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.zhipu', value: (config as any).webSearchZhipuKey ?? '' }),
          invoke('save_setting', { key: 'web_search.api_key.bocha', value: (config as any).webSearchBochaKey ?? '' }),
          invoke('save_setting', { key: 'web_search.site_whitelist', value: (config as any).webSearchWhitelist ?? '' }),
          invoke('save_setting', { key: 'web_search.site_blacklist', value: (config as any).webSearchBlacklist ?? '' }),
          invoke('save_setting', { key: 'web_search.inject.snippet_max_chars', value: String((config as any).webSearchInjectSnippetMax ?? 180) }),
          invoke('save_setting', { key: 'web_search.inject.total_max_chars', value: String((config as any).webSearchInjectTotalMax ?? 1900) }),
      ]);
        if (!silent) {
          showGlobalNotification('success', t('settings:notifications.config_save_success'));
        }
        
        // 广播：API 配置已变更（仅非静默保存时广播，避免 auto-save 触发自身 refreshApiConfigsFromBackend 形成无限循环）
        if (!silent) {
          try {
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              window.dispatchEvent(new CustomEvent('api_configurations_changed'));
            }
          } catch {}
        }

        // 触发设置变更事件，通知其他组件
        // 静默保存（auto-save）时不标记 mcpChanged，避免每次 auto-save 都触发 MCP bootstrap 全链路
        window.dispatchEvent(new CustomEvent('systemSettingsChanged', { 
          detail: { 
            ankiConnectEnabled: config.ankiConnectEnabled,
            theme: config.theme,
            themePalette: config.themePalette,
            debugMode: config.debugMode,
            mcpChanged: !silent,
          } 
        }));
      } else {
        localStorage.setItem('deep-student-config', JSON.stringify(config));
        if (!silent) {
          showGlobalNotification('success', t('settings:notifications.config_save_success_browser'));
        }
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error('保存配置失败:', error);
      if (silent) {
        showGlobalNotification('warning', t('settings:notifications.silent_save_failed'));
      } else {
        showGlobalNotification('error', t('settings:notifications.config_save_failed', { error: errorMessage }));
      }
    } finally {
      setSaving(false);
    }
  }, [config, invoke]);

  // 仅更新模型分配的某一个字段：读取后端当前 assignments 合并，再保存，避免空字段覆盖。
  const saveSingleAssignmentField = useCallback(
    async (field: keyof ModelAssignments, value: string | null) => {
      const merged: ModelAssignments = { ...modelAssignments, [field]: value };
      try {
        await persistAssignments(merged);
        return merged;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error('Save model assignment failed:', error);
        showGlobalNotification('error', t('settings:mcp.save_model_assignment_failed', { error: errorMessage }));
        throw error;
      }
    },
    [modelAssignments, persistAssignments]
  );

  // 更新标签页切换处理函数，添加动画效果
  const handleTabChange = async (newTab: string) => {
    if (!loading) {
      // 在切换标签页前先保存当前配置
      await handleSave(true);
    }
    setActiveTab(newTab);
    
    // 更新指示器位置
    updateIndicatorRaf(newTab);
  };

  return { loadConfig, handleSave, saveSingleAssignmentField, handleTabChange };
}
