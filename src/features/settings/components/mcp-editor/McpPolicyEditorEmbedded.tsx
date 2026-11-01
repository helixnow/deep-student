import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { saveSetting } from '@/utils/settingsApi';
import type { UseMcpEditorSectionDeps } from '../hookDepsTypes';
import { invoke } from './runtime';
import type { McpPolicyModalState } from './types';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/** 移动端嵌入式 MCP 策略编辑器的渲染所需的 useMcpEditorSection 作用域值 */
export interface McpPolicyEditorEmbeddedContext {
  setConfig: UseMcpEditorSectionDeps['setConfig'];
  isSmallScreen: boolean;
  t: UseMcpEditorSectionDeps['t'];
  closeRightPanel: () => void;
  mcpPolicySaveRef: MutableRefObject<(() => Promise<void>) | null>;
  mcpPolicyModal: McpPolicyModalState;
  setMcpPolicyModal: Dispatch<SetStateAction<McpPolicyModalState>>;
}

export function renderMcpPolicyEditorEmbedded({
  setConfig, isSmallScreen, t, closeRightPanel, mcpPolicySaveRef, mcpPolicyModal, setMcpPolicyModal,
}: McpPolicyEditorEmbeddedContext) {
  if (!mcpPolicyModal.open) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <p className="text-sm">{t('settings:sections.select_policy_to_edit')}</p>
      </div>
    );
  }

  const handleClose = () => {
    setMcpPolicyModal(prev => ({ ...prev, open: false }));
    closeRightPanel();
  };

  const handleSave = async () => {
    const nextPolicy = {
      mcpAdvertiseAll: mcpPolicyModal.advertiseAll,
      mcpWhitelist: mcpPolicyModal.whitelist,
      mcpBlacklist: mcpPolicyModal.blacklist,
      mcpTimeoutMs: mcpPolicyModal.timeoutMs,
      mcpRateLimit: mcpPolicyModal.rateLimit,
      mcpCacheMax: mcpPolicyModal.cacheMax,
      mcpCacheTtlMs: mcpPolicyModal.cacheTtlMs,
    };
    try {
      if (invoke) {
        await Promise.all([
          saveSetting('mcp.tools.advertise_all_tools', mcpPolicyModal.advertiseAll.toString()),
          saveSetting('mcp.tools.whitelist', mcpPolicyModal.whitelist),
          saveSetting('mcp.tools.blacklist', mcpPolicyModal.blacklist),
          saveSetting('mcp.performance.timeout_ms', String(mcpPolicyModal.timeoutMs)),
          saveSetting('mcp.performance.rate_limit_per_second', String(mcpPolicyModal.rateLimit)),
          saveSetting('mcp.performance.cache_max_size', String(mcpPolicyModal.cacheMax)),
          saveSetting('mcp.performance.cache_ttl_ms', String(mcpPolicyModal.cacheTtlMs)),
        ]);
      }
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      console.error('保存MCP安全策略失败:', err);
      showGlobalNotification('error', t('settings:mcp_descriptions.policy_save_failed', { error: errorMessage }));
      return;
    }
    setConfig(prev => ({ ...prev, ...nextPolicy }));
    showGlobalNotification('success', t('settings:mcp_descriptions.policy_saved'));
    handleClose();
  };

  // 移动端保存出口上收统一顶栏（P1-7 同模型编辑器）：顶栏 Check 经此 ref 触发提交
  mcpPolicySaveRef.current = handleSave;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background [&_input]:min-h-11"
      style={{
        paddingBottom: 'var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))',
      }}
    >
      <CustomScrollArea className="min-h-0 flex-1" viewportClassName="px-4 py-4">
        <div className="space-y-4">
          {/* 广告所有工具 */}
          <div className="flex items-center gap-2 [@media(pointer:coarse)]:min-h-11">
            <Checkbox
              id="advertiseAll"
              checked={mcpPolicyModal.advertiseAll}
              onCheckedChange={(checked) => setMcpPolicyModal(prev => ({ ...prev, advertiseAll: checked === true }))}
              className="relative [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3.5"
            />
            <label htmlFor="advertiseAll" className="flex items-center text-sm font-medium cursor-pointer [@media(pointer:coarse)]:min-h-11">
              {t('settings:sections.advertise_all')}
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('settings:mcp_descriptions.advertise_all_hint')}
          </p>

          {/* 白名单 */}
          {!mcpPolicyModal.advertiseAll && (
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.whitelist_label')}</label>
              <Input
                value={mcpPolicyModal.whitelist}
                onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, whitelist: e.target.value }))}
                placeholder="read_file, write_file, list_directory"
              />
            </div>
          )}

          {/* 黑名单 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings:mcp_descriptions.blacklist_label')}</label>
            <Input
              value={mcpPolicyModal.blacklist}
              onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, blacklist: e.target.value }))}
              placeholder="delete_file, execute_command, rm, sudo"
            />
          </div>

          {/* 性能参数（<sm 单列，避免 400px 标签换行挤压） */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.timeout_label')}</label>
              <Input
                type="number"
                min={1000}
                value={mcpPolicyModal.timeoutMs}
                onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, timeoutMs: parseInt(e.target.value || '0', 10) || 15000 }))}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.rate_limit_label')}</label>
              <Input
                type="number"
                min={1}
                value={mcpPolicyModal.rateLimit}
                onChange={(e) => setMcpPolicyModal(prev => ({ ...prev, rateLimit: parseInt(e.target.value || '0', 10) || 10 }))}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.cache_max_label')}</label>
              <Input
                type="number"
                min={0}
                value={mcpPolicyModal.cacheMax}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  setMcpPolicyModal(prev => ({
                    ...prev,
                    cacheMax: Number.isFinite(parsed) ? Math.max(0, parsed) : 100,
                  }));
                }}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.cache_ttl_label')}</label>
              <Input
                type="number"
                min={0}
                value={mcpPolicyModal.cacheTtlMs}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  setMcpPolicyModal(prev => ({
                    ...prev,
                    cacheTtlMs: Number.isFinite(parsed) ? Math.max(0, parsed) : 300000,
                  }));
                }}
              />
            </div>
          </div>
        </div>
      </CustomScrollArea>

      {/* 移动端：保存唯一出口在统一顶栏 Check（P1-7），底栏不再重复；桌面右侧面板保留 */}
      {!isSmallScreen && (
      <div className="flex flex-shrink-0 gap-2 border-t border-border px-4 py-3">
        <DsButton variant="ghost" onClick={handleClose} className="min-h-11 flex-1">{t('common:actions.cancel')}</DsButton>
        <DsButton variant="primary" onClick={handleSave} className="min-h-11 flex-1">{t('common:actions.save')}</DsButton>
      </div>
      )}
    </div>
  );
}
