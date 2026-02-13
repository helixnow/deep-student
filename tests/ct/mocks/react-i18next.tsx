export const useTranslation = () => ({
  t: (key: string, options?: any) => {
    // Support both i18next signatures:
    // - t(key, { defaultValue })
    // - t(key, defaultValueString)
    if (typeof options === 'string') return options;
    return options?.defaultValue ?? key;
  },
  i18n: {
    changeLanguage: () => Promise.resolve(),
    language: 'en-US',
  },
});

export const initReactI18next = {
  type: '3rdParty',
  init: () => undefined,
};

export default {
  useTranslation,
  initReactI18next,
};







