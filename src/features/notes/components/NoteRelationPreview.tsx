import React, { lazy, Suspense, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { requestPdfPageFocus } from '@/features/workbench/apps/content/pdfFocusAck';
import { type NoteRelation } from '../noteRelations';

const UnifiedAppPanel = lazy(() => import('@/features/learning-hub/apps/UnifiedAppPanel'));

/** Self-contained reader: works in both shells without relying on whichever global handler is active. */
export function NoteRelationPreview({ relation, onClose }: { relation: NoteRelation; onClose: () => void }) {
  const { t } = useTranslation('notes');
  const [sourceId, setSourceId] = useState('');
  const [card, setCard] = useState<{ front: string; back: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (relation.locator.type === 'card') {
        const cards = await invoke<Array<{ id: string; front: string; back: string; text?: string }>>('get_document_cards', { documentId: relation.resource_id });
        const found = cards.find((item) => item.id === (relation.locator as { value: string }).value);
        if (!found) throw new Error(t('learning.relations.missing', { defaultValue: '资源或定位目标已失效' }));
        if (active) setCard({ front: found.front || found.text || '', back: found.back });
      } else {
        const resource = await invoke<{ sourceId?: string } | null>('vfs_get_resource', { resourceId: relation.resource_id });
        if (!resource?.sourceId) throw new Error(t('learning.relations.missing', { defaultValue: '资源或定位目标已失效' }));
        if (active) setSourceId(resource.sourceId);
      }
    };
    void load().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [relation, t]);
  const focus = async () => {
    setError('');
    if (relation.locator.type === 'page') {
      const result = await requestPdfPageFocus(sourceId, relation.locator.value);
      if (!result.handled) setError(t('learning.relations.focus_failed', { defaultValue: '阅读器尚未完成定位，请加载后重试。' }));
    } else if (relation.locator.type === 'question') {
      let handled = false;
      window.dispatchEvent(new CustomEvent('qbank:focus-question', { detail: { targetResourceId: sourceId, questionId: relation.locator.value,
        acknowledge: (result: { handled: boolean }) => { handled = result.handled; } } }));
      if (!handled) setError(t('learning.relations.focus_failed', { defaultValue: '阅读器尚未完成定位，请加载后重试。' }));
    }
  };
  return <div role="dialog" aria-modal="true" aria-label={t('learning.relations.preview', { defaultValue: '关联资源预览' })}
    className="fixed inset-4 z-[100] flex flex-col rounded-lg border bg-background shadow-xl">
    <div className="flex items-center justify-between gap-3 border-b p-3">
      <span>{relation.resource_id}{relation.locator.type !== 'whole' && ` · ${relation.locator.value}`}</span>
      {sourceId && (relation.locator.type === 'page' || relation.locator.type === 'question') && <button type="button" onClick={() => void focus()}>
        {t('learning.relations.locate', { defaultValue: '定位到关联位置' })}</button>}
      <button type="button" onClick={onClose}>{t('learning.relations.close', { defaultValue: '关闭预览' })}</button>
    </div>
    {error && <p role="alert" className="p-3 text-destructive">{error}</p>}
    {card && <div className="overflow-auto p-6"><p className="whitespace-pre-wrap">{card.front}</p><hr className="my-4" /><p className="whitespace-pre-wrap">{card.back}</p></div>}
    {sourceId && <Suspense fallback={<p role="status">{t('learning.loading')}</p>}><UnifiedAppPanel type={relation.type === 'mistake' ? 'exam' : 'file'}
      resourceId={sourceId} dstuPath={`/${sourceId}`} readOnly isActive preferNodeType className="min-h-0 flex-1" /></Suspense>}
  </div>;
}
