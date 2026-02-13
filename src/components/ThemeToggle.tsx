import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from 'react-i18next';
import './ThemeToggle.css';

interface ThemeToggleProps {
  className?: string;
}

/**
 * 主题切换滑块组件
 * 参考思源笔记的设计风格：简洁、现代、流畅
 */
export const ThemeToggle: React.FC<ThemeToggleProps> = ({ className = '' }) => {
  const { isDarkMode, toggleDarkMode } = useTheme();
  const { t } = useTranslation('common');

  const label = isDarkMode
    ? t('themeToggle.switch_to_light', '切换到亮色模式')
    : t('themeToggle.switch_to_dark', '切换到暗色模式');

  return (
    <button
      className={`theme-toggle ${className}`}
      onClick={toggleDarkMode}
      title={label}
      aria-label={label}
      data-no-drag
    >
      <div className="theme-toggle-track">
        <div className={`theme-toggle-thumb ${isDarkMode ? 'dark' : 'light'}`}>
          {isDarkMode ? (
            <Moon className="theme-toggle-icon" size={12} />
          ) : (
            <Sun className="theme-toggle-icon" size={12} />
          )}
        </div>
      </div>
    </button>
  );
};

export default ThemeToggle;
