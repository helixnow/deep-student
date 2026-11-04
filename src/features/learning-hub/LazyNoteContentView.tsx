import React, { lazy, Suspense } from 'react';
import type { ContentViewProps } from './apps/UnifiedAppPanel';

const NoteContentView = lazy(() => import('./apps/views/NoteContentView'));

export function LazyNoteContentView(props: ContentViewProps) {
  return (
    <Suspense fallback={null}>
      <NoteContentView {...props} />
    </Suspense>
  );
}
