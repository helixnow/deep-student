/**
 * WorkbenchModeSwitchRow — legacy 侧边栏的「学习桌面」快捷开关
 *
 * 与设置页总开关同一事件契约（见 features/settings/components/workbenchMode.ts）：
 * - 整行即开关：role="switch" + aria-checked，点击切换，右侧仅视觉指示
 *   （镜像 Switch sm 16×28 尺寸，避免 button 套 button 的嵌套交互）；
 * - 乐观更新，持久化失败回滚；
 * - 监听 workbench:mode-changed，与设置页/其他入口保持同步。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Desktop } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import {
  persistWorkbenchModeEnabled,
  readWorkbenchModeEnabled,
} from '@/features/settings/components/workbenchMode';

export const WorkbenchModeSwitchRow: React.FC = () => {
  const { t } = useTranslation('sidebar');
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void readWorkbenchModeEnabled().then((enabled) => {
      if (cancelled) return;
      setMode(enabled);
      setLoaded(true);
    });
    // 同壳内其他入口（设置页等）切换时同步
    const onModeChanged = (e: Event) => {
      const enabled = (e as CustomEvent<{ enabled?: boolean }>).detail?.enabled;
      if (typeof enabled === 'boolean') setMode(enabled);
    };
    window.addEventListener('workbench:mode-changed', onModeChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('workbench:mode-changed', onModeChanged);
    };
  }, []);

  const handleToggle = useCallback(() => {
    if (!loaded) return;
    const next = !mode;
    setMode(next); // 乐观更新
    void persistWorkbenchModeEnabled(next).then((ok) => {
      if (!ok) setMode(!next);
    });
  }, [loaded, mode]);

  return (
    <DsButton
      variant="nav"
      size="md"
      role="switch"
      aria-checked={mode}
      onClick={handleToggle}
      disabled={!loaded}
      data-tour-id="nav-workbench-mode"
      title={t('workbench:settings.mode.desc')}
      className={cn(
        'desktop-shell-sidebar-row',
        'desktop-shell-nav-row',
        '!w-full !justify-start !px-2.5 !py-1.5 text-left',
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="flex w-4 shrink-0 items-center justify-center text-[color:var(--shell-navigation-foreground)]">
          <Desktop size={18} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="desktop-shell-sidebar-row-title block min-w-0 flex-1 truncate leading-4">
            {t('navigation.workbench_mode', '学习桌面')}
          </span>
        </span>
        <span className="flex min-w-[24px] shrink-0 items-center justify-end gap-0.5">
          {/* 视觉开关（aria-hidden 非交互）：整行即 switch */}
          <span
            aria-hidden
            className={cn(
              'inline-flex h-4 w-7 items-center rounded-full p-[2px] transition-colors duration-150',
              mode ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--muted-foreground)/0.2)]',
            )}
          >
            <span
              className={cn(
                'block h-3 w-3 rounded-full bg-[hsl(var(--background))] shadow-[0_1px_1.5px_rgb(0_0_0/0.08)] transition-transform duration-150',
                mode && 'translate-x-3',
              )}
            />
          </span>
        </span>
      </span>
    </DsButton>
  );
};

export default WorkbenchModeSwitchRow;
