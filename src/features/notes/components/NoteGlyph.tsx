import React from 'react';
import { useNoteIcon } from '../noteAppearance';

/** 页面图标（emoji）优先、否则回退到类型图标——标签/侧栏等处与页头保持一致（Notion 同款） */
export const NoteGlyph: React.FC<{ noteId?: string; size?: number; fallback: React.ReactNode; className?: string }> = ({ noteId, size = 15, fallback, className }) => {
  const icon = useNoteIcon(noteId);
  if (!icon) return <>{fallback}</>;
  return (
    <span className={className ? `notes-page-glyph ${className}` : 'notes-page-glyph'} aria-hidden="true"
      style={{ fontSize: Math.round(size * 0.95), width: size, height: size, lineHeight: `${size}px`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {icon}
    </span>
  );
};
