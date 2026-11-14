import React from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TFunction } from 'i18next';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { X } from '@phosphor-icons/react';
import { Input } from '@/components/ui/shad/Input';
import { Switch } from '@/components/ui/shad/Switch';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import UnifiedModal from '@/components/UnifiedModal';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { saveSetting } from '@/utils/settingsApi';
import type { McpPolicyModalState } from './mcp-editor/types';
import type { SystemConfig } from './types';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * MCP 全局安全策略模态（桌面端）。
 *
 * 表单状态仍由 useMcpEditorSection 持有（移动端右滑面板复用同一份），
 * 这里只承载桌面弹窗的渲染与保存动作；关闭/保存失败路径与改造前一致。
 */
export function SettingsMcpPolicyDialog({
  open,
  isSmallScreen,
  policy,
  setPolicy,
  invoke,
  setConfig,
  t,
}: {
  open: boolean;
  isSmallScreen: boolean;
  policy: McpPolicyModalState;
  setPolicy: Dispatch<SetStateAction<McpPolicyModalState>>;
  invoke: typeof tauriInvoke | null;
  setConfig: Dispatch<SetStateAction<SystemConfig>>;
  t: TFunction;
}) {
  if (isSmallScreen || !open) return null;

  const handleClose = () => setPolicy(prev => ({ ...prev, open: false }));

  const handleSave = async () => {
    const nextPolicy = {
      mcpAdvertiseAll: policy.advertiseAll,
      mcpWhitelist: policy.whitelist,
      mcpBlacklist: policy.blacklist,
      mcpTimeoutMs: policy.timeoutMs,
      mcpRateLimit: policy.rateLimit,
      mcpCacheMax: policy.cacheMax,
      mcpCacheTtlMs: policy.cacheTtlMs,
    };

    try {
      if (invoke) {
        await Promise.all([
          saveSetting('mcp.tools.advertise_all_tools', policy.advertiseAll.toString()),
          saveSetting('mcp.tools.whitelist', policy.whitelist),
          saveSetting('mcp.tools.blacklist', policy.blacklist),
          saveSetting('mcp.performance.timeout_ms', String(policy.timeoutMs)),
          saveSetting('mcp.performance.rate_limit_per_second', String(policy.rateLimit)),
          saveSetting('mcp.performance.cache_max_size', String(policy.cacheMax)),
          saveSetting('mcp.performance.cache_ttl_ms', String(policy.cacheTtlMs)),
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
    setPolicy(prev => ({ ...prev, open: false }));
  };

  return (
    <UnifiedModal
      isOpen={true}
      onClose={handleClose}
      closeOnOverlayClick={false}
    >
      <div className="ui-rise-in relative mx-auto mt-10 flex min-h-0 max-h-[min(85dvh,720px)] w-[90%] max-w-[500px] flex-col overflow-hidden rounded-[var(--radius-shell-dialog)] bg-popover p-4 text-popover-foreground shadow-lg">
        {/* 头部 */}
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground">{t('settings:mcp.security_policy')}</h3>
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleClose} aria-label={t('settings:a11y.close')} className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11">
            <X size={16} />
          </DsButton>
        </div>
        {/* 矮窗口下限高滚动，避免表单被弹窗限高裁剪后按钮不可达 */}
        <CustomScrollArea
          className="min-h-0 flex-1"
          viewportClassName="pr-1"
          trackOffsetTop={4}
          trackOffsetBottom={4}
        >
          <div className="grid gap-3">
          <label className="inline-flex items-center gap-2 cursor-pointer [@media(pointer:coarse)]:min-h-11">
            <Switch
              checked={policy.advertiseAll}
              onCheckedChange={(checked) => setPolicy(prev => ({ ...prev, advertiseAll: !!checked }))}
            />
            <span className="text-sm">{t('settings:mcp_policy.advertise_all')}</span>
          </label>
          <div className="text-xs text-muted-foreground">
            {t('settings:mcp_policy.whitelist_mode_hint')}
          </div>

          {!policy.advertiseAll && (
            <>
              <label className="text-xs text-foreground">{t('settings:mcp_policy.whitelist_label')}</label>
              <Input
                type="text"
                value={policy.whitelist}
                onChange={(e) => setPolicy(prev => ({ ...prev, whitelist: e.target.value }))}
                placeholder="read_file, write_file, list_directory"
              />
            </>
          )}

          <label className="text-xs text-foreground">{t('settings:mcp_policy.blacklist_label')}</label>
          <Input
            type="text"
            value={policy.blacklist}
            onChange={(e) => setPolicy(prev => ({ ...prev, blacklist: e.target.value }))}
            placeholder="delete_file, execute_command, rm, sudo"
          />
          <div className="text-xs text-muted-foreground">{t('settings:mcp_policy.danger_hint')}</div>

          <div className="two-col-grid">
            <div>
              <label className="text-xs text-foreground">{t('settings:mcp_policy.timeout_label')}</label>
              <Input
                type="number"
                min={1000}
                value={policy.timeoutMs}
                onChange={(e) => setPolicy(prev => ({ ...prev, timeoutMs: parseInt(e.target.value || '0', 10) || 15000 }))}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-foreground">{t('settings:mcp_policy.rate_limit_label')}</label>
              <Input
                type="number"
                min={1}
                value={policy.rateLimit}
                onChange={(e) => setPolicy(prev => ({ ...prev, rateLimit: parseInt(e.target.value || '0', 10) || 10 }))}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-foreground">{t('settings:mcp_policy.cache_max_label')}</label>
              <Input
                type="number"
                min={0}
                value={policy.cacheMax}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  setPolicy(prev => ({
                    ...prev,
                    cacheMax: Number.isFinite(parsed) ? Math.max(0, parsed) : 100,
                  }));
                }}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-foreground">{t('settings:mcp_policy.cache_ttl_label')}</label>
              <Input
                type="number"
                min={0}
                value={policy.cacheTtlMs}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  setPolicy(prev => ({
                    ...prev,
                    cacheTtlMs: Number.isFinite(parsed) ? Math.max(0, parsed) : 300000,
                  }));
                }}
                className="w-full"
              />
            </div>
          </div>
          </div>
        </CustomScrollArea>
        <div className="mt-4 flex justify-end gap-2">
          <DsButton variant="ghost" className="[@media(pointer:coarse)]:!min-h-11" onClick={handleClose}>{t('common:actions.cancel')}</DsButton>
          <DsButton
            variant="primary"
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={handleSave}
          >{t('common:save')}</DsButton>
        </div>
      </div>
    </UnifiedModal>
  );
}
