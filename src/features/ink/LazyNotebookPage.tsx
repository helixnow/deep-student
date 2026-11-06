import React, { lazy, Suspense } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

const NotebookPage = lazy(() => import('./NotebookPage'));

export type LazyNotebookPageProps = React.ComponentProps<typeof import('./NotebookPage').NotebookPage>;

export function LazyNotebookPage(props: LazyNotebookPageProps) {
  const { t } = useTranslation('ink');
  return (
    <Suspense fallback={
      <div className="flex h-full items-center justify-center gap-2" role="status">
        <CircleNotch size={20} className="animate-spin text-muted-foreground" aria-hidden="true" />
        <span>{t('notebook.loading')}</span>
      </div>
    }>
      <NotebookPage {...props} />
    </Suspense>
  );
}
