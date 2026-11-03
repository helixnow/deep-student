import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import { dstu } from '@/dstu';
import type { EditorProps } from '@/dstu/editorTypes';
import type { DstuNode } from '@/dstu/types';
import { isInkFile } from '@/dstu/inkFormat';
import { LazyInkEditor } from './LazyInkEditorEntry';

const FileViewerWrapper = lazy(() => import('@/dstu/editors/FileViewerWrapper').then((module) => ({ default: module.FileViewerWrapper })));

export type DstuFileViewerProps = EditorProps;

export function DstuFileViewer(props: DstuFileViewerProps) {
  const { t } = useTranslation('dstu');
  const [loaded, setLoaded] = useState<{ path: string; node: DstuNode | null }>();
  const isLoading = loaded?.path !== props.path;

  useEffect(() => {
    let active = true;
    void dstu.get(props.path).then((result) => {
      if (active) setLoaded({ path: props.path, node: result.ok ? result.value : null });
    }).catch(() => {
      if (active) setLoaded({ path: props.path, node: null });
    });
    return () => { active = false; };
  }, [props.path]);

  if (isLoading || !loaded) {
    return <div className="flex h-full items-center justify-center" role="status"><CircleNotch size={20} className="animate-spin" /><span className="sr-only">{t('preview.loading')}</span></div>;
  }

  const node = loaded.node;
  const canonicalMime = node?.metadata?.canonicalMime;
  const mimeType = typeof canonicalMime === 'string' ? canonicalMime : node?.metadata?.mimeType;
  if (node && isInkFile(typeof mimeType === 'string' ? mimeType : undefined, node.name)) {
    return <LazyInkEditor documentId={node.id} className={props.className} />;
  }

  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center" role="status"><CircleNotch size={20} className="animate-spin" /><span className="sr-only">{t('preview.loading')}</span></div>}>
      <FileViewerWrapper {...props} />
    </Suspense>
  );
}
