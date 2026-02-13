import 'react-i18next';

declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof import('../locales/zh-CN/common.json');
      sidebar: typeof import('../locales/zh-CN/sidebar.json');
      settings: typeof import('../locales/zh-CN/settings.json');
      analysis: typeof import('../locales/zh-CN/analysis.json');
      translation: typeof import('../locales/zh-CN/translation.json');
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