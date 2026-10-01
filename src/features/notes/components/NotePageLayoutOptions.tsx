import React from 'react';
import { useTranslation } from 'react-i18next';
import { NOTE_FONT_STYLES, useNoteAppearance, type NoteFontStyle } from '../noteAppearance';

const FONT_SAMPLE_CLASS: Record<NoteFontStyle, string> = {
  default: 'notes-layout-font--default',
  serif: 'notes-layout-font--serif',
  mono: 'notes-layout-font--mono',
};

/**
 * Notion 页面 ··· 菜单顶部的排版区：三张字体卡 + 小字号/全宽两个独立开关。
 * 所有按钮带 data-keep-open：切换后菜单保持打开，便于连续对比效果。
 */
export const NotePageLayoutOptions: React.FC<{ noteId?: string; showFullWidth?: boolean }> = ({ noteId, showFullWidth = true }) => {
  const { t } = useTranslation('notes');
  const appearance = useNoteAppearance(noteId);
  if (!noteId) return null;
  const disabled = appearance.loading || appearance.error === 'load';
  const { font, smallText, fullWidth } = appearance.value;
  const toggles: Array<{ key: 'smallText' | 'fullWidth'; label: string; checked: boolean }> = [
    { key: 'smallText', label: t('appearance.small_text', '小字号'), checked: smallText },
    ...(showFullWidth ? [{ key: 'fullWidth' as const, label: t('appearance.full_width', '全宽'), checked: fullWidth }] : []),
  ];
  return (
    <div className="notes-layout-options" aria-busy={appearance.saving || undefined}>
      <div className="notes-layout-fonts" role="radiogroup" aria-label={t('appearance.layout', '排版')}>
        {NOTE_FONT_STYLES.map((style) => (
          <button key={style} type="button" role="radio" data-keep-open
            className="notes-layout-font" aria-checked={font === style} disabled={disabled}
            onClick={() => { if (font !== style) void appearance.update({ font: style }); }}>
            <span className={`notes-layout-font-sample ${FONT_SAMPLE_CLASS[style]}`} aria-hidden="true">Ag</span>
            <span className="notes-layout-font-label">{t(`appearance.font_${style}`)}</span>
          </button>
        ))}
      </div>
      {toggles.map((toggle) => (
        <button key={toggle.key} type="button" role="switch" data-keep-open
          className="notes-layout-toggle" aria-checked={toggle.checked} disabled={disabled}
          onClick={() => void appearance.update({ [toggle.key]: !toggle.checked })}>
          <span>{toggle.label}</span>
          <span className="notes-layout-switch" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
};
