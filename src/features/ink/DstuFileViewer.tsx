import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import { dstu } from '@/dstu';
import type { EditorProps } from '@/dstu/editorTypes';
import type { DstuNode } from '@/dstu/types';
import { isInkFile } from '@/dstu/inkFormat';
import { InkWorkspace } from './InkWorkspace';

const FileViewerWrapper = lazy(() => import('@/dstu/editors/FileViewerWrapper').then((module) => ({ default: module.FileViewerWrapper })));

export type DstuFileViewerProps = EditorProps;

export function DstuFileViewer(props: DstuFileViewerProps) {
  const { t } = useTranslation('dstu');
  const [loaded, setLoaded] = useState<{ path: string; node: DstuNode | null }>();
  const isLoading = loaded?.path !== props.path;
  const loadedNode = loaded?.node;
  const loadedNodeId = loadedNode?.id;
  const canonicalMime = loadedNode?.metadata?.canonicalMime;
  const mimeType = typeof canonicalMime === 'string' ? canonicalMime : loadedNode?.metadata?.mimeType;
  const isInk = Boolean(loadedNodeId && loadedNode && isInkFile(
    typeof mimeType === 'string' ? mimeType : undefined,
    loadedNode.name,
  ));

  useEffect(() => {
    let active = true;
    void dstu.get(props.path).then((result) => {
      if (active) setLoaded({ path: props.path, node: result.ok ? result.value : null });
    }).catch(() => {
      if (active) setLoaded({ path: props.path, node: null });
    });
    return () => { active = false; };
  }, [props.path]);

  if (isInk && loadedNode) {
    return (
      <div className={`h-full min-h-0 ${props.className ?? ''}`} aria-busy={isLoading}>
        <div className="h-full min-h-0" hidden={isLoading}>
          <InkWorkspace documentId={loadedNode.id} title={loadedNode.name} isActive={!isLoading} onClose={props.onClose} />
        </div>
        {isLoading && <div className="flex h-full items-center justify-center" role="status"><CircleNotch size={20} className="animate-spin" /><span className="sr-only">{t('preview.loading')}</span></div>}
      </div>
    );
  }

  if (isLoading || !loaded) {
    return <div className="flex h-full items-center justify-center" role="status"><CircleNotch size={20} className="animate-spin" /><span className="sr-only">{t('preview.loading')}</span></div>;
  }

  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center" role="status"><CircleNotch size={20} className="animate-spin" /><span className="sr-only">{t('preview.loading')}</span></div>}>
      <FileViewerWrapper {...props} />
    </Suspense>
  );
}
