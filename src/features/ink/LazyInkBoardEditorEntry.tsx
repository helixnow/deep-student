import React, { lazy, Suspense } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { InkBoardEditorProps } from './InkBoardEditor';

const InkBoardEditorHost = lazy(() => import('./LazyInkBoardEditor').then((module) => ({
  default: module.LazyInkBoardEditor,
})));

/**
 * Light lazy entry for schema-v2 board documents, mirroring LazyInkEditorEntry.
 *
 * DstuFileViewer imports this entry statically, so it must not statically pull
 * the chat/learning-hub graph inside LazyInkBoardEditor. Only the board route
 * pays that load, behind the lazy boundary.
 */
export function LazyInkBoardEditor(props: InkBoardEditorProps) {
  const { t } = useTranslation('ink');
  return (
    <Suspense fallback={
      <div className="flex h-full items-center justify-center gap-2" role="status">
        <CircleNotch size={20} className="animate-spin text-muted-foreground" aria-hidden="true" />
        <span>{t('status.loading')}</span>
      </div>
    }>
      <InkBoardEditorHost {...props} />
    </Suspense>
  );
}
