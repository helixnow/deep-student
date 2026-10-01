import { BookOpen } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import VERSION_INFO from '@/version';
import { cn } from '@/lib/utils';

/** Low-frequency system information stays outside the primary categories. */
export function SettingsAboutFooter({ active = false, onOpen }: { active?: boolean; onOpen: () => void }) {
  const { t } = useTranslation(['settings']);

  return (
    <div className="shrink-0 border-t border-[color:var(--shell-navigation-border)] px-2 py-3" data-settings-about-footer>
      <DsButton
        variant="ghost"
        size="md"
        className={cn(
          '!w-full !justify-start !px-2.5 text-muted-foreground',
          active && '!bg-[color:var(--sidebar-quiet-active)] !text-foreground',
        )}
        aria-label={t('settings:tabs.about')}
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
      >
        <BookOpen className="h-[18px] w-[18px] shrink-0" aria-hidden />
        <span>{t('settings:tabs.about')}</span>
        <span className="ml-auto text-xs tabular-nums">v{VERSION_INFO.APP_VERSION}</span>
      </DsButton>
    </div>
  );
}
