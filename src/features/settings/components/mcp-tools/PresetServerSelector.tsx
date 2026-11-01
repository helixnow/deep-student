import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Key, Package, ArrowSquareOut, Check, Shield } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { isAndroid } from '@/utils/platform';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { DsButton } from '@/components/ui/DsButton';
import { UiPresence } from '@/components/ui/UiPresence';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { 
  PRESET_MCP_SERVERS, 
  CATEGORY_LABELS,
  RISK_LABELS,
  isOAuthCapablePreset,
  type PresetMcpServer 
} from '@/mcp/presetMcpServers';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/shad/Sheet';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';

// 预置服务器选择器 + 安装前权限 Drawer
export function PresetServerSelector({
  existingServerIds,
  onAddPreset
}: {
  existingServerIds: string[];
  onAddPreset: (preset: PresetMcpServer, options?: { apiKey?: string; enableOauth?: boolean }) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  // P0-3 移动端契约：预置列表由 fixed 遮罩下拉改为内联展开；
  // 安装前权限确认由 Sheet 抽屉改为内联展开卡
  const { isSmallScreen } = useBreakpoint();
  const [isOpen, setIsOpen] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<PresetMcpServer | null>(null);
  const [pendingApiKey, setPendingApiKey] = useState('');
  const [enableOauth, setEnableOauth] = useState(false);
  const oauthSupported = !isAndroid();
  const addPresetBtnRef = useRef<HTMLButtonElement | null>(null);
  const selectorPanelRef = useRef<HTMLDivElement | null>(null);

  const groupedPresets = useMemo(() => {
    const groups: Record<string, PresetMcpServer[]> = {};
    for (const preset of PRESET_MCP_SERVERS) {
      const category = preset.category;
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(preset);
    }
    return groups;
  }, []);

  const isPresetAdded = useCallback((presetId: string) => {
    return existingServerIds.some(id => 
      id === presetId || id.startsWith(`preset_${presetId}_`)
    );
  }, [existingServerIds]);

  const closePermissionDrawer = useCallback(() => {
    setPendingPreset(null);
    setPendingApiKey('');
    setEnableOauth(false);
  }, []);

  const closeSelector = useCallback(() => {
    setIsOpen(false);
    // Defer until after unmount so the trigger is again focusable.
    queueMicrotask(() => {
      addPresetBtnRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const panel = selectorPanelRef.current;
    const focusFirst = () => {
      const first = panel?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? panel)?.focus({ preventScroll: true });
    };
    const raf = window.requestAnimationFrame(focusFirst);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSelector();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen, closeSelector]);

  // 📱 Android 返回键：选择器为自绘浮层（桌面 fixed 遮罩 / 移动内联展开），
  // 无 data-state="open"，Radix 兜底探测不到；打开期间显式注册 overlay 档
  // handler。层级语义：先关权限确认（移动内联卡 / 桌面 Sheet），再关预置列表。
  useEffect(() => {
    if (!isOpen) return;
    return registerBackHandler(() => {
      if (pendingPreset) {
        closePermissionDrawer();
      } else {
        closeSelector();
      }
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isOpen, pendingPreset, closePermissionDrawer, closeSelector]);

  const confirmInstall = useCallback(() => {
    if (!pendingPreset) return;
    if (pendingPreset.requiresApiKey && !pendingApiKey.trim() && !(oauthSupported && enableOauth)) {
      showGlobalNotification('error', t('settings:mcp_presets.api_key_required'));
      return;
    }
    onAddPreset(pendingPreset, {
      apiKey: pendingApiKey.trim() || undefined,
      enableOauth: oauthSupported && enableOauth && isOAuthCapablePreset(pendingPreset) && !pendingApiKey.trim(),
    });
    setIsOpen(false);
    closePermissionDrawer();
  }, [pendingPreset, pendingApiKey, enableOauth, oauthSupported, onAddPreset, closePermissionDrawer, t]);

  // 预置分组列表（桌面下拉与移动内联展开共用）
  const selectorContent = (
    <>
      <div className="px-2 py-1.5 mb-2">
        <div className="text-sm font-medium text-foreground">{t('settings:mcp_presets.title')}</div>
        <div className="text-xs text-muted-foreground">{t('settings:mcp_presets.description')}</div>
      </div>

      {Object.entries(groupedPresets).map(([category, presets]) => (
              <div key={category} className="mb-3">
                <div className="px-2 py-1 text-2xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t(CATEGORY_LABELS[category] || category)}
                </div>
                <div className="space-y-1">
                  {presets.map((preset) => {
                    const isAdded = isPresetAdded(preset.id);
                    return (
                      <DsButton
                        key={preset.id}
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!isAdded) {
                            setPendingPreset(preset);
                            setEnableOauth(oauthSupported && isOAuthCapablePreset(preset) && !preset.requiresApiKey);
                          }
                        }}
                        disabled={isAdded}
                        data-testid={`mcp-preset-item-${preset.id}`}
                        className={cn(
                          'w-full !justify-start !h-auto !py-2 text-left [@media(pointer:coarse)]:!min-h-11',
                          isAdded && 'opacity-50 bg-muted/30'
                        )}
                      >
                        <span className={cn(
                          'w-2 h-2 rounded-full flex-shrink-0 mt-2',
                          isAdded ? 'bg-success' : 'bg-muted-foreground/30'
                        )} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-foreground">{preset.name}</span>
                            {isAdded && (
                              <Check className="w-3.5 h-3.5 text-success" />
                            )}
                            {preset.source === 'official' && (
                              <span className="text-2xs px-1 py-0.5 rounded bg-info/10 text-info font-medium">
                                {t('settings:mcp_presets.official')}
                              </span>
                            )}
                            {preset.source === 'community' && (
                              <span className="text-2xs px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">
                                {t('settings:mcp_presets.community')}
                              </span>
                            )}
                            {(preset.requiresApiKey || preset.authKind === 'api_key' || preset.authKind === 'api_key_or_oauth') && (
                              <span className="text-2xs px-1 py-0.5 rounded bg-warning/10 text-warning font-medium">
                                <Key className="w-2.5 h-2.5 inline mr-0.5" />
                                API Key
                              </span>
                            )}
                            {oauthSupported && isOAuthCapablePreset(preset) && (
                              <span className="text-2xs px-1 py-0.5 rounded bg-violet-500/10 text-violet-500 font-medium">
                                OAuth
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {t(preset.descriptionKey)}
                          </div>
                        </div>
                      </DsButton>
                    );
                  })}
                </div>
              </div>
            ))}
    </>
  );

  // 安装前权限确认正文（桌面 Sheet 与移动内联展开卡共用）
  const permissionBody = pendingPreset ? (
    <>
      <div
        id="mcp-preset-permission-summary"
        className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2"
        role="region"
        aria-label={t('settings:mcp_presets.permission_title', { name: pendingPreset.name })}
        data-testid="mcp-preset-permission-summary"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">{t('settings:mcp_presets.risk_label')}</span>
          <span
            className={cn(
              'text-xs font-medium px-1.5 py-0.5 rounded',
              pendingPreset.risk === 'high' && 'bg-destructive/10 text-destructive',
              pendingPreset.risk === 'medium' && 'bg-warning/10 text-warning',
              pendingPreset.risk === 'low' && 'bg-success/10 text-success',
            )}
            data-testid="mcp-preset-permission-risk"
          >
            {t(RISK_LABELS[pendingPreset.risk])}
          </span>
        </div>
        <div data-testid="mcp-preset-permission-scope">
          <div className="text-muted-foreground mb-1">{t('settings:mcp_presets.data_scope_label')}</div>
          <p className="text-foreground">{t(pendingPreset.permissions.dataScopeKey)}</p>
        </div>
        <div className="flex items-center gap-2" data-testid="mcp-preset-permission-egress">
          <span className="text-muted-foreground">{t('settings:mcp_presets.network_egress_label')}</span>
          <span>{pendingPreset.permissions.networkEgress
            ? t('settings:mcp_presets.network_egress_yes')
            : t('settings:mcp_presets.network_egress_no')}</span>
        </div>
        {pendingPreset.permissions.notesKey && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="mcp-preset-permission-notes"
          >
            {t(pendingPreset.permissions.notesKey)}
          </p>
        )}
        {pendingPreset.permissions.apiKeyUrl && (
          <a
            href={pendingPreset.permissions.apiKeyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            data-testid="mcp-preset-permission-api-key-link"
          >
            <ArrowSquareOut className="w-3 h-3" aria-hidden="true" />
            {t('settings:mcp_presets.get_api_key')}
          </a>
        )}
      </div>

      {(pendingPreset.requiresApiKey || pendingPreset.authKind === 'api_key' || pendingPreset.authKind === 'api_key_or_oauth') && (
        <div className="space-y-2">
          <label className="text-sm font-medium">{t('settings:mcp.api_key')}</label>
          <Input
            type="password"
            {...TECHNICAL_INPUT_PROPS}
            value={pendingApiKey}
            onChange={(e) => {
              setPendingApiKey(e.target.value);
              if (e.target.value.trim()) setEnableOauth(false);
            }}
            placeholder={pendingPreset.apiKeyHint ? t(pendingPreset.apiKeyHint) : t('settings:placeholders.api_key')}
            className="font-mono"
          />
        </div>
      )}

      {oauthSupported && isOAuthCapablePreset(pendingPreset) && (
        <label className="flex items-start gap-2 cursor-pointer [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center">
          <Checkbox
            checked={enableOauth && !pendingApiKey.trim()}
            onCheckedChange={(v) => {
              setEnableOauth(Boolean(v));
              if (v) setPendingApiKey('');
            }}
            disabled={Boolean(pendingApiKey.trim())}
          />
          <span className="text-sm leading-snug">
            {t('settings:mcp_presets.enable_oauth_install')}
          </span>
        </label>
      )}
    </>
  ) : null;

  const permissionFooterButtons = (
    <>
      <DsButton variant="ghost" size="sm" onClick={closePermissionDrawer} className="[@media(pointer:coarse)]:!min-h-11">
        {t('common:cancel')}
      </DsButton>
      <DsButton variant="primary" size="sm" onClick={confirmInstall} className="[@media(pointer:coarse)]:!min-h-11">
        {t('settings:mcp_presets.confirm_install')}
      </DsButton>
    </>
  );

  // P0-3 移动端：内联展开（操作栏为 flex-wrap，w-full 自动换行占满一行）。
  // 选中预置后列表让位给权限确认卡，取消则回到列表；UiPresence 承载打开/退出动画。
  if (isSmallScreen) {
    return (
      <div className={cn('relative', isOpen && 'w-full')}>
        <DsButton
          ref={addPresetBtnRef}
          onClick={() => setIsOpen(!isOpen)}
          variant="outline"
          size="sm"
          className="[@media(pointer:coarse)]:!min-h-11"
          aria-expanded={isOpen}
          data-testid="mcp-preset-add-btn"
        >
          <Package className="w-4 h-4 mr-1" aria-hidden="true" />
          {t('settings:mcp_presets.add_preset')}
        </DsButton>

        <UiPresence
          open={isOpen && !pendingPreset}
          inClass="ui-zoom-fade-in motion-reduce:animate-none"
          outClass="ui-zoom-fade-out"
          className="mt-1 w-full"
        >
          <CustomScrollArea
            ref={selectorPanelRef}
            className="!h-[min(60dvh,30rem)] w-full rounded-lg border border-border bg-popover mcp-preset-selector"
            viewportClassName="p-2"
            trackOffsetTop={4}
            trackOffsetBottom={4}
            role="group"
            aria-label={t('settings:mcp_presets.title')}
            tabIndex={-1}
            data-testid="mcp-preset-selector"
          >
            {selectorContent}
          </CustomScrollArea>
        </UiPresence>

        <UiPresence
          open={isOpen && Boolean(pendingPreset)}
          inClass="ui-zoom-fade-in motion-reduce:animate-none"
          outClass="ui-zoom-fade-out"
          className="mt-1 w-full space-y-4 rounded-lg border border-border bg-popover p-4 text-sm mcp-preset-permission-drawer"
          role="group"
          aria-label={pendingPreset
            ? t('settings:mcp_presets.permission_title', { name: pendingPreset.name })
            : t('settings:mcp_presets.title')}
          data-testid="mcp-preset-permission-drawer"
        >
          {pendingPreset && (
            <>
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Shield className="w-4 h-4" aria-hidden="true" />
                  {t('settings:mcp_presets.permission_title', { name: pendingPreset.name })}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t(pendingPreset.descriptionKey)}</p>
              </div>
              {permissionBody}
              <div className="flex flex-wrap justify-end gap-2 border-t border-border/40 pt-3">
                {permissionFooterButtons}
              </div>
            </>
          )}
        </UiPresence>
      </div>
    );
  }

  // 桌面/平板（含安卓横屏 ≥768px）：Portal + fixed 定位（#46）。
  // 旧实现是 `absolute right-0` + z-50：预置弹层在窄视口下向左溢出屏幕、
  // 被设置内容滚动容器裁切、被侧栏 stacking context 压住。
  // Popover 原语自带视口碰撞钳制（resolvePopoverPosition）与 Z_INDEX.popover 层级。
  return (
    <div className="relative">
      <Popover
        open={isOpen}
        onOpenChange={(open) => {
          if (open) setIsOpen(true);
          else closeSelector();
        }}
      >
        <PopoverTrigger asChild>
          <DsButton
            ref={addPresetBtnRef}
            variant="outline"
            size="sm"
            className="[@media(pointer:coarse)]:!min-h-11"
            aria-haspopup="dialog"
            data-testid="mcp-preset-add-btn"
          >
            <Package className="w-4 h-4 mr-1" aria-hidden="true" />
            {t('settings:mcp_presets.add_preset')}
          </DsButton>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={4}
          aria-modal="true"
          aria-label={t('settings:mcp_presets.title')}
          data-testid="mcp-preset-selector"
          className="w-[380px] max-w-[calc(100vw-1.5rem)] overflow-hidden !p-0"
        >
          <CustomScrollArea
            ref={selectorPanelRef}
            className="!h-[min(60dvh,30rem)] w-full mcp-preset-selector"
            viewportClassName="p-2"
            trackOffsetTop={4}
            trackOffsetBottom={4}
            tabIndex={-1}
          >
            {selectorContent}
          </CustomScrollArea>
        </PopoverContent>
      </Popover>

      {/* 桌面端：安装前权限确认保留 Sheet；移动端由上方内联卡承载（P0-3） */}
      <Sheet open={Boolean(pendingPreset)} onOpenChange={(open) => { if (!open) closePermissionDrawer(); }}>
        <SheetContent
          side="right"
          className="flex min-h-0 w-full flex-col overflow-hidden sm:max-w-md mcp-preset-permission-drawer"
          data-testid="mcp-preset-permission-drawer"
          aria-describedby="mcp-preset-permission-summary"
          onWheel={(event) => event.stopPropagation()}
        >
          {pendingPreset && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5" aria-hidden="true" />
                  {t('settings:mcp_presets.permission_title', { name: pendingPreset.name })}
                </SheetTitle>
                <SheetDescription>
                  {t(pendingPreset.descriptionKey)}
                </SheetDescription>
              </SheetHeader>
              <CustomScrollArea
                className="mt-4 min-h-0 flex-1"
                viewportClassName="pr-2 text-sm"
                trackOffsetTop={4}
                trackOffsetBottom={4}
              >
                <div className="space-y-4">
                  {permissionBody}
                </div>
              </CustomScrollArea>
              <SheetFooter className="mt-6 shrink-0 flex gap-2 sm:justify-end">
                {permissionFooterButtons}
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
