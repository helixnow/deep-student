import { useMemo, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpen,
  Brain,
  ChartBar,
  ClockCountdown,
  FileText,
  Flask,
  Globe,
  Keyboard,
  Microphone,
  Palette,
  Plug,
  PuzzlePiece,
  Robot,
  Shield,
  SlidersHorizontal,
  SquaresFour,
  Wrench,
} from '@phosphor-icons/react';
import { isMobilePlatform } from '@/utils/platform';

export type SettingsSidebarNavItem = {
  value: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tourId?: string;
  mobileDescription?: string;
  mobileAccent?: string;
};

export type SettingsSearchIndexItem = {
  tab: string;
  label: string;
  keywords: string[];
};

export function useSettingsNavigation() {
  const { t } = useTranslation(['settings', 'common', 'data']);

  const isMobile = isMobilePlatform();
  const hidePlugins = isMobile;
  // Mobile platforms have no physical keyboard, so keep shortcut settings out of the mobile navigation.
  const hideShortcuts = isMobile;

  const sidebarNavGroups = useMemo<SettingsSidebarNavItem[][]>(() => ([
    [
      {
        value: 'apis',
        icon: Robot,
        label: t('settings:tabs.api_config'),
        tourId: 'settings-tab-apis',
        mobileDescription: t('settings:mobile_descriptions.apis'),
        mobileAccent: '#e5ad3d',
      },
      {
        value: 'models',
        icon: Flask,
        label: t('settings:tabs.model_assignment'),
        tourId: 'settings-tab-models',
        mobileDescription: t('settings:mobile_descriptions.models'),
        mobileAccent: '#4d86df',
      },
    ],
    [
      {
        value: 'general',
        icon: SlidersHorizontal,
        label: t('settings:tabs.general'),
        mobileDescription: t('settings:mobile_descriptions.general'),
        mobileAccent: '#6f7785',
      },
      {
        value: 'voice-input',
        icon: Microphone,
        label: t('settings:tabs.voice_input'),
        mobileDescription: t('settings:mobile_descriptions.voice_input'),
        mobileAccent: '#e0704f',
      },
      {
        value: 'memory',
        icon: Brain,
        label: t('settings:tabs.memory'),
        mobileDescription: t('settings:mobile_descriptions.memory'),
        mobileAccent: '#4fae9e',
      },
      {
        value: 'workbench',
        icon: SquaresFour,
        label: t('settings:tabs.workbench'),
        mobileDescription: t('settings:mobile_descriptions.workbench'),
        mobileAccent: '#5f8fd8',
      },
      {
        value: 'appearance',
        icon: Palette,
        label: t('settings:tabs.appearance'),
        mobileDescription: t('settings:mobile_descriptions.appearance'),
        mobileAccent: '#a35de1',
      },
      {
        value: 'automation',
        icon: ClockCountdown,
        label: t('settings:tabs.automation'),
        mobileDescription: t('settings:mobile_descriptions.automation'),
        mobileAccent: '#eb8d42',
      },
    ],
    [
      {
        value: 'mcp',
        icon: Plug,
        label: t('settings:tabs.mcp_tools'),
        mobileDescription: t('settings:mobile_descriptions.mcp'),
        mobileAccent: '#1db77c',
      },
      {
        value: 'search',
        icon: Globe,
        label: t('settings:tabs.external_search'),
        mobileDescription: t('settings:mobile_descriptions.search'),
        mobileAccent: '#4b9fe8',
      },
      ...(!hidePlugins
        ? [{
            value: 'plugins',
            icon: PuzzlePiece,
            label: t('settings:tabs.plugins'),
            mobileDescription: t('settings:mobile_descriptions.plugins'),
            mobileAccent: '#a35de1',
          }]
        : []),
    ],
    [
      {
        value: 'statistics',
        icon: ChartBar,
        label: t('settings:tabs.statistics'),
        mobileDescription: t('settings:mobile_descriptions.statistics'),
        mobileAccent: '#4b9fe8',
      },
      {
        value: 'data-governance',
        icon: Shield,
        label: t('settings:tabs.data_governance'),
        mobileDescription: t('settings:mobile_descriptions.data_governance'),
        mobileAccent: '#4f9ecf',
      },
    ],
    [
      {
        value: 'params',
        icon: Wrench,
        label: t('settings:tabs.params'),
        mobileDescription: t('settings:mobile_descriptions.params'),
        mobileAccent: '#e1a642',
      },
      {
        value: 'document-processing',
        icon: FileText,
        label: t('settings:tabs.document_processing'),
        mobileDescription: t('settings:mobile_descriptions.document_processing'),
        mobileAccent: '#8f7bd8',
      },
      ...(!hideShortcuts
        ? [{
            value: 'shortcuts',
            icon: Keyboard,
            label: t('settings:tabs.shortcuts'),
            mobileDescription: t('settings:mobile_descriptions.shortcuts'),
            mobileAccent: '#7d8490',
          }]
        : []),
      {
        value: 'about',
        icon: BookOpen,
        label: t('settings:tabs.about'),
        mobileDescription: t('settings:mobile_descriptions.about'),
        mobileAccent: '#d978ae',
      },
    ],
  ]), [t, hidePlugins, hideShortcuts]);

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
      label: t('settings:system_authorization.title'),
      keywords: ['permission', 'authorization', 'notification', 'microphone', 'file access', '权限', '授权', '通知', '麦克风', '文件访问'],
    },
    {
      tab: 'voice-input',
      label: t('settings:voice_input.title'),
      keywords: ['voice input', 'dictation', 'asr', 'microphone', 'speech to text', '听写', '语音输入'],
    },
    { tab: 'automation', label: t('settings:automation.title'), keywords: ['automation', 'schedule', 'reminder', 'agent', '自动化', '定时', '调度'] },
    { tab: 'automation', label: t('settings:subagentProfiles.title'), keywords: ['subagent', 'profile', 'persona', 'agent', '子代理', '档案', '智能体'] },
    {
      tab: 'voice-input',
      label: t('settings:voice_input.shortcut_title'),
      keywords: ['hotkey', 'shortcut', 'keyboard', 'press to talk', 'toggle dictation', '快捷键'],
    },
    {
      tab: 'voice-input',
      label: t('settings:voice_input.dictionary_title'),
      keywords: ['dictionary', 'vocabulary', 'pronunciation hints', '词典', '短语'],
    },
    {
      tab: 'voice-input',
      label: t('settings:voice_input.history_title'),
      keywords: ['history', 'recent dictation', 'transcript recovery', '历史记录', '转写记录'],
    },
    { tab: 'memory', label: t('settings:memory.title'), keywords: ['memory', '记忆', '本地记忆'] },
    { tab: 'workbench', label: t('workbench:settings.sectionTitle'), keywords: ['workbench', '工作台', '工作区', 'workspace'] },
    { tab: 'document-processing', label: t('settings:pdf.title', { defaultValue: 'PDF 设置' }), keywords: ['pdf', 'PDF'] },
    { tab: 'document-processing', label: t('settings:ocr.title', { defaultValue: 'OCR 设置' }), keywords: ['ocr', 'OCR', '文字识别'] },
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
    ...(!hidePlugins
      ? [
          { tab: 'plugins', label: t('settings:tabs.plugins'), keywords: ['plugin', 'ilink', 'wechat', '微信', 'clawbot', '集成'] },
          { tab: 'plugins', label: t('settings:plugins.scan_qr'), keywords: ['qr', '扫码', '绑定'] },
        ]
      : []),
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
    ...(!hideShortcuts
      ? [{ tab: 'shortcuts', label: t('settings:tabs.shortcuts'), keywords: ['shortcuts', 'keyboard', 'hotkey'] }]
      : []),
    { tab: 'about', label: t('settings:tabs.about'), keywords: ['about', 'version', 'acknowledgements'] },
  ], [t, hidePlugins, hideShortcuts]);

  return {
    sidebarNavGroups,
    sidebarNavItems,
    settingsSearchIndex,
  };
}
