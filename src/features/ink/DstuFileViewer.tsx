import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import { dstu } from '@/dstu';
import type { EditorProps } from '@/dstu/editorTypes';
import type { DstuNode } from '@/dstu/types';
import { isInkFile } from '@/dstu/inkFormat';
import { flushInkWorkspace } from '@/services/inkWorkspaceRegistry';
import { InkWorkspace } from './InkWorkspace';

const FileViewerWrapper = lazy(() => import('@/dstu/editors/FileViewerWrapper').then((module) => ({ default: module.FileViewerWrapper })));

export type DstuFileViewerProps = EditorProps;

function isInkNode(node: DstuNode | null | undefined): node is DstuNode {
  if (!node?.id) return false;
  const canonicalMime = node.metadata?.canonicalMime;
  const mimeType = typeof canonicalMime === 'string' ? canonicalMime : node.metadata?.mimeType;
  return isInkFile(typeof mimeType === 'string' ? mimeType : undefined, node.name);
}

export function DstuFileViewer(props: DstuFileViewerProps) {
  const { t } = useTranslation('dstu');
  const [loaded, setLoaded] = useState<{ path: string; node: DstuNode | null }>();
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const [switchBlocked, setSwitchBlocked] = useState(false);
  const [savingSwitch, setSavingSwitch] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const isLoading = loaded?.path !== props.path;
  const loadedNode = loaded?.node;

  useEffect(() => {
    let active = true;
    setSwitchBlocked(false);
    setSavingSwitch(false);
    const applyNode = async (node: DstuNode | null) => {
      if (!active) return;
      const previous = loadedRef.current;
      if (previous?.path !== props.path && isInkNode(previous?.node) && !isInkNode(node)) {
        setSavingSwitch(true);
        const saved = await flushInkWorkspace(previous.node.id);
        if (!active) return;
        setSavingSwitch(false);
        if (!saved) {
          setSwitchBlocked(true);
          return;
        }
      }
      setLoaded({ path: props.path, node });
    };
    void dstu.get(props.path).then((result) => applyNode(result.ok ? result.value : null))
      .catch(() => applyNode(null));
    return () => { active = false; };
  }, [attempt, props.path]);

  if (isInkNode(loadedNode)) {
    const resolving = isLoading && !switchBlocked && !savingSwitch;
    return (
      <div className={`h-full min-h-0 ${props.className ?? ''}`} aria-busy={resolving}>
        <div className="h-full min-h-0" hidden={resolving}>
          <InkWorkspace
            documentId={loadedNode.id} title={loadedNode.name} isActive={!resolving} onClose={props.onClose}
            onRetryExit={switchBlocked ? () => setAttempt((value) => value + 1) : undefined}
          />
        </div>
        {resolving && <div className="flex h-full items-center justify-center" role="status"><CircleNotch size={20} className="animate-spin" /><span className="sr-only">{t('preview.loading')}</span></div>}
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
