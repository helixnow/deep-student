import {
  BookOpen, Brain, ChartBar, ClockCountdown, FileText, Flask, Globe, Keyboard,
  Microphone, Palette, Plug, PuzzlePiece, Robot, Shield, SlidersHorizontal, SquaresFour, Wrench,
} from '@phosphor-icons/react';
import { defineUiPlugin } from '@/ui-kernel/kernel';
import type { SettingsCategory, SettingsSection } from '@/ui-kernel/contracts/settings';
import { components } from './sections';
import { searchDetailsFor } from './search';
import type { Context } from '@deepseek-ai/cordis';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';

/** Settings-owned contributions from feature chunks, with the owner's real ctx.ui handles. */
export const settingsFeatureContributions = createLazyContributionPoint<(ctx: Context) => void>('settings.feature');

const categories = {
  ai: { id: 'ai', titleKey: 'settings:categories.ai', icon: Robot, order: 10 },
  experience: { id: 'experience', titleKey: 'settings:categories.experience', icon: SlidersHorizontal, order: 20 },
  personalization: { id: 'personalization', titleKey: 'settings:categories.personalization', icon: Brain, order: 30 },
  integrations: { id: 'integrations', titleKey: 'settings:categories.integrations', icon: Plug, order: 40 },
  workflow: { id: 'workflow', titleKey: 'settings:categories.workflow', icon: ClockCountdown, order: 50 },
  data: { id: 'data', titleKey: 'settings:categories.data', icon: Shield, order: 60 },
} satisfies Record<string, SettingsCategory>;

function navigation(order: number, legacyGroup: number, icon: SettingsSection['navigation']['icon'], id: string,
  accent: string, category?: SettingsCategory, categoryOrder?: number, tourId?: string): SettingsSection['navigation'] {
  return { order, legacyGroup, icon, mobileDescriptionKey: `settings:mobile_descriptions.${id}`,
    mobileAccent: `var(--settings-nav-accent-${accent})`, category, categoryOrder, tourId };
}

const desktopOnly: SettingsSection['visible'] = ({ isMobile }) => !isMobile;
const definitions: Omit<SettingsSection, 'component' | 'searchDetails'>[] = [
  { id: 'apis', group: 'ai', order: 10, titleKey: 'settings:tabs.api_config', placement: 'before-preview',
    navigation: navigation(10, 0, Robot, 'apis', 'amber', categories.ai, 10, 'settings-tab-apis') },
  { id: 'search', group: 'integrations', order: 20, titleKey: 'settings:tabs.external_search',
    navigation: navigation(110, 2, Globe, 'search', 'sky', categories.integrations, 20) },
  { id: 'models', group: 'ai', order: 30, titleKey: 'settings:tabs.model_assignment',
    navigation: navigation(20, 0, Flask, 'models', 'blue', categories.ai, 20, 'settings-tab-models') },
  { id: 'plugins', group: 'integrations', order: 40, titleKey: 'settings:tabs.plugins',
    navigation: navigation(120, 2, PuzzlePiece, 'plugins', 'purple', categories.integrations, 30),
    visible: desktopOnly, contentVisible: desktopOnly, mobileFallbackKey: 'settings:plugins.mobile_hidden' },
  { id: 'mcp', group: 'integrations', order: 50, titleKey: 'settings:tabs.mcp_tools',
    navigation: navigation(100, 2, Plug, 'mcp', 'green', categories.integrations, 10) },
  { id: 'statistics', group: 'data', order: 60, titleKey: 'settings:tabs.statistics',
    navigation: navigation(130, 3, ChartBar, 'statistics', 'sky', categories.data, 10) },
  { id: 'automation', group: 'workflow', order: 70, titleKey: 'settings:tabs.automation',
    navigation: navigation(90, 1, ClockCountdown, 'automation', 'orange', categories.workflow, 10) },
  { id: 'data-governance', group: 'data', order: 80, titleKey: 'settings:tabs.data_governance',
    navigation: navigation(140, 3, Shield, 'data_governance', 'sky', categories.data, 20) },
  { id: 'general', group: 'experience', order: 90, titleKey: 'settings:tabs.general',
    navigation: navigation(30, 1, SlidersHorizontal, 'general', 'slate', categories.experience, 10) },
  { id: 'appearance', group: 'experience', order: 100, titleKey: 'settings:tabs.appearance',
    navigation: navigation(70, 1, Palette, 'appearance', 'purple', categories.experience, 20) },
  { id: 'params', group: 'ai', order: 110, titleKey: 'settings:tabs.params',
    navigation: navigation(150, 4, Wrench, 'params', 'amber', categories.ai, 30) },
  { id: 'voice-input', group: 'personalization', order: 120, titleKey: 'settings:tabs.voice_input',
    navigation: navigation(40, 1, Microphone, 'voice_input', 'coral', categories.personalization, 10) },
  { id: 'memory', group: 'personalization', order: 130, titleKey: 'settings:tabs.memory',
    navigation: navigation(50, 1, Brain, 'memory', 'teal', categories.personalization, 20) },
  { id: 'workbench', group: 'experience', order: 140, titleKey: 'settings:tabs.workbench',
    navigation: navigation(60, 1, SquaresFour, 'workbench', 'indigo', categories.experience, 30),
    visible: desktopOnly, contentVisible: desktopOnly, redirect: ({ isMobile }) => isMobile ? 'apis' : undefined },
  { id: 'document-processing', group: 'workflow', order: 150, titleKey: 'settings:tabs.document_processing',
    navigation: navigation(160, 4, FileText, 'document_processing', 'violet', categories.workflow, 20) },
  { id: 'shortcuts', group: 'experience', order: 160, titleKey: 'settings:tabs.shortcuts', placement: 'after-modals',
    navigation: navigation(170, 4, Keyboard, 'shortcuts', 'slate', categories.experience, 40), visible: desktopOnly },
  { id: 'about', group: 'about', order: 170, titleKey: 'settings:tabs.about', placement: 'after-modals',
    navigation: navigation(180, 4, BookOpen, 'about', 'pink'), desktopHeadingKey: 'settings:tabs.about' },
];

export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.settings' },
  apply(ctx) {
    for (const definition of definitions) {
      const section: SettingsSection = { ...definition,
        component: components[definition.id as keyof typeof components], searchDetails: searchDetailsFor(definition.id) };
      ctx.ui.settings.register(section);
    }
    ctx.ui.attach(settingsFeatureContributions, (mount) => mount(ctx));
  },
}), { order: 30 });
