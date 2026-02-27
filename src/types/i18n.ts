import 'react-i18next';

declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof import('../locales/zh-CN/common.json');
      sidebar: typeof import('../locales/zh-CN/sidebar.json');
      settings: typeof import('../locales/zh-CN/settings.json');
      analysis: typeof import('../locales/zh-CN/analysis.json');
      enhanced_rag: typeof import('../locales/zh-CN/enhanced_rag.json');
      anki: typeof import('../locales/zh-CN/anki.json');
      template: typeof import('../locales/zh-CN/template.json');
      data: typeof import('../locales/zh-CN/data.json');
      chat_host: typeof import('../locales/zh-CN/chat_host.json');
      chat_module: typeof import('../locales/zh-CN/chat_module.json');
      chatV2: typeof import('../locales/zh-CN/chatV2.json');
      notes: typeof import('../locales/zh-CN/notes.json');
      exam_sheet: typeof import('../locales/zh-CN/exam_sheet.json');
      card_manager: typeof import('../locales/zh-CN/card_manager.json');
      dev: typeof import('../locales/zh-CN/dev.json');
      drag_drop: typeof import('../locales/zh-CN/drag_drop.json');
      pdf: typeof import('../locales/zh-CN/pdf.json');
      textbook: typeof import('../locales/zh-CN/textbook.json');
      graph_conflict: typeof import('../locales/zh-CN/graph_conflict.json');
      translation: typeof import('../locales/zh-CN/translation.json');
      essay_grading: typeof import('../locales/zh-CN/essay_grading.json');
      app_menu: typeof import('../locales/zh-CN/app_menu.json');
      learningHub: typeof import('../locales/zh-CN/learningHub.json');
      dstu: typeof import('../locales/zh-CN/dstu.json');
      migration: typeof import('../locales/zh-CN/migration.json');
      skills: typeof import('../locales/zh-CN/skills.json');
      command_palette: typeof import('../locales/zh-CN/command_palette.json');
      backend_errors: typeof import('../locales/zh-CN/backend_errors.json');
      mcp: typeof import('../locales/zh-CN/mcp.json');
      workspace: typeof import('../locales/zh-CN/workspace.json');
      stats: typeof import('../locales/zh-CN/stats.json');
      llm_usage: typeof import('../locales/zh-CN/llm_usage.json');
      review: typeof import('../locales/zh-CN/review.json');
      practice: typeof import('../locales/zh-CN/practice.json');
      sync: typeof import('../locales/zh-CN/sync.json');
      mindmap: typeof import('../locales/zh-CN/mindmap.json');
      forms: typeof import('../locales/zh-CN/forms.json');
      console: typeof import('../locales/zh-CN/console.json');
      cloudStorage: typeof import('../locales/zh-CN/cloudStorage.json');
    };
  }
}

export type SupportedLanguage = 'zh-CN' | 'en-US';

export interface LanguageOption {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
}

export const supportedLanguages: LanguageOption[] = [
  {
    code: 'zh-CN',
    name: 'Chinese (Simplified)',
    nativeName: '简体中文',
  },
  {
    code: 'en-US',
    name: 'English',
    nativeName: 'English',
  },
];

export const normalizeSupportedLanguage = (language?: string | null): SupportedLanguage => {
  const normalized = (language ?? '').toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized.startsWith('en')) {
    return 'en-US';
  }
  return 'en-US';
};