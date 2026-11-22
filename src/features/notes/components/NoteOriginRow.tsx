import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChatCircleText, FileText, ArrowUpRight } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { DstuNode } from '@/dstu';
import { navigateToNoteOrigin, noteOriginFromNode } from '../noteOrigin';
import '../styles/notes-form-controls.css';

/** 属性面板首行：「来自对话 / 来自资料第 N 页」，点击回到来源（与 Notion 页面「创建自」同位） */
export const NoteOriginRow: React.FC<{ node: Pick<DstuNode, 'metadata'> | null | undefined }> = ({ node }) => {
  const { t } = useTranslation('notes');
  const origin = noteOriginFromNode(node);
  if (!origin) return null;
  const Icon = origin.kind === 'chat' ? ChatCircleText : FileText;
  const chapterMatch = origin.kind === 'resource' && origin.locator ? /^chapter:(\d+)$/i.exec(origin.locator) : null;
  const label = origin.kind === 'chat'
    ? t('origin.chat', { defaultValue: '来自对话' })
    : origin.page
      ? t('origin.resource_page', { defaultValue: '来自资料 · 第 {{page}} 页', page: origin.page })
      : chapterMatch
        ? t('origin.resource_chapter', { defaultValue: '来自资料 · 第 {{chapter}} 章', chapter: chapterMatch[1] })
        : origin.locator
          ? t('origin.resource_locator', { defaultValue: '来自资料 · {{locator}}', locator: origin.locator })
          : t('origin.resource', { defaultValue: '来自资料' });
  return (
    <div className="notes-origin-row">
      <span className="notes-origin-label">{t('origin.label', { defaultValue: '来源' })}</span>
      <DsButton variant="ghost" size="sm" className="notes-origin-link" onClick={() => { void navigateToNoteOrigin(origin); }}
        title={t('origin.open', { defaultValue: '回到来源' })}>
        <Icon size={13} aria-hidden="true" />
        <span className="notes-origin-text">{origin.title ? `${label} · ${origin.title}` : label}</span>
        <ArrowUpRight size={11} aria-hidden="true" className="notes-origin-arrow" />
      </DsButton>
    </div>
  );
};
