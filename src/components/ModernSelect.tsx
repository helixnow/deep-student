import React, { useState, useRef, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import './ModernSelect.css';

export interface ModernSelectProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  fullWidth?: boolean;
}

// 一个轻量级、无依赖的自定义下拉选择器
const ModernSelect: React.FC<ModernSelectProps> = ({
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
  fullWidth = true,
}) => {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const displayPlaceholder = placeholder ?? t('modernSelect.placeholder', '请选择');

  // 处理点击外部时自动关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div
      className={`modern-select ${fullWidth ? 'full-width' : ''} ${disabled ? 'disabled' : ''}`}
      ref={containerRef}
    >
      <NotionButton
        variant="ghost"
        className="select-trigger"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
      >
        <span className="selected-text">{value || displayPlaceholder}</span>
        <span className="arrow">▾</span>
      </NotionButton>
      {open && (
        <ul className="options-list">
          {options.map((opt) => (
            <li
              key={opt}
              className={opt === value ? 'selected' : ''}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ModernSelect;
