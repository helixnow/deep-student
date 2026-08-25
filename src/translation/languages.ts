/**
 * 翻译语言列表（单一事实来源）
 *
 * 工作台（TranslationMain）与聊天划词翻译（TranslationPopover）共用，
 * 保证两处可选语言一致。所有 code 均被后端 `lang_full_name`
 * （src-tauri/src/translation/pipeline.rs）识别为全称，可安全下发。
 */

export interface TranslationLanguageOption {
  /** 语言代码（后端 lang_full_name 可识别） */
  code: string;
  /** i18n 文案 key（translation:languages.*） */
  labelKey: string;
}

/** 自动检测选项（仅源语言可用） */
export const AUTO_LANGUAGE: TranslationLanguageOption = {
  code: 'auto',
  labelKey: 'translation:languages.auto',
};

/** 可选目标/源语言（不含 auto） */
export const TRANSLATION_LANGUAGES: TranslationLanguageOption[] = [
  { code: 'zh-CN', labelKey: 'translation:languages.zh-CN' },
  { code: 'zh-TW', labelKey: 'translation:languages.zh-TW' },
  { code: 'en', labelKey: 'translation:languages.en' },
  { code: 'ja', labelKey: 'translation:languages.ja' },
  { code: 'ko', labelKey: 'translation:languages.ko' },
  { code: 'fr', labelKey: 'translation:languages.fr' },
  { code: 'de', labelKey: 'translation:languages.de' },
  { code: 'es', labelKey: 'translation:languages.es' },
  { code: 'ru', labelKey: 'translation:languages.ru' },
  { code: 'ar', labelKey: 'translation:languages.ar' },
  { code: 'pt', labelKey: 'translation:languages.pt' },
  { code: 'pt-BR', labelKey: 'translation:languages.pt-BR' },
  { code: 'it', labelKey: 'translation:languages.it' },
  { code: 'vi', labelKey: 'translation:languages.vi' },
  { code: 'th', labelKey: 'translation:languages.th' },
  { code: 'hi', labelKey: 'translation:languages.hi' },
  { code: 'tr', labelKey: 'translation:languages.tr' },
  { code: 'pl', labelKey: 'translation:languages.pl' },
  { code: 'nl', labelKey: 'translation:languages.nl' },
  { code: 'sv', labelKey: 'translation:languages.sv' },
  { code: 'la', labelKey: 'translation:languages.la' },
  { code: 'el', labelKey: 'translation:languages.el' },
  { code: 'uk', labelKey: 'translation:languages.uk' },
  { code: 'id', labelKey: 'translation:languages.id' },
  { code: 'ms', labelKey: 'translation:languages.ms' },
];

/** 源语言列表（auto + 全部语言） */
export const SOURCE_TRANSLATION_LANGUAGES: TranslationLanguageOption[] = [
  AUTO_LANGUAGE,
  ...TRANSLATION_LANGUAGES,
];
