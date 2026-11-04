import React, { Suspense, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import {
  notifyNotebookHostChanged,
  registerNotebookHost,
  type NotebookHostPageProps,
  type NotebookHostState,
  type NotebookHostStateChange,
} from './hostLifecycle';

const LazyNotebookPage = React.lazy<React.ComponentType<NotebookHostPageProps>>(() => import('@/features/ink').then((module) => ({
  default: module.LazyNotebookPage,
})));

const NotebookAppWindow: React.FC<AppWindowProps> = ({ windowId, isActive, onTitleChange }) => {
  const { t } = useTranslation('workbench');
  const hostState = useRef<NotebookHostState | null>(null);
  const onHostStateChange = useCallback<NotebookHostStateChange>((state) => {
    hostState.current = state;
    notifyNotebookHostChanged(windowId);
  }, [windowId]);

  useLayoutEffect(() => registerNotebookHost(windowId, () => hostState.current), [windowId]);
  useEffect(() => {
    onTitleChange(t('workbench:apps.notebook'));
  }, [onTitleChange, t]);

  return (
    <div className="relative h-full w-full min-w-0 overflow-hidden bg-background" data-wb-app="notebook">
      <Suspense fallback={null}>
        <LazyNotebookPage isActive={isActive} onHostStateChange={onHostStateChange} />
      </Suspense>
    </div>
  );
};

export default NotebookAppWindow;
