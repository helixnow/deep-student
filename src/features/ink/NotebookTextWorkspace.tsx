import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import type { DstuNode } from '@/dstu';
import { DsButton } from '@/components/ui/DsButton';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { MobileSubviewChromeProvider, useMobileSubviewChromeHost } from '@/components/layout/MobileSubviewChromeContext';
import { NotesChromeSlotContext } from '@/features/notes';
import { LazyNoteContentView } from '@/features/learning-hub';
import { hasContentSaveHandler, isContentDirty, saveContentNow, type ContentSaveState } from '@/services/contentDirtyRegistry';
import { BACK_PRIORITY, registerVisibilityGuardedBackHandler } from '@/services/androidBackRegistry';
import { Z_INDEX } from '@/config/zIndex';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import './Notebook.css';

interface NotebookTextWorkspaceProps {
  node: DstuNode;
  isActive: boolean;
  onClose: () => void;
}

export default function NotebookTextWorkspace({ node, isActive, onClose }: NotebookTextWorkspaceProps) {
  const { t } = useTranslation('ink');
  const [title, setTitle] = useState(node.name);
  const [chromeSlot, setChromeSlot] = useState<HTMLDivElement | null>(null);
  const [closing, setClosing] = useState(false);
  const [saveState, setSaveState] = useState<ContentSaveState | 'loading'>('loading');
  const [closeFailed, setCloseFailed] = useState(false);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const activeRef = useRef(isActive);
  const rootRef = useFocusTrap<HTMLElement>(isActive);
  const ownerId = useId();
  const mobileLayout = useMobileLayoutSafe();
  const enterFullscreen = mobileLayout?.enterFullscreen;
  const exitFullscreen = mobileLayout?.exitFullscreen;
  const { activeSubviewChrome, subviewChromeHost } = useMobileSubviewChromeHost();
  activeRef.current = isActive;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useLayoutEffect(() => {
    if (!isActive) return;
    const previousToolbarLayer = document.body.style.getPropertyValue('--notebook-text-toolbar-z-index');
    document.body.dataset.notebookTextEditor = ownerId;
    document.body.style.setProperty('--notebook-text-toolbar-z-index', String(Z_INDEX.modal));
    enterFullscreen?.(ownerId);
    return () => {
      if (document.body.dataset.notebookTextEditor === ownerId) {
        delete document.body.dataset.notebookTextEditor;
        if (previousToolbarLayer) document.body.style.setProperty('--notebook-text-toolbar-z-index', previousToolbarLayer);
        else document.body.style.removeProperty('--notebook-text-toolbar-z-index');
      }
      exitFullscreen?.(ownerId);
    };
  }, [isActive, ownerId, enterFullscreen, exitFullscreen]);

  const handleClose = useCallback(async () => {
    if (!activeRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    setCloseFailed(false);
    try {
      const dirty = isContentDirty('note', node.id);
      const saved = !dirty || (hasContentSaveHandler('note', node.id) && await saveContentNow('note', node.id));
      if (!mountedRef.current || !activeRef.current) return;
      if (!saved || isContentDirty('note', node.id)) {
        setCloseFailed(true);
        return;
      }
      onClose();
    } catch {
      if (mountedRef.current) setCloseFailed(true);
    } finally {
      closingRef.current = false;
      if (mountedRef.current) setClosing(false);
    }
  }, [node.id, onClose]);

  useEffect(() => {
    if (!isActive) return;
    return registerVisibilityGuardedBackHandler(rootRef, () => {
      void handleClose();
      return true;
    }, BACK_PRIORITY.view);
  }, [handleClose, isActive, rootRef]);

  useEventRegistry([{
    target: 'window', type: 'beforeunload', listener: ((event: BeforeUnloadEvent) => {
      if (!isContentDirty('note', node.id)) return;
      event.preventDefault();
      event.returnValue = '';
    }) as EventListener,
  }], [node.id]);

  useEffect(() => () => {
    if (isContentDirty('note', node.id) && hasContentSaveHandler('note', node.id)) {
      void saveContentNow('note', node.id);
    }
  }, [node.id]);

  return createPortal(
    <MobileSubviewChromeProvider value={subviewChromeHost}>
      <section
        ref={rootRef}
        className="notebook-text-workspace"
        style={{ zIndex: Z_INDEX.modal }}
        hidden={!isActive}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid="notebook-text-workspace"
        data-notebook-document-id={node.id}
        data-notebook-closing={closing}
        data-notebook-save-state={saveState}
        data-overlay-container="true"
        data-gesture-ignore
      >
        <header className="notebook-writing-header">
          <DsButton
            variant="ghost"
            size="icon"
            onClick={activeSubviewChrome?.onBack ?? (() => void handleClose())}
            disabled={closing}
            aria-label={t(activeSubviewChrome ? 'notebook.backToNote' : 'notebook.backToLibrary')}
            title={t(activeSubviewChrome ? 'notebook.backToNote' : 'notebook.backToLibrary')}
          >
            {closing ? <CircleNotch size={20} className="animate-spin" aria-hidden /> : <ArrowLeft size={20} aria-hidden />}
          </DsButton>
          <h1 className="notebook-writing-title">{activeSubviewChrome?.title ?? title}</h1>
          <div className="notebook-writing-actions" ref={setChromeSlot} hidden={Boolean(activeSubviewChrome)} />
          {activeSubviewChrome?.rightActions}
        </header>
        {closeFailed && (
          <div className="notebook-error" role="alert">
            <WarningCircle size={20} aria-hidden />
            <span>{t('notebook.saveBeforeCloseFailed')}</span>
            <DsButton variant="ghost" onClick={() => void handleClose()} disabled={closing}>
              {t('notebook.retry')}
            </DsButton>
          </div>
        )}
        <div className="notebook-writing-content">
          <NotesChromeSlotContext.Provider value={chromeSlot}>
            <LazyNoteContentView
              node={node}
              isActive={isActive}
              focusOnActive
              onClose={() => void handleClose()}
              onTitleChange={setTitle}
              onSaveStateChange={setSaveState}
            />
          </NotesChromeSlotContext.Provider>
        </div>
      </section>
    </MobileSubviewChromeProvider>,
    document.body,
  );
}
