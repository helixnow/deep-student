import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowSquareOut,
  ArrowUp,
  ChatCircleDots,
  FloppyDisk,
  FolderOpen,
  MagnifyingGlass,
  Printer,
  X,
} from '@phosphor-icons/react';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import { useReferenceToChat, type SourceType } from '@/features/learning-hub/useReferenceToChat';
import type { DstuNode } from '@/dstu/types';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { fileManager } from '@/utils/fileManager';
import { getErrorMessage } from '@/utils/errorUtils';
import type { AppWindowProps } from '../../core/types';
import { ContentEmptyState } from '../content/ContentEmptyState';
import { normalizeResourceInstanceKey } from '../content/resourceIdentity';
import './FilePreviewAppWindow.css';

const MAX_SEARCH_MATCHES = 2_000;

interface SearchState {
  ranges: Range[];
  current: number;
}

export interface PreviewSelectionMetadata {
  selectedText?: string;
  locator?: string;
}

function closestElement(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

export function getPreviewSelectionMetadata(root: HTMLElement): PreviewSelectionMetadata {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return {};
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return {};

  const selectedText = selection.toString().trim().slice(0, 4_000);
  const startElement = closestElement(range.startContainer);
  const endElement = closestElement(range.endContainer);

  const startCell = startElement?.closest<HTMLElement>('[data-xlsx-cell]');
  const endCell = endElement?.closest<HTMLElement>('[data-xlsx-cell]');
  if (startCell) {
    const sheet = startCell.closest<HTMLElement>('[data-xlsx-sheet]')?.dataset.xlsxSheet;
    const start = startCell.dataset.xlsxCell;
    const end = endCell?.dataset.xlsxCell;
    const cellRange = end && end !== start ? `${start}:${end}` : start;
    return { selectedText, locator: sheet && cellRange ? `${sheet}!${cellRange}` : cellRange };
  }

  const slide = startElement?.closest('.pptx-preview-slide-wrapper');
  if (slide?.parentElement) {
    const slides = Array.from(slide.parentElement.querySelectorAll(':scope > .pptx-preview-slide-wrapper'));
    return { selectedText, locator: `slide:${Math.max(1, slides.indexOf(slide) + 1)}` };
  }

  const section = startElement?.closest('section.docx-preview, section.docx');
  if (section?.parentElement) {
    const sections = Array.from(section.parentElement.querySelectorAll(':scope > section'));
    return { selectedText, locator: `section:${Math.max(1, sections.indexOf(section) + 1)}` };
  }

  const pre = startElement?.closest('pre');
  if (pre) {
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(pre);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const startLine = prefixRange.toString().split(/\r\n|\r|\n/).length;
    const lineCount = selectedText.split(/\r\n|\r|\n/).length;
    return {
      selectedText,
      locator: lineCount > 1 ? `lines:${startLine}-${startLine + lineCount - 1}` : `line:${startLine}`,
    };
  }

  return selectedText ? { selectedText } : {};
}

function clearCssHighlights(names: { all: string; current: string }): void {
  const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  registry?.delete(names.all);
  registry?.delete(names.current);
}

function applyCssHighlights(ranges: Range[], current: number, names: { all: string; current: string }): void {
  const registry = (globalThis.CSS as unknown as {
    highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void };
  } | undefined)?.highlights;
  const HighlightCtor = (globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight;
  if (!registry || !HighlightCtor) return;

  registry.set(names.all, new HighlightCtor(...ranges));
  if (ranges[current]) {
    registry.set(names.current, new HighlightCtor(ranges[current]));
  } else {
    registry.delete(names.current);
  }
}

function findTextRanges(root: HTMLElement, query: string): Range[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[data-file-preview-toolbar]')) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, textarea, input, [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node && ranges.length < MAX_SEARCH_MATCHES) {
    const text = node.textContent ?? '';
    const lower = text.toLocaleLowerCase();
    let offset = lower.indexOf(normalized);
    while (offset >= 0 && ranges.length < MAX_SEARCH_MATCHES) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + normalized.length);
      ranges.push(range);
      offset = lower.indexOf(normalized, offset + Math.max(1, normalized.length));
    }
    node = walker.nextNode();
  }
  return ranges;
}

function sourceTypeForNode(node: DstuNode): SourceType | null {
  if (node.type === 'textbook') return 'textbook';
  if (node.type === 'image') return 'image';
  if (node.type === 'file') return 'file';
  return null;
}

const FilePreviewAppWindow: React.FC<AppWindowProps> = ({
  instanceKey,
  isActive,
  onTitleChange,
  requestClose,
}) => {
  const { t } = useTranslation(['workbench', 'common', 'learningHub']);
  const resourceId = normalizeResourceInstanceKey(instanceKey);
  const highlightNames = useMemo(() => {
    const suffix = instanceKey.replace(/[^a-zA-Z0-9_-]/g, '-');
    return {
      all: `file-preview-search-${suffix}`,
      current: `file-preview-search-current-${suffix}`,
    };
  }, [instanceKey]);
  const previewRootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [node, setNode] = useState<DstuNode | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>({ ranges: [], current: 0 });
  const epubSelectionRef = useRef<PreviewSelectionMetadata>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const { referenceToChat, canReferenceToChat } = useReferenceToChat();
  const isEpub = node?.name.split('.').pop()?.toLowerCase() === 'epub';

  const openSearch = useCallback(() => {
    if (isEpub) {
      previewRootRef.current?.querySelector('[data-epub-preview]')?.dispatchEvent(
        new CustomEvent('epub-preview-open-search')
      );
      return;
    }
    setSearchOpen((value) => !value);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [isEpub]);

  useEffect(() => {
    if (!node) return;
    let cancelled = false;
    setSourcePath(null);
    void invoke<string | null>('vfs_get_file_blob_path', { id: node.id })
      .then((path) => {
        if (!cancelled) setSourcePath(path || (node.metadata?.filePath as string | undefined) || null);
      })
      .catch(() => {
        if (!cancelled) setSourcePath((node.metadata?.filePath as string | undefined) || null);
      });
    return () => { cancelled = true; };
  }, [node]);

  useEffect(() => {
    clearCssHighlights(highlightNames);
    if (!searchOpen || !searchQuery.trim() || !previewRootRef.current) {
      setSearchState({ ranges: [], current: 0 });
      return;
    }

    const root = previewRootRef.current;
    let frame = 0;
    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const ranges = findTextRanges(root, searchQuery);
        applyCssHighlights(ranges, 0, highlightNames);
        setSearchState({ ranges, current: 0 });
      });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearCssHighlights(highlightNames);
    };
  }, [highlightNames, searchOpen, searchQuery, node?.id]);

  useEffect(() => () => clearCssHighlights(highlightNames), [highlightNames]);

  useEffect(() => {
    const root = previewRootRef.current;
    const handleEpubSelection = (event: Event) => {
      epubSelectionRef.current = (event as CustomEvent<PreviewSelectionMetadata>).detail ?? {};
    };
    root?.addEventListener('file-preview-selection', handleEpubSelection);
    return () => root?.removeEventListener('file-preview-selection', handleEpubSelection);
  }, []);

  useEffect(() => {
    epubSelectionRef.current = {};
  }, [node?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      if (previewRootRef.current?.querySelector('[data-epub-preview]')) {
        previewRootRef.current.querySelector('[data-epub-preview]')?.dispatchEvent(
          new CustomEvent('epub-preview-open-search')
        );
      } else {
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    const root = previewRootRef.current;
    root?.addEventListener('keydown', onKeyDown);
    return () => root?.removeEventListener('keydown', onKeyDown);
  }, []);

  const navigateSearch = useCallback((delta: number) => {
    setSearchState((previous) => {
      if (!previous.ranges.length) return previous;
      const current = (previous.current + delta + previous.ranges.length) % previous.ranges.length;
      applyCssHighlights(previous.ranges, current, highlightNames);
      previous.ranges[current]?.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { ...previous, current };
    });
  }, [highlightNames]);

  const fileFilters = useMemo(() => {
    if (!node) return undefined;
    const extension = node.name.split('.').pop()?.toLowerCase();
    return extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined;
  }, [node]);

  const runAction = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusyAction(name);
    try {
      await action();
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }, []);

  const handleSave = useCallback(() => runAction('save', async () => {
    if (!node || !sourcePath) throw new Error(t('learningHub:file.downloadUnavailable', '原文件不可用'));
    const result = await fileManager.saveFromSource({
      sourcePath,
      defaultFileName: node.name,
      filters: fileFilters,
      title: t('common:saveAs', '另存为'),
    });
    if (!result.canceled) showGlobalNotification('success', t('common:downloadSuccess', '保存成功'));
  }), [fileFilters, node, runAction, sourcePath, t]);

  const handleOpen = useCallback(() => runAction('open', async () => {
    if (!sourcePath) throw new Error(t('learningHub:file.downloadUnavailable', '原文件不可用'));
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(sourcePath);
  }), [runAction, sourcePath, t]);

  const handleReveal = useCallback(() => runAction('reveal', async () => {
    if (!sourcePath) throw new Error(t('learningHub:file.downloadUnavailable', '原文件不可用'));
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(sourcePath);
  }), [runAction, sourcePath, t]);

  const handleReference = useCallback(() => runAction('reference', async () => {
    if (!node) return;
    const sourceType = sourceTypeForNode(node);
    if (!sourceType) throw new Error(t('learningHub:contextMenu.referenceNotSupported', '该资源暂不支持引用'));
    const domSelectionMetadata = previewRootRef.current
      ? getPreviewSelectionMetadata(previewRootRef.current)
      : {};
    const selectionMetadata = domSelectionMetadata.selectedText
      ? domSelectionMetadata
      : epubSelectionRef.current;
    await referenceToChat({
      sourceType,
      sourceId: node.sourceId || node.id,
      metadata: { title: node.name, ...selectionMetadata },
    });
  }), [node, referenceToChat, runAction, t]);

  if (!resourceId) {
    return (
      <ContentEmptyState
        title={t('workbench:content.missingResource', '缺少资源标识，无法打开该窗口')}
        description={t('workbench:content.missingResourceHint', '请从资源库重新打开，或检查该资源是否仍存在。')}
      />
    );
  }

  return (
    <div ref={previewRootRef} className="wb-file-preview" data-file-preview-root tabIndex={-1}>
      <style>{`
        ::highlight(${highlightNames.all}) { background: rgb(250 204 21 / 50%); }
        ::highlight(${highlightNames.current}) { background: rgb(249 115 22 / 80%); color: #111; }
      `}</style>
      <div className="wb-file-preview-toolbar" data-file-preview-toolbar role="toolbar" aria-label={t('workbench:apps.filePreview', '文件预览')}>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={openSearch} title={t('common:search', '搜索')} aria-label={t('common:search', '搜索')}>
          <MagnifyingGlass size={16} />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleSave} disabled={!sourcePath || busyAction !== null} title={t('common:saveAs', '另存为')} aria-label={t('common:saveAs', '另存为')}>
          <FloppyDisk size={16} />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpen} disabled={!sourcePath || busyAction !== null} title={t('learningHub:file.openExternal', '使用系统应用打开')} aria-label={t('learningHub:file.openExternal', '使用系统应用打开')}>
          <ArrowSquareOut size={16} />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleReveal} disabled={!sourcePath || busyAction !== null} title={t('common:showInFolder', '在文件夹中显示')} aria-label={t('common:showInFolder', '在文件夹中显示')}>
          <FolderOpen size={16} />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={() => window.print()} title={t('common:print', '打印')} aria-label={t('common:print', '打印')}>
          <Printer size={16} />
        </NotionButton>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleReference} disabled={!node || !canReferenceToChat() || busyAction !== null} title={t('learningHub:contextMenu.referenceToChat', '引用到对话')} aria-label={t('learningHub:contextMenu.referenceToChat', '引用到对话')}>
          <ChatCircleDots size={16} />
        </NotionButton>
        {searchOpen && (
          <div className="wb-file-preview-search">
            <input ref={searchInputRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t('common:search', '搜索')} aria-label={t('common:search', '搜索')} />
            <span>{searchState.ranges.length ? `${searchState.current + 1}/${searchState.ranges.length}` : '0/0'}</span>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => navigateSearch(-1)} disabled={!searchState.ranges.length} aria-label={t('common:previous', '上一个')}><ArrowUp size={14} /></NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => navigateSearch(1)} disabled={!searchState.ranges.length} aria-label={t('common:next', '下一个')}><ArrowDown size={14} /></NotionButton>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => { setSearchOpen(false); setSearchQuery(''); }} aria-label={t('common:close', '关闭')}><X size={14} /></NotionButton>
          </div>
        )}
      </div>
      <div className="wb-file-preview-content" data-file-preview-content>
        <UnifiedAppPanel
          type="file"
          resourceId={resourceId}
          dstuPath={`/${resourceId}`}
          preferNodeType
          isActive={isActive}
          onNodeLoaded={setNode}
          onTitleChange={onTitleChange}
          onClose={requestClose}
          className="h-full"
        />
      </div>
    </div>
  );
};

export default FilePreviewAppWindow;
