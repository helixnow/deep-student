import React, { lazy, Suspense } from 'react';

type NotesCrepeEditorProps = React.ComponentProps<typeof import('./NotesCrepeEditor').NotesCrepeEditor>;
type NotesContextPanelProps = React.ComponentProps<typeof import('./NotesContextPanel').NotesContextPanel>;
type NotesLibraryManagerProps = React.ComponentProps<typeof import('./NotesLibraryManager').NotesLibraryManager>;
type AIDiffPanelProps = React.ComponentProps<typeof import('./AIDiffPanel').AIDiffPanel>;

const Editor = lazy(() => import('./NotesCrepeEditor').then((module) => ({ default: module.NotesCrepeEditor })));
const ContextPanel = lazy(() => import('./NotesContextPanel').then((module) => ({ default: module.NotesContextPanel })));
const LibraryManager = lazy(() => import('./NotesLibraryManager').then((module) => ({ default: module.NotesLibraryManager })));
const DiffPanel = lazy(() => import('./AIDiffPanel').then((module) => ({ default: module.AIDiffPanel })));

export function NotesCrepeEditor(props: NotesCrepeEditorProps) {
  return (
    <Suspense fallback={null}>
      <Editor {...props} />
    </Suspense>
  );
}

export function NotesContextPanel(props: NotesContextPanelProps) {
  return (
    <Suspense fallback={null}>
      <ContextPanel {...props} />
    </Suspense>
  );
}

export function NotesLibraryManager(props: NotesLibraryManagerProps) {
  return (
    <Suspense fallback={null}>
      <LibraryManager {...props} />
    </Suspense>
  );
}

export function AIDiffPanel(props: AIDiffPanelProps) {
  return (
    <Suspense fallback={null}>
      <DiffPanel {...props} />
    </Suspense>
  );
}
