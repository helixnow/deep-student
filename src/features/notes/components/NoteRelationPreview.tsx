import React, { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { DsDialog } from '@/components/ui/DsDialog';
import { requestPdfPageFocus } from '@/features/workbench/apps/content/pdfFocusAck';
import { type NoteRelation } from '../noteRelations';

const UnifiedAppPanel = lazy(() => import('@/features/learning-hub/apps/UnifiedAppPanel'));

/** Self-contained reader: works in both shells without relying on whichever global handler is active. */
export function NoteRelationPreview({ relation, onClose }: { relation: NoteRelation; onClose: () => void }) {
  const { t } = useTranslation('notes');
  const tRef = useRef(t);
  tRef.current = t;
  const focusScopeId = useId();
  const [sourceId, setSourceId] = useState('');
  const [card, setCard] = useState<{ front: string; back: string }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const locatorType = relation.locator.type;
  const locatorValue = relation.locator.type === 'whole' ? '' : relation.locator.value;

  useEffect(() => {
    let active = true;
    setSourceId(''); setCard(undefined); setError(''); setLoading(true);
    const load = async () => {
      if (locatorType === 'card') {
        const cards = await invoke<Array<{ id: string; front: string; back: string; text?: string }>>('get_document_cards', { documentId: relation.resource_id });
        const found = cards.find((item) => item.id === String(locatorValue));
        if (!found) throw new Error(tRef.current('learning.relations.missing', { defaultValue: '资源或定位目标已失效' }));
        if (active) setCard({ front: found.front || found.text || '', back: found.back });
      } else {
        const resource = await invoke<{ sourceId?: string } | null>('vfs_get_resource', { resourceId: relation.resource_id });
        if (!resource?.sourceId) throw new Error(tRef.current('learning.relations.missing', { defaultValue: '资源或定位目标已失效' }));
        if (active) setSourceId(resource.sourceId);
      }
    };
    void load().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [relation.resource_id, locatorType, locatorValue]);

  useEffect(() => {
    if (!sourceId || locatorType !== 'page') return;
    const targetPage = typeof locatorValue === 'number' ? locatorValue : Number(locatorValue);
    if (!Number.isInteger(targetPage) || targetPage < 1) return;
    let cancelled = false;
    const delays = [120, 450, 1000, 2000];
    let timer: number | undefined;
    const attempt = (idx: number) => {
      if (cancelled || idx >= delays.length) return;
      timer = window.setTimeout(() => {
        if (cancelled) return;
        void requestPdfPageFocus(sourceId, targetPage, focusScopeId).then((res) => {
          if (!cancelled && !res.handled) attempt(idx + 1);
        });
      }, delays[idx]);
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sourceId, locatorType, locatorValue, focusScopeId]);

  const focus = async () => {
    setError('');
    if (relation.locator.type === 'page') {
      const result = await requestPdfPageFocus(sourceId, relation.locator.value, focusScopeId);
      if (!result.handled) setError(t('learning.relations.focus_failed', { defaultValue: '阅读器尚未完成定位，请加载后重试。' }));
    } else if (relation.locator.type === 'question') {
      let handled = false;
      window.dispatchEvent(new CustomEvent('qbank:focus-question', { detail: { targetScopeId: focusScopeId, targetResourceId: sourceId, questionId: relation.locator.value,
        acknowledge: (result: { handled: boolean }) => { handled = result.handled; } } }));
      if (!handled) setError(t('learning.relations.focus_failed', { defaultValue: '阅读器尚未完成定位，请加载后重试。' }));
    }
  };
  return <DsDialog open onOpenChange={(open) => { if (!open) onClose(); }} showClose={false}
    aria-label={t('learning.relations.preview', { defaultValue: '关联资源预览' })} maxWidth="max-w-6xl" className="h-[85dvh]">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b p-3">
      <span
        className="min-w-0 flex-1 truncate"
        title={`${relation.resource_id}${relation.locator.type !== 'whole' ? ` · ${relation.locator.value}` : ''}`}
      >
        {relation.resource_id}{relation.locator.type !== 'whole' && ` · ${relation.locator.value}`}
      </span>
      {sourceId && (relation.locator.type === 'page' || relation.locator.type === 'question') && <button type="button" onClick={() => void focus()}>
        {t('learning.relations.locate', { defaultValue: '定位到关联位置' })}</button>}
      <button type="button" onClick={onClose}>{t('learning.relations.close', { defaultValue: '关闭预览' })}</button>
    </div>
    {error && <p role="alert" className="p-3 text-destructive">{error}</p>}
    {loading && <p role="status" className="p-3">{t('learning.loading')}</p>}
    {card && <div className="min-h-0 overflow-auto break-words p-6"><p className="whitespace-pre-wrap">{card.front}</p><hr className="my-4" /><p className="whitespace-pre-wrap">{card.back}</p></div>}
    {sourceId && <Suspense fallback={<p role="status">{t('learning.loading')}</p>}><UnifiedAppPanel type={relation.type === 'mistake' ? 'exam' : 'file'}
      resourceId={sourceId} dstuPath={`/${sourceId}`} focusScopeId={focusScopeId} readOnly isActive preferNodeType className="min-h-0 flex-1" /></Suspense>}
  </DsDialog>;
}
