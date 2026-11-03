import React, { lazy, Suspense } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { InkEditorProps } from './InkEditor';

const InkEditorHost = lazy(() => import('./LazyInkEditor').then((module) => ({ default: module.LazyInkEditor })));

export function LazyInkEditor(props: InkEditorProps) {
  const { t } = useTranslation('dstu');
  return (
    <Suspense fallback={
      <div className="flex h-full items-center justify-center gap-2" role="status">
        <CircleNotch size={20} className="animate-spin text-muted-foreground" aria-hidden="true" />
        <span>{t('preview.loading')}</span>
      </div>
    }>
      <InkEditorHost {...props} />
    </Suspense>
  );
}
