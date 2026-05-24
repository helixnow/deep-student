import { useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  ChartBar,
  Flask,
  Globe,
  Keyboard,
  Palette,
  Plug,
  Robot,
  Shield,
  SlidersHorizontal,
  Wrench,
} from '@phosphor-icons/react';

export type SettingsSidebarNavItem = {
  value: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tourId?: string;
};

export type SettingsSearchIndexItem = {
  tab: string;
  label: string;
  keywords: string[];
};

export function useSettingsNavigation() {
  const { t } = useTranslation(['settings', 'common', 'data']);

  const sidebarNavGroups = useMemo<SettingsSidebarNavItem[][]>(() => ([
    [
      { value: 'apis', icon: Robot, label: t('settings:tabs.api_config'), tourId: 'settings-tab-apis' },
      { value: 'models', icon: Flask, label: t('settings:tabs.model_assignment'), tourId: 'settings-tab-models' },
    ],
    [
      { value: 'general', icon: SlidersHorizontal, label: t('settings:tabs.general') },
      { value: 'appearance', icon: Palette, label: t('settings:tabs.appearance') },
    ],
    [
      { value: 'mcp', icon: Plug, label: t('settings:tabs.mcp_tools') },
      { value: 'search', icon: Globe, label: t('settings:tabs.external_search') },
    ],
    [
      { value: 'statistics', icon: ChartBar, label: t('settings:tabs.statistics') },
      { value: 'data-governance', icon: Shield, label: t('settings:tabs.data_governance') },
    ],
    [
      { value: 'params', icon: Wrench, label: t('settings:tabs.params') },
      { value: 'shortcuts', icon: Keyboard, label: t('settings:tabs.shortcuts') },
      { value: 'about', icon: BookOpen, label: t('settings:tabs.about') },
    ],
  ]), [t]);

  const sidebarNavItems = useMemo(() => sidebarNavGroups.flat(), [sidebarNavGroups]);

  const settingsSearchIndex = useMemo<SettingsSearchIndexItem[]>(() => [
    { tab: 'appearance', label: t('settings:appearance.theme.title'), keywords: ['theme', 'dark', 'light', 'appearance'] },
    { tab: 'appearance', label: t('settings:appearance.font.title'), keywords: ['font', 'typeface'] },
    { tab: 'appearance', label: t('settings:appearance.font.size_label'), keywords: ['font size'] },
    { tab: 'appearance', label: t('settings:appearance.font.heading_label'), keywords: ['heading font'] },
    { tab: 'appearance', label: t('settings:appearance.font.body_label'), keywords: ['body font'] },
    { tab: 'appearance', label: t('settings:appearance.sidebar.title'), keywords: ['sidebar', 'navigation'] },
    { tab: 'appearance', label: t('settings:appearance.sidebar.position'), keywords: ['sidebar position'] },
    { tab: 'general', label: t('settings:language.title'), keywords: ['language'] },
    {
      tab: 'general',
      label: t('settings:voice_input.title'),
      keywords: ['voice input', 'dictation', 'asr', 'microphone', 'speech to text', '听写', '语音输入'],
    },
    {
      tab: 'general',
      label: t('settings:voice_input.shortcut_title'),
      keywords: ['hotkey', 'shortcut', 'keyboard', 'press to talk', 'toggle dictation', '快捷键'],
    },
    {
      tab: 'general',
      label: t('settings:voice_input.dictionary_title'),
      keywords: ['dictionary', 'vocabulary', 'pronunciation hints', '词典', '短语'],
    },
    {
      tab: 'general',
      label: t('settings:voice_input.history_title'),
      keywords: ['history', 'recent dictation', 'transcript recovery', '历史记录', '转写记录'],
    },
    { tab: 'apis', label: t('settings:api.add_api_config'), keywords: ['API', 'add', 'config'] },
    { tab: 'apis', label: t('settings:api.modal.basic_info'), keywords: ['basic', 'API name', 'endpoint'] },
    { tab: 'apis', label: t('settings:api.modal.fields.api_key'), keywords: ['apikey', 'api key', 'key'] },
    { tab: 'apis', label: t('settings:api.modal.model_adapter'), keywords: ['adapter', 'openai', 'azure', 'gemini', 'claude'] },
    { tab: 'models', label: t('settings:api.model2_title'), keywords: ['chat model', 'conversation', 'reasoning'] },
    { tab: 'models', label: t('settings:api.embedding_title'), keywords: ['embedding', 'RAG', 'vector'] },
    { tab: 'models', label: t('settings:api.reranker_title'), keywords: ['reranker', 'RAG'] },
    { tab: 'models', label: t('settings:api.anki_card_title'), keywords: ['anki', 'card'] },
    { tab: 'mcp', label: t('settings:mcp.server'), keywords: ['mcp', 'server', 'tool'] },
    { tab: 'mcp', label: t('settings:mcp.add_server'), keywords: ['add server', 'mcp'] },
    { tab: 'search', label: t('settings:search_engine.title'), keywords: ['search engine', 'google', 'bing', 'tavily', 'searxng'] },
    { tab: 'search', label: 'SearXNG', keywords: ['searxng', 'search'] },
    { tab: 'search', label: 'Tavily', keywords: ['tavily', 'search', 'api'] },
    { tab: 'search', label: 'Exa', keywords: ['exa', 'search'] },
    { tab: 'statistics', label: t('settings:statistics.learning_time'), keywords: ['learning time', 'statistics'] },
    { tab: 'statistics', label: t('settings:statistics.chat_stats'), keywords: ['chat stats', 'session'] },
    { tab: 'statistics', label: t('settings:statistics.heatmap'), keywords: ['heatmap', 'activity'] },
    { tab: 'data-governance', label: t('data:governance.title'), keywords: ['data governance', 'import', 'export'] },
    { tab: 'data-governance', label: t('data:governance.backup'), keywords: ['backup', 'export'] },
    { tab: 'data-governance', label: t('data:governance.restore'), keywords: ['restore', 'import'] },
    { tab: 'params', label: t('settings:params.temperature'), keywords: ['temperature', 'model params'] },
    { tab: 'params', label: t('settings:params.top_p'), keywords: ['top p', 'nucleus sampling'] },
    { tab: 'shortcuts', label: t('settings:tabs.shortcuts'), keywords: ['shortcuts', 'keyboard', 'hotkey'] },
    { tab: 'about', label: t('settings:tabs.about'), keywords: ['about', 'version', 'acknowledgements'] },
  ], [t]);

  return {
    sidebarNavGroups,
    sidebarNavItems,
    settingsSearchIndex,
  };
}
