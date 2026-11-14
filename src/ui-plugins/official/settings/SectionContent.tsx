import React from 'react';
import type { TFunction } from 'i18next';
import type { SlotEntry } from '@/ui-kernel/slots';
import type { SettingsSection, SettingsSectionPropsFactories } from '@/ui-kernel/contracts/settings';
import { CommunityErrorBoundary } from './isolation';

/** Official sections keep the old error path; only community contributions are isolated. */
export function SectionContent({ entry, getProps, isMobile, t }: {
  entry: SlotEntry<SettingsSection>;
  getProps: SettingsSectionPropsFactories;
  isMobile: boolean;
  t: TFunction;
}) {
  const section = entry.value;
  if (!(section.contentVisible?.({ isMobile }) ?? true)) {
    return section.mobileFallbackKey
      ? <div className="py-10 text-sm text-muted-foreground">{t(section.mobileFallbackKey)}</div>
      : null;
  }
  const Component = section.component;
  const content = <Component getProps={getProps} />;
  return entry.origin === 'builtin' ? content : (
    <CommunityErrorBoundary key={`${entry.owner}/${entry.id}`} name={`settings:${entry.id}`}>
      {content}
    </CommunityErrorBoundary>
  );
}
