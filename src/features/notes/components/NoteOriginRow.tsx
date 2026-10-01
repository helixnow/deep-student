import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChatCircleText, FileText, ArrowUpRight } from '@phosphor-icons/react';
import type { DstuNode } from '@/dstu';
import { navigateToNoteOrigin, noteOriginFromNode } from '../noteOrigin';
import '../styles/notes-form-controls.css';

/** 属性面板首行：「来自对话 / 来自资料第 N 页」，点击回到来源（与 Notion 页面「创建自」同位） */
export const NoteOriginRow: React.FC<{ node: Pick<DstuNode, 'metadata'> | null | undefined }> = ({ node }) => {
  const { t } = useTranslation('notes');
  const origin = noteOriginFromNode(node);
  if (!origin) return null;
  const Icon = origin.kind === 'chat' ? ChatCircleText : FileText;
  const label = origin.kind === 'chat'
    ? t('origin.chat', { defaultValue: '来自对话' })
    : origin.page
      ? t('origin.resource_page', { defaultValue: '来自资料 · 第 {{page}} 页', page: origin.page })
      : t('origin.resource', { defaultValue: '来自资料' });
  return (
    <div className="notes-origin-row">
      <span className="notes-origin-label">{t('origin.label', { defaultValue: '来源' })}</span>
      <button type="button" className="notes-origin-link" onClick={() => { void navigateToNoteOrigin(origin); }}
        title={t('origin.open', { defaultValue: '回到来源' })}>
        <Icon size={13} aria-hidden="true" />
        <span className="notes-origin-text">{origin.title ? `${label} · ${origin.title}` : label}</span>
        <ArrowUpRight size={11} aria-hidden="true" className="notes-origin-arrow" />
      </button>
    </div>
  );
};
