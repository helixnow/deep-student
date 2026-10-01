/**
 * MCP 危险区：全局"MCP 危险模式"开关（选项 ①）。
 *
 * 开启后 `mcp_stdio_start` 跳过批准配置门，任何 (command, args, env, cwd, framing)
 * 都会被直接 spawn —— WebView 里的任意 JS（含第三方依赖）都能借此 RCE。
 * 等价于 PowerShell 的 `Set-ExecutionPolicy Bypass`。
 *
 * 防护：
 *  - 默认关；
 *  - 红色危险区独立分节，文案明确告知风险；
 *  - 开启动作写入 secure store（`mcp.stdio.allowUnapproved`）并打 warn 日志；
 *  - 后端每次 spawn 都会再打 warn（含完整参数），留下审计轨迹。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Warning, ShieldWarning } from '@phosphor-icons/react';
import { Switch } from '@/components/ui/shad/Switch';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsAlertDialog } from '@/components/ui/DsDialog';

export function McpDangerZoneSection() {
  const { t } = useTranslation(['settings', 'common']);
  const [enabled, setEnabled] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [pendingValue, setPendingValue] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await invoke<boolean>('get_mcp_stdio_allow_unapproved');
        if (!cancelled) setEnabled(!!value);
      } catch (e) {
        console.warn('[McpDangerZone] read failed', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyValue = useCallback(
    async (next: boolean) => {
      try {
        await invoke('set_mcp_stdio_allow_unapproved', { enabled: next });
        setEnabled(next);
        showGlobalNotification(
          next ? 'warning' : 'success',
          next
            ? t('settings:mcp_danger.unapproved_enabled_toast', 'MCP 危险模式已开启，重启应用后生效')
            : t('settings:mcp_danger.unapproved_disabled_toast', 'MCP 危险模式已关闭'),
        );
      } catch (e: any) {
        showGlobalNotification(
          'error',
          t('settings:mcp_danger.unapproved_failed_toast', '设置失败：{{msg}}', {
            msg: String(e?.message ?? e),
          }),
        );
      }
    },
    [t],
  );

  const handleToggle = useCallback(
    (checked: boolean) => {
      // 任何切换都弹确认对话框，避免误触
      setPendingValue(checked);
      setConfirmOpen(true);
    },
    [],
  );

  const handleConfirm = useCallback(() => {
    setConfirmOpen(false);
    void applyValue(pendingValue);
  }, [applyValue, pendingValue]);

  return (
    <div
      className="rounded-2xl border-2 border-destructive/40 bg-destructive/5 p-4"
      data-testid="mcp-danger-zone"
    >
      <div className="flex items-start gap-3">
        <ShieldWarning className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" weight="fill" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-destructive mb-1">
            {t('settings:mcp_danger.title', '危险区：MCP 危险模式')}
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed mb-3">
            {t(
              'settings:mcp_danger.description',
              '默认情况下，MCP stdio 启动必须经过批准配置门（command / args / env / cwd / framing 必须与已保存的服务器条目完全一致）。开启"危险模式"后，任何网页或插件里的 JavaScript 都能调用 mcp_stdio_start 在你电脑上启动任意进程，等价于 PowerShell 的 Bypass 策略。仅在排障时短期开启，用毕请立即关闭。',
            )}
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Switch
                checked={enabled}
                onCheckedChange={handleToggle}
                disabled={loading}
                aria-label={t('settings:mcp_danger.unapproved_toggle', '允许未批准的 MCP stdio 启动')}
              />
              <span className="text-sm text-foreground font-medium">
                {t('settings:mcp_danger.unapproved_toggle', '允许未批准的 MCP stdio 启动')}
              </span>
            </div>
            {enabled && (
              <div className="flex items-center gap-1.5 text-xs text-destructive font-medium">
                <Warning className="w-3.5 h-3.5" weight="fill" />
                {t('settings:mcp_danger.unapproved_active_warning', '当前已开启：任何 JS 都能启动任意进程')}
              </div>
            )}
          </div>
        </div>
      </div>

      <DsAlertDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          pendingValue
            ? t('settings:mcp_danger.confirm_enable_title', '确认开启 MCP 危险模式？')
            : t('settings:mcp_danger.confirm_disable_title', '关闭 MCP 危险模式？')
        }
        description={
          pendingValue
            ? t(
                'settings:mcp_danger.confirm_enable_desc',
                '开启后，任何网页或插件中的 JavaScript 都能通过 mcp_stdio_start 在你电脑上启动任意进程，包括 powershell、cmd、bash 等。这可能被恶意代码利用来窃取数据或破坏系统。\n\n仅在排障时短期开启，用毕请立即关闭。',
              )
            : t('settings:mcp_danger.confirm_disable_desc', '关闭后恢复默认的批准配置门。')
        }
        confirmText={
          pendingValue
            ? t('settings:mcp_danger.confirm_enable_ok', '我已知晓风险，开启')
            : t('common:confirm', '确认')
        }
        cancelText={t('common:cancel', '取消')}
        confirmVariant={pendingValue ? 'danger' : 'default'}
        onConfirm={handleConfirm}
      />
    </div>
  );
}

export default McpDangerZoneSection;
