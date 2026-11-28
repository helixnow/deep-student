import React, { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TFunction } from 'i18next';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
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
const parseClampedInt = (raw: string, min: number, fallback: number): number => {
  const parsed = parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

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
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [timeoutMsDraft, setTimeoutMsDraft] = useState(() => String(policy.timeoutMs));
  const [rateLimitDraft, setRateLimitDraft] = useState(() => String(policy.rateLimit));
  const [cacheMaxDraft, setCacheMaxDraft] = useState(() => String(policy.cacheMax));
  const [cacheTtlMsDraft, setCacheTtlMsDraft] = useState(() => String(policy.cacheTtlMs));

  useEffect(() => {
    if (!open) return;
    setTimeoutMsDraft(String(policy.timeoutMs));
    setRateLimitDraft(String(policy.rateLimit));
    setCacheMaxDraft(String(policy.cacheMax));
    setCacheTtlMsDraft(String(policy.cacheTtlMs));
  }, [open, policy.timeoutMs, policy.rateLimit, policy.cacheMax, policy.cacheTtlMs]);

  if (isSmallScreen || !open) return null;

  const handleClose = () => {
    if (savingRef.current) return;
    setPolicy(prev => ({ ...prev, open: false }));
  };

  const handleSave = async () => {
    if (savingRef.current) return;
    const timeoutMs = parseClampedInt(timeoutMsDraft, 1000, 15000);
    const rateLimit = parseClampedInt(rateLimitDraft, 1, 10);
    const cacheMax = parseClampedInt(cacheMaxDraft, 0, 100);
    const cacheTtlMs = parseClampedInt(cacheTtlMsDraft, 0, 300000);
    setTimeoutMsDraft(String(timeoutMs));
    setRateLimitDraft(String(rateLimit));
    setCacheMaxDraft(String(cacheMax));
    setCacheTtlMsDraft(String(cacheTtlMs));
    setPolicy(prev => ({ ...prev, timeoutMs, rateLimit, cacheMax, cacheTtlMs }));

    const nextPolicy = {
      mcpAdvertiseAll: policy.advertiseAll,
      mcpWhitelist: policy.whitelist,
      mcpBlacklist: policy.blacklist,
      mcpTimeoutMs: timeoutMs,
      mcpRateLimit: rateLimit,
      mcpCacheMax: cacheMax,
      mcpCacheTtlMs: cacheTtlMs,
    };

    savingRef.current = true;
    setSaving(true);
    try {
      if (invoke) {
        await Promise.all([
          saveSetting('mcp.tools.advertise_all_tools', policy.advertiseAll.toString()),
          saveSetting('mcp.tools.whitelist', policy.whitelist),
          saveSetting('mcp.tools.blacklist', policy.blacklist),
          saveSetting('mcp.performance.timeout_ms', String(timeoutMs)),
          saveSetting('mcp.performance.rate_limit_per_second', String(rateLimit)),
          saveSetting('mcp.performance.cache_max_size', String(cacheMax)),
          saveSetting('mcp.performance.cache_ttl_ms', String(cacheTtlMs)),
        ]);
      }
      setConfig(prev => ({ ...prev, ...nextPolicy }));
      showGlobalNotification('success', t('settings:mcp_descriptions.policy_saved'));
      setPolicy(prev => ({ ...prev, open: false }));
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      console.error('保存MCP安全策略失败:', err);
      showGlobalNotification('error', t('settings:mcp_descriptions.policy_save_failed', { error: errorMessage }));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <UnifiedModal
      isOpen={true}
      onClose={handleClose}
      closeOnOverlayClick={false}
    >
      <div className="ui-rise-in relative mx-auto mt-10 flex min-h-0 max-h-[min(85dvh,720px)] w-[90%] max-w-[500px] flex-col overflow-hidden rounded-[var(--radius-shell-dialog)] bg-popover p-4 text-popover-foreground shadow-lg">
        {/* 头部（关闭按钮由外层 UnifiedModal / DsDialog 统一提供） */}
        <div className="mb-4 flex items-center justify-between pr-8">
          <h3 className="text-base font-semibold text-foreground">{t('settings:mcp.security_policy')}</h3>
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
                value={timeoutMsDraft}
                onChange={(e) => setTimeoutMsDraft(e.target.value)}
                onBlur={() => {
                  const clamped = parseClampedInt(timeoutMsDraft, 1000, 15000);
                  setTimeoutMsDraft(String(clamped));
                  setPolicy(prev => ({ ...prev, timeoutMs: clamped }));
                }}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-foreground">{t('settings:mcp_policy.rate_limit_label')}</label>
              <Input
                type="number"
                min={1}
                value={rateLimitDraft}
                onChange={(e) => setRateLimitDraft(e.target.value)}
                onBlur={() => {
                  const clamped = parseClampedInt(rateLimitDraft, 1, 10);
                  setRateLimitDraft(String(clamped));
                  setPolicy(prev => ({ ...prev, rateLimit: clamped }));
                }}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-foreground">{t('settings:mcp_policy.cache_max_label')}</label>
              <Input
                type="number"
                min={0}
                value={cacheMaxDraft}
                onChange={(e) => setCacheMaxDraft(e.target.value)}
                onBlur={() => {
                  const clamped = parseClampedInt(cacheMaxDraft, 0, 100);
                  setCacheMaxDraft(String(clamped));
                  setPolicy(prev => ({ ...prev, cacheMax: clamped }));
                }}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-foreground">{t('settings:mcp_policy.cache_ttl_label')}</label>
              <Input
                type="number"
                min={0}
                value={cacheTtlMsDraft}
                onChange={(e) => setCacheTtlMsDraft(e.target.value)}
                onBlur={() => {
                  const clamped = parseClampedInt(cacheTtlMsDraft, 0, 300000);
                  setCacheTtlMsDraft(String(clamped));
                  setPolicy(prev => ({ ...prev, cacheTtlMs: clamped }));
                }}
                className="w-full"
              />
            </div>
          </div>
          </div>
        </CustomScrollArea>
        <div className="mt-4 flex justify-end gap-2">
          <DsButton variant="ghost" disabled={saving} className="[@media(pointer:coarse)]:!min-h-11" onClick={handleClose}>{t('common:actions.cancel')}</DsButton>
          <DsButton
            variant="primary"
            disabled={saving}
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => void handleSave()}
          >{saving ? t('common:actions.saving') : t('common:save')}</DsButton>
        </div>
      </div>
    </UnifiedModal>
  );
}
