import type { ComponentProps, ComponentType } from 'react';

/** Type-only imports preserve the settings shell's existing 19 lazy boundaries. */
export interface SettingsSectionProps {
  apis: ComponentProps<typeof import('@/features/settings/components/ApisTab').ApisTab>;
  search: ComponentProps<typeof import('@/features/settings/components/ExternalSearchTab').ExternalSearchTab>;
  models: ComponentProps<typeof import('@/features/settings/components/ModelsTab').ModelsTab>;
  plugins: ComponentProps<typeof import('@/features/settings/components/plugins/PluginsTab').PluginsTab>;
  mcp: ComponentProps<typeof import('@/features/settings/components/McpToolsSection').McpToolsSection>;
  statistics: ComponentProps<typeof import('@/components/DataImportExport').DataImportExport>;
  automation: ComponentProps<typeof import('@/features/settings/components/AutomationSettingsSection').AutomationSettingsSection>;
  'data-governance': ComponentProps<typeof import('@/features/settings/components/DataGovernanceDashboard').DataGovernanceDashboard>;
  general: ComponentProps<typeof import('@/features/settings/components/GeneralTab').GeneralTab>;
  appearance: ComponentProps<typeof import('@/features/settings/components/AppearanceTab').AppearanceTab>;
  params: ComponentProps<typeof import('@/features/settings/components/ParamsTab').ParamsTab>;
  'voice-input': ComponentProps<typeof import('@/features/settings/components/VoiceInputTab').VoiceInputTab>;
  memory: ComponentProps<typeof import('@/features/settings/components/MemoryTab').MemoryTab>;
  workbench: ComponentProps<typeof import('@/features/settings/components/WorkbenchTab').WorkbenchTab>;
  'document-processing': ComponentProps<typeof import('@/features/settings/components/DocumentProcessingTab').DocumentProcessingTab>;
  shortcuts: ComponentProps<typeof import('@/command-palette/components/ShortcutSettings').ShortcutSettings>;
  about: ComponentProps<typeof import('@/features/settings/components/AboutTab').AboutTab>;
}

/** Factories, not eager props: inactive sections must not evaluate their inputs. */
export type SettingsSectionPropsFactories = { [K in keyof SettingsSectionProps]: () => SettingsSectionProps[K] };
export interface SettingsSectionRenderProps {
  getProps: SettingsSectionPropsFactories;
}

export interface SettingsVisibilityContext { isMobile: boolean }
export interface SettingsCategory {
  id: string;
  titleKey: string;
  icon: ComponentType<{ className?: string }>;
  order: number;
}
export interface SettingsSearchDetail {
  order: number;
  labelKey?: string;
  label?: string;
  defaultValue?: string;
  keywords: string[];
}
export type SettingsSectionPlacement = 'before-preview' | 'main' | 'after-modals';

/** Value of settings.sections. Navigation and content visibility intentionally differ. */
export interface SettingsSection {
  id: string;
  group: string;
  order: number;
  titleKey: string;
  component: ComponentType<SettingsSectionRenderProps>;
  placement?: SettingsSectionPlacement;
  navigation?: {
    order: number;
    legacyGroup: number;
    icon: ComponentType<{ className?: string }>;
    tourId?: string;
    mobileDescriptionKey: string;
    mobileAccent: string;
    category?: SettingsCategory;
    categoryOrder?: number;
  };
  visible?: (context: SettingsVisibilityContext) => boolean;
  contentVisible?: (context: SettingsVisibilityContext) => boolean;
  mobileFallbackKey?: string;
  redirect?: (context: SettingsVisibilityContext) => string | undefined;
  desktopHeadingKey?: string;
  searchDetails?: SettingsSearchDetail[];
}

/**
 * Argument of `ctx.ui.settings.register`: a `settings.sections` value whose `order` may be left out. A section
 * without `navigation` renders when its tab is selected but has no entry in the settings sidebar.
 */
export type SettingsSectionRegistration = Omit<SettingsSection, 'order'> & { order?: number };

declare module '../slot-map' {
  interface SlotMap {
    'settings.sections': SettingsSection;
  }
}
