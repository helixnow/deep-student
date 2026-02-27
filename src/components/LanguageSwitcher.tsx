import React from 'react';
import { useTranslation } from 'react-i18next';
import { type SupportedLanguage, normalizeSupportedLanguage } from '../types/i18n';

interface LanguageSwitcherProps {
  className?: string;
}

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({ className = '' }) => {
  const { i18n, t } = useTranslation('common');

  const handleToggle = () => {
    const currentLang = normalizeSupportedLanguage(i18n.language);
    const newLang: SupportedLanguage = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';
    void i18n.changeLanguage(newLang);
  };

  const isEnglishActive = normalizeSupportedLanguage(i18n.language) === 'en-US';

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className={`text-sm ${!isEnglishActive ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
        {t('language_switcher.chinese')}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={isEnglishActive}
        onClick={handleToggle}
        className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-all duration-300 ease-in-out focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 ${
          isEnglishActive
            ? 'bg-primary text-primary-foreground border-transparent hover:bg-primary/90'
            : 'bg-muted text-muted-foreground border-border hover:bg-muted/80'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-background shadow-md transition-transform duration-300 ease-in-out ${
            isEnglishActive ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      <span className={`text-sm ${isEnglishActive ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
        {t('language_switcher.english')}
      </span>
    </div>
  );
};
