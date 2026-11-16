/**
 * Appearance → plugin themes: picks one of the `theme.variants` contributions (or the default theme). Hidden while no
 * installed plugin contributes a variant. Applying is done by the settings plugin's controller
 * (`features/settings/themeVariants.ts`), which also removes the variant when its plugin unloads.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { useOptionalSlot } from '@/ui-kernel/react';
import { themeVariantKey, useSelectedThemeVariant, THEME_VARIANT_SLOT } from '../themeVariants';

export const ThemeVariantPicker: React.FC = () => {
  const { t } = useTranslation('settings');
  const entries = useOptionalSlot(THEME_VARIANT_SLOT);
  const [picked, setPicked] = useSelectedThemeVariant();
  if (!entries?.length) return null;
  const pickedKnown = entries.some((entry) => themeVariantKey(entry) === picked);
  const options = [
    { key: null as string | null, label: t('settings:theme.variant_default'), title: undefined as string | undefined },
    ...entries.map((entry) => ({ key: themeVariantKey(entry), label: String(entry.value?.label ?? entry.id), title: entry.value?.description })),
  ];
  return (
    <div className="group rounded-[var(--button-radius)] px-1 py-2.5" data-testid="theme-variant-picker">
      <div className="mb-3">
        <h3 className="text-sm text-foreground/90 leading-tight">{t('settings:theme.variant_label')}</h3>
        <p className="text-xs text-muted-foreground/70 leading-relaxed mt-0.5">{t('settings:theme.variant_hint')}</p>
      </div>
      <div role="radiogroup" aria-label={t('settings:theme.variant_label')} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const checked = option.key === null ? !pickedKnown : option.key === picked;
          return (
            <DsButton
              key={option.key ?? ''}
              type="button"
              size="sm"
              variant={checked ? 'secondary' : 'outline'}
              role="radio"
              aria-checked={checked}
              title={option.title}
              data-theme-variant={option.key ?? ''}
              onClick={() => setPicked(option.key)}
              className={checked ? 'rounded-full ring-1 ring-primary' : 'rounded-full'}
            >
              {option.label}
            </DsButton>
          );
        })}
      </div>
    </div>
  );
};

export default ThemeVariantPicker;
