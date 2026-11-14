import React from 'react';
import type { SettingsSectionProps, SettingsSectionRenderProps } from '@/ui-kernel/contracts/settings';

const ApisTab = React.lazy(() => import('@/features/settings/components/ApisTab').then((module) => ({ default: module.ApisTab })));
const ExternalSearchTab = React.lazy(() => import('@/features/settings/components/ExternalSearchTab').then((module) => ({ default: module.ExternalSearchTab })));
const ModelsTab = React.lazy(() => import('@/features/settings/components/ModelsTab').then((module) => ({ default: module.ModelsTab })));
const PluginsTab = React.lazy(() => import('@/features/settings/components/plugins/PluginsTab').then((module) => ({ default: module.PluginsTab })));
const McpToolsSection = React.lazy(() => import('@/features/settings/components/McpToolsSection').then((module) => ({ default: module.McpToolsSection })));
const AutomationSettingsSection = React.lazy(() => import('@/features/settings/components/AutomationSettingsSection').then((module) => ({ default: module.AutomationSettingsSection })));
const SuperAgentSettingsSection = React.lazy(() => import('@/features/settings/components/SuperAgentSettingsSection').then((module) => ({ default: module.SuperAgentSettingsSection })));
const SubagentProfilesSection = React.lazy(() => import('@/features/settings/components/SubagentProfilesSection').then((module) => ({ default: module.SubagentProfilesSection })));
const DataGovernanceDashboard = React.lazy(() => import('@/features/settings/components/DataGovernanceDashboard').then((module) => ({ default: module.DataGovernanceDashboard })));
const GeneralTab = React.lazy(() => import('@/features/settings/components/GeneralTab').then((module) => ({ default: module.GeneralTab })));
const AppearanceTab = React.lazy(() => import('@/features/settings/components/AppearanceTab').then((module) => ({ default: module.AppearanceTab })));
const ParamsTab = React.lazy(() => import('@/features/settings/components/ParamsTab').then((module) => ({ default: module.ParamsTab })));
const ShortcutSettings = React.lazy(() => import('@/command-palette/components/ShortcutSettings').then((module) => ({ default: module.ShortcutSettings })));
const DataImportExport = React.lazy(() => import('@/components/DataImportExport').then((module) => ({ default: module.DataImportExport })));
const AboutTab = React.lazy(() => import('@/features/settings/components/AboutTab').then((module) => ({ default: module.AboutTab })));
const VoiceInputTab = React.lazy(() => import('@/features/settings/components/VoiceInputTab').then((module) => ({ default: module.VoiceInputTab })));
const WorkbenchTab = React.lazy(() => import('@/features/settings/components/WorkbenchTab').then((module) => ({ default: module.WorkbenchTab })));
const MemoryTab = React.lazy(() => import('@/features/settings/components/MemoryTab').then((module) => ({ default: module.MemoryTab })));
const DocumentProcessingTab = React.lazy(() => import('@/features/settings/components/DocumentProcessingTab').then((module) => ({ default: module.DocumentProcessingTab })));

function section<K extends keyof SettingsSectionProps>(id: K, Component: React.ComponentType<SettingsSectionProps[K]>) {
  return function SettingsSection({ getProps }: SettingsSectionRenderProps) {
    return <Component {...getProps[id]()} />;
  };
}

export const components = {
  apis: section('apis', ApisTab),
  search: section('search', ExternalSearchTab),
  models: section('models', ModelsTab),
  plugins: section('plugins', PluginsTab),
  mcp: section('mcp', McpToolsSection),
  statistics: section('statistics', DataImportExport),
  automation: ({ getProps }: SettingsSectionRenderProps) => (
    <div className="space-y-6">
      <AutomationSettingsSection {...getProps.automation()} />
      <SubagentProfilesSection />
      <SuperAgentSettingsSection />
    </div>
  ),
  'data-governance': ({ getProps }: SettingsSectionRenderProps) => (
    <div className="space-y-6">
      <DataGovernanceDashboard {...getProps['data-governance']()} />
    </div>
  ),
  general: section('general', GeneralTab),
  appearance: section('appearance', AppearanceTab),
  params: section('params', ParamsTab),
  'voice-input': section('voice-input', VoiceInputTab),
  memory: section('memory', MemoryTab),
  workbench: section('workbench', WorkbenchTab),
  'document-processing': section('document-processing', DocumentProcessingTab),
  shortcuts: section('shortcuts', ShortcutSettings),
  about: section('about', AboutTab),
};
