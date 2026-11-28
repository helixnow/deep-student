import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
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

const parseClampedInt = (raw: string, min: number, fallback: number): number => {
  const parsed = parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
};

export function renderMcpPolicyEditorEmbedded(ctx: McpPolicyEditorEmbeddedContext) {
  if (!ctx.mcpPolicyModal.open) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <p className="text-sm">{ctx.t('settings:sections.select_policy_to_edit')}</p>
      </div>
    );
  }
  return <McpPolicyEditorEmbeddedView {...ctx} />;
}

function McpPolicyEditorEmbeddedView({
  setConfig, isSmallScreen, t, closeRightPanel, mcpPolicySaveRef, mcpPolicyModal, setMcpPolicyModal,
}: McpPolicyEditorEmbeddedContext) {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [timeoutMsDraft, setTimeoutMsDraft] = useState(() => String(mcpPolicyModal.timeoutMs));
  const [rateLimitDraft, setRateLimitDraft] = useState(() => String(mcpPolicyModal.rateLimit));
  const [cacheMaxDraft, setCacheMaxDraft] = useState(() => String(mcpPolicyModal.cacheMax));
  const [cacheTtlMsDraft, setCacheTtlMsDraft] = useState(() => String(mcpPolicyModal.cacheTtlMs));

  useEffect(() => {
    setTimeoutMsDraft(String(mcpPolicyModal.timeoutMs));
    setRateLimitDraft(String(mcpPolicyModal.rateLimit));
    setCacheMaxDraft(String(mcpPolicyModal.cacheMax));
    setCacheTtlMsDraft(String(mcpPolicyModal.cacheTtlMs));
  }, [mcpPolicyModal.timeoutMs, mcpPolicyModal.rateLimit, mcpPolicyModal.cacheMax, mcpPolicyModal.cacheTtlMs]);

  const handleClose = () => {
    if (savingRef.current) return;
    setMcpPolicyModal(prev => ({ ...prev, open: false }));
    closeRightPanel();
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
    setMcpPolicyModal(prev => ({ ...prev, timeoutMs, rateLimit, cacheMax, cacheTtlMs }));

    const nextPolicy = {
      mcpAdvertiseAll: mcpPolicyModal.advertiseAll,
      mcpWhitelist: mcpPolicyModal.whitelist,
      mcpBlacklist: mcpPolicyModal.blacklist,
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
          saveSetting('mcp.tools.advertise_all_tools', mcpPolicyModal.advertiseAll.toString()),
          saveSetting('mcp.tools.whitelist', mcpPolicyModal.whitelist),
          saveSetting('mcp.tools.blacklist', mcpPolicyModal.blacklist),
          saveSetting('mcp.performance.timeout_ms', String(timeoutMs)),
          saveSetting('mcp.performance.rate_limit_per_second', String(rateLimit)),
          saveSetting('mcp.performance.cache_max_size', String(cacheMax)),
          saveSetting('mcp.performance.cache_ttl_ms', String(cacheTtlMs)),
        ]);
      }
      setConfig(prev => ({ ...prev, ...nextPolicy }));
      showGlobalNotification('success', t('settings:mcp_descriptions.policy_saved'));
      setMcpPolicyModal(prev => ({ ...prev, open: false }));
      closeRightPanel();
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      console.error('保存MCP安全策略失败:', err);
      showGlobalNotification('error', t('settings:mcp_descriptions.policy_save_failed', { error: errorMessage }));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
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
                value={timeoutMsDraft}
                onChange={(e) => setTimeoutMsDraft(e.target.value)}
                onBlur={() => {
                  const clamped = parseClampedInt(timeoutMsDraft, 1000, 15000);
                  setTimeoutMsDraft(String(clamped));
                  setMcpPolicyModal(prev => ({ ...prev, timeoutMs: clamped }));
                }}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.rate_limit_label')}</label>
              <Input
                type="number"
                min={1}
                value={rateLimitDraft}
                onChange={(e) => setRateLimitDraft(e.target.value)}
                onBlur={() => {
                  const clamped = parseClampedInt(rateLimitDraft, 1, 10);
                  setRateLimitDraft(String(clamped));
                  setMcpPolicyModal(prev => ({ ...prev, rateLimit: clamped }));
                }}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.cache_max_label')}</label>
              <Input
                type="number"
                min={0}
                value={cacheMaxDraft}
                onChange={(e) => setCacheMaxDraft(e.target.value)}
                onBlur={() => {
                  const clamped = parseClampedInt(cacheMaxDraft, 0, 100);
                  setCacheMaxDraft(String(clamped));
                  setMcpPolicyModal(prev => ({ ...prev, cacheMax: clamped }));
                }}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('settings:mcp_descriptions.cache_ttl_label')}</label>
              <Input
                type="number"
                min={0}
                value={cacheTtlMsDraft}
                onChange={(e) => setCacheTtlMsDraft(e.target.value)}
                onBlur={() => {
                  const clamped = parseClampedInt(cacheTtlMsDraft, 0, 300000);
                  setCacheTtlMsDraft(String(clamped));
                  setMcpPolicyModal(prev => ({ ...prev, cacheTtlMs: clamped }));
                }}
              />
            </div>
          </div>
        </div>
      </CustomScrollArea>

      {/* 移动端：保存唯一出口在统一顶栏 Check（P1-7），底栏不再重复；桌面右侧面板保留 */}
      {!isSmallScreen && (
      <div className="flex flex-shrink-0 gap-2 border-t border-border px-4 py-3">
        <DsButton variant="ghost" disabled={saving} onClick={handleClose} className="min-h-11 flex-1">{t('common:actions.cancel')}</DsButton>
        <DsButton variant="primary" disabled={saving} onClick={() => void handleSave()} className="min-h-11 flex-1">{saving ? t('common:actions.saving') : t('common:actions.save')}</DsButton>
      </div>
      )}
    </div>
  );
}
