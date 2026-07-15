export const t = (key: string, options?: any) => {
  // Support both i18next signatures:
  // - t(key, { defaultValue })
  // - t(key, defaultValueString)
  if (typeof options === 'string') return options;
  const value = options?.defaultValue ?? key;
  if (typeof value !== 'string' || !options) return value;

  return value.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (placeholder, name) => {
    const replacement = options[name];
    return replacement == null ? placeholder : String(replacement);
  });
};

export const i18n = {
  changeLanguage: () => Promise.resolve(),
  language: 'en-US',
};

export const useTranslation = () => ({
  t,
  i18n,
});

export const initReactI18next = {
  type: '3rdParty' as const,
  init: () => {},
};

export default {
  useTranslation,
  initReactI18next,
};





