import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowsClockwise,
  CaretDown,
  FileText,
  Files,
  FolderSimple,
  MagnifyingGlass,
  NotePencil,
  SidebarSimple,
  TreeStructure,
  X,
} from '@phosphor-icons/react';
import { dstu, createEmpty, type DstuNode } from '@/dstu';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import { MindMapContentView } from '@/features/mindmap/MindMapContentView';
import { getMindMapStoreForInstance } from '@/features/mindmap/store';
import { isContentDirty } from '../content/contentDirtyRegistry';
import type { AppWindowProps } from '../../core/types';
import {
  forgetWorkspaceResource,
  registerWorkspaceHost,
  setWorkspaceActiveResource,
  type NotesWorkspaceResourceRef,
} from './workspaceRegistry';
import './NotesWorkspaceApp.css';

type ResourceType = NotesWorkspaceResourceRef['type'];

interface WorkspaceTab extends NotesWorkspaceResourceRef {
  key: string;
  title: string;
}

type SaveState = 'saved' | 'saving' | 'dirty';

function getTabSaveState(tab: WorkspaceTab, windowId: string): SaveState {
  if (tab.type === 'note') {
    return isContentDirty('note', tab.id) ? 'dirty' : 'saved';
  }
  const state = getMindMapStoreForInstance(`${windowId}:${tab.key}`, tab.id)?.getState();
  if (state?.isSaving) return 'saving';
  return state?.isDirty ? 'dirty' : 'saved';
}

interface TreeFolder {
  name: string;
  path: string;
  folders: Map<string, TreeFolder>;
  resources: DstuNode[];
}

const resourceType = (value: unknown): ResourceType | null =>
  value === 'note' || value === 'mindmap' ? value : null;

function parseInitialResource(instanceKey: string | null, payload: unknown): NotesWorkspaceResourceRef | null {
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    const type = resourceType(value.resourceType ?? value.type);
    const id = typeof value.resourceId === 'string' ? value.resourceId : instanceKey;
    if (type && id) return { type, id };
  }
  if (!instanceKey) return null;
  return { type: instanceKey.startsWith('mindmap_') ? 'mindmap' : 'note', id: instanceKey };
}

function buildTree(nodes: DstuNode[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '/', folders: new Map(), resources: [] };
  for (const node of nodes) {
    const type = resourceType(node.type);
    if (!type) continue;
    const segments = node.path.split('/').filter(Boolean);
    if (segments.at(-1) === node.id) segments.pop();
    let cursor = root;
    for (const segment of segments) {
      let next = cursor.folders.get(segment);
      if (!next) {
        const path = `${cursor.path === '/' ? '' : cursor.path}/${segment}`;
        next = { name: segment, path, folders: new Map(), resources: [] };
        cursor.folders.set(segment, next);
      }
      cursor = next;
    }
    cursor.resources.push(node);
  }
  return root;
}

const IconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }> = ({
  label,
  children,
  ...props
}) => (
  <button type="button" className="notes-icon-button" aria-label={label} title={label} {...props}>
    {children}
  </button>
);

const ResourceGlyph: React.FC<{ type: ResourceType; size?: number }> = ({ type, size = 15 }) =>
  type === 'note'
    ? <FileText size={size} aria-hidden />
    : <TreeStructure size={size} aria-hidden />;

interface TreeBranchProps {
  folder: TreeFolder;
  depth?: number;
  activeId: string | null;
  onOpen: (ref: NotesWorkspaceResourceRef, title?: string) => void;
  onContextMenu: (event: React.MouseEvent, node: DstuNode) => void;
}

const TreeBranch: React.FC<TreeBranchProps> = ({ folder, depth = 0, activeId, onOpen, onContextMenu }) => {
  const [expanded, setExpanded] = useState(true);
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  const resources = [...folder.resources].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {folder.name && (
        <button
          type="button"
          className="notes-tree-row notes-tree-folder"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <CaretDown size={12} className={expanded ? '' : 'is-collapsed'} aria-hidden />
          <FolderSimple size={15} weight="fill" aria-hidden />
          <span>{folder.name}</span>
        </button>
      )}
      {(folder.name ? expanded : true) && (
        <>
          {folders.map((child) => (
            <TreeBranch
              key={child.path}
              folder={child}
              depth={folder.name ? depth + 1 : depth}
              activeId={activeId}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
            />
          ))}
          {resources.map((node) => {
            const type = node.type as ResourceType;
            return (
              <button
                type="button"
                key={node.id}
                className="notes-tree-row notes-tree-resource"
                data-active={activeId === node.id ? 'true' : 'false'}
                style={{ paddingLeft: 25 + (folder.name ? depth : 0) * 14 }}
                onClick={() => onOpen({ type, id: node.id }, node.name)}
                onContextMenu={(event) => onContextMenu(event, node)}
                data-resource-type={type}
                data-resource-id={node.id}
              >
                <ResourceGlyph type={type} />
                <span>{node.name}</span>
              </button>
            );
          })}
        </>
      )}
    </>
  );
};

interface WorkspacePaneProps {
  tabs: WorkspaceTab[];
  activeKey: string | null;
  windowId: string;
  workspaceActive: boolean;
  onActivate: (key: string) => void;
  onTitleChange: (key: string, title: string) => void;
}

const WorkspacePane: React.FC<WorkspacePaneProps> = ({
  tabs,
  activeKey,
  windowId,
  workspaceActive,
  onActivate,
  onTitleChange,
}) => {
  const active = tabs.find((tab) => tab.key === activeKey) ?? null;
  return (
    <section
      className="notes-workspace-pane"
      data-notes-pane="main"
      data-resource-type={active?.type}
      data-resource-id={active?.id}
      onPointerDown={() => active && onActivate(active.key)}
    >
      <div className="notes-pane-content">
        {!active && (
          <div className="notes-empty-pane">
            <NotePencil size={34} weight="thin" aria-hidden />
            <span>选择一个笔记或思维导图</span>
          </div>
        )}
        {tabs.map((tab) => {
          const visible = tab.key === activeKey;
          return (
            <div className="notes-document-host" hidden={!visible} key={tab.key}>
              {tab.type === 'note' ? (
                <UnifiedAppPanel
                  type="note"
                  resourceId={tab.id}
                  dstuPath={`/${tab.id}`}
                  strictType
                  isActive={workspaceActive && visible}
                  onTitleChange={(title) => onTitleChange(tab.key, title)}
                  className="h-full"
                />
              ) : (
                <MindMapContentView
                  resourceId={tab.id}
                  storeInstanceId={`${windowId}:${tab.key}`}
                  isActive={workspaceActive && visible}
                  onTitleChange={(title) => onTitleChange(tab.key, title)}
                  className="h-full"
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  leftOffset: number;
  saveStates: Map<string, SaveState>;
}

const WorkspaceTabs: React.FC<WorkspaceTabsProps> = ({
  tabs,
  activeKey,
  onActivate,
  onClose,
  leftOffset,
  saveStates,
}) => {
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeKey, tabs.length]);

  const focusTab = (event: React.KeyboardEvent, index: number) => {
    const buttons = event.currentTarget
      .closest('[data-notes-tabstrip]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (!buttons?.length) return;
    const button = buttons.item((index + buttons.length) % buttons.length);
    button?.focus();
    button?.click();
  };
  const handleKeyDown = (event: React.KeyboardEvent, index: number, key: string) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(event, index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(event, index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusTab(event, 0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusTab(event, tabs.length - 1);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onClose(key);
    }
  };

  return (
  <div className="notes-titlebar-tabs" style={{ paddingLeft: leftOffset }}>
    <div ref={stripRef} className="notes-tabstrip" data-notes-tabstrip role="tablist" aria-label="打开的文件">
      {tabs.map((tab, index) => {
        const saveState = saveStates.get(tab.key) ?? 'saved';
        return (
        <div
          className="notes-tab"
          data-active={tab.key === activeKey ? 'true' : 'false'}
          data-save-state={saveState}
          key={tab.key}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            onClose(tab.key);
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.key === activeKey}
            tabIndex={tab.key === activeKey ? 0 : -1}
            onClick={() => onActivate(tab.key)}
            onKeyDown={(event) => handleKeyDown(event, index, tab.key)}
          >
            <ResourceGlyph type={tab.type} size={14} />
            <span>{tab.title}</span>
            {saveState !== 'saved' && (
              <i className="notes-tab-state" aria-label={saveState === 'saving' ? '正在保存' : '未保存'} />
            )}
          </button>
          <IconButton label={`关闭 ${tab.title}`} onClick={() => onClose(tab.key)}>
            <X size={12} />
          </IconButton>
        </div>
      );})}
    </div>
  </div>
  );
};

export const NotesWorkspaceApp: React.FC<AppWindowProps> = ({
  windowId,
  instanceKey,
  launchPayload,
  isActive,
  onTitleChange,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [resources, setResources] = useState<DstuNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(240);
  const [compact, setCompact] = useState(false);
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState('就绪');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [, refreshSaveStates] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ node: DstuNode; x: number; y: number } | null>(null);
  const [resourceDialog, setResourceDialog] = useState<{ mode: 'rename' | 'delete'; node: DstuNode; value: string } | null>(null);
  const initialRef = useRef(parseInitialResource(instanceKey, launchPayload));
  const openResourceRef = useRef<(ref: NotesWorkspaceResourceRef, title?: string) => Promise<void>>(async () => undefined);
  const closeTabRef = useRef<(key: string) => void>(() => undefined);
  const activeTabRef = useRef<WorkspaceTab | null>(null);
  const tabsRef = useRef<WorkspaceTab[]>([]);

  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? null;
  activeTabRef.current = activeTab;
  tabsRef.current = tabs;
  const filteredResources = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? resources.filter((node) => node.name.toLocaleLowerCase().includes(term)) : resources;
  }, [query, resources]);
  const tree = useMemo(() => buildTree(filteredResources), [filteredResources]);
  const titlebarTabsLeft = Math.max(76, 44 + (explorerOpen && !compact ? explorerWidth : 0));
  const saveStates = new Map(tabs.map((tab) => [tab.key, getTabSaveState(tab, windowId)]));

  useLayoutEffect(() => {
    const findTarget = () => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-wb-titlebar-slot]'))
        .find((element) => element.dataset.windowId === windowId) ?? null;
      setTitlebarTarget((current) => current === target ? current : target);
    };
    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [windowId]);

  useEffect(() => {
    if (tabs.length === 0) return;
    const timer = window.setInterval(() => refreshSaveStates((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [tabs.length]);

  const loadResources = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const result = await dstu.list('/', {
      recursive: true,
      types: ['note', 'mindmap'],
      sortBy: 'name',
      sortOrder: 'asc',
    });
    if (result.ok) {
      setResources(result.value.filter((node) => node.type === 'note' || node.type === 'mindmap'));
      setStatus(`${result.value.length} 个文件`);
    } else {
      const message = result.error.toUserMessage();
      setLoadError(message);
      setStatus(message);
    }
    setLoading(false);
  }, []);

  const openResource = useCallback((ref: NotesWorkspaceResourceRef, title?: string) => {
    const key = `${ref.type}:${ref.id}`;
    setTabs((current) => {
      if (current.some((tab) => tab.type === ref.type && tab.id === ref.id)) return current;
      const node = resources.find((item) => item.id === ref.id);
      return [...current, { ...ref, key, title: title ?? node?.name ?? (ref.type === 'note' ? '未命名笔记' : '未命名导图') }];
    });
    setActiveTabKey(key);
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }, [resources]);

  const closeTab = useCallback((key: string) => {
    const currentTab = tabsRef.current.find((tab) => tab.key === key);
    if (currentTab && getTabSaveState(currentTab, windowId) !== 'saved') {
      // Keep the close decision synchronous so ACR and keyboard close share one guard.
      // eslint-disable-next-line no-alert
      const confirmed = window.confirm('此标签页有未保存的更改，确定要关闭吗？');
      if (!confirmed) return;
    }
    if (currentTab) {
      forgetWorkspaceResource({ type: currentTab.type, id: currentTab.id }, windowId);
    }
    setTabs((current) => {
      const closing = current.find((tab) => tab.key === key);
      if (!closing) return current;
      const closingIndex = current.findIndex((tab) => tab.key === key);
      const next = current.filter((tab) => tab.key !== key);
      const neighbor = next[Math.min(closingIndex, next.length - 1)] ?? null;
      setActiveTabKey((active) => active === key ? neighbor?.key ?? null : active);
      return next;
    });
  }, [windowId]);
  closeTabRef.current = closeTab;
  openResourceRef.current = openResource;

  const updateTabTitle = useCallback((key: string, title: string) => {
    if (!title.trim()) return;
    setTabs((current) => current.map((tab) => tab.key === key && tab.title !== title ? { ...tab, title } : tab));
  }, []);

  const renameContextResource = useCallback(async () => {
    const node = resourceDialog?.node;
    if (!node) return;
    const name = resourceDialog.value.trim();
    if (!name || name === node.name) return;
    const result = await dstu.rename(node.path || `/${node.id}`, name);
    if (!result.ok) {
      setStatus(result.error.toUserMessage());
      return;
    }
    updateTabTitle(`${node.type}:${node.id}`, name);
    setResourceDialog(null);
    await loadResources();
  }, [loadResources, resourceDialog, updateTabTitle]);

  const deleteContextResource = useCallback(async () => {
    const node = resourceDialog?.node;
    if (!node) return;
    const result = await dstu.delete(node.path || `/${node.id}`);
    if (!result.ok) {
      setStatus(result.error.toUserMessage());
      return;
    }
    closeTab(`${node.type}:${node.id}`);
    setResourceDialog(null);
    await loadResources();
  }, [closeTab, loadResources, resourceDialog]);

  const createResource = useCallback(async (type: ResourceType) => {
    setStatus(type === 'note' ? '正在创建笔记…' : '正在创建思维导图…');
    const result = await createEmpty({ type });
    if (!result.ok) {
      setStatus(result.error.toUserMessage());
      return;
    }
    await loadResources();
    await openResource({ type, id: result.value.id }, result.value.name);
  }, [loadResources, openResource]);

  useEffect(() => {
    onTitleChange('笔记');
    void loadResources();
    const unwatch = dstu.watch('*', () => void loadResources());
    return () => unwatch();
  }, [loadResources, onTitleChange]);

  useEffect(() => {
    const initial = initialRef.current;
    if (!initial) return;
    initialRef.current = null;
    void openResource(initial);
  }, [openResource]);

  useEffect(() => registerWorkspaceHost(windowId, {
    openResource: (ref) => openResourceRef.current(ref),
    closeResource: (ref) => {
      const tab = tabsRef.current.find((item) => item.type === ref.type && item.id === ref.id);
      if (tab) closeTabRef.current(tab.key);
    },
    getActiveResource: () => {
      const current = activeTabRef.current;
      return current ? { type: current.type, id: current.id } : null;
    },
    listResources: () => tabsRef.current.map((tab) => ({ type: tab.type, id: tab.id })),
  }), [windowId]);

  useEffect(() => {
    setWorkspaceActiveResource(windowId, activeTab ? { type: activeTab.type, id: activeTab.id } : null);
  }, [activeTab, windowId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const nextCompact = entry.contentRect.width < 720;
      setCompact(nextCompact);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 'w') return;
      const current = activeTabRef.current;
      if (!current) return;
      event.preventDefault();
      closeTabRef.current(current.key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive]);

  const startExplorerResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const move = (moveEvent: PointerEvent) => setExplorerWidth(Math.max(200, Math.min(360, startWidth + moveEvent.clientX - startX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [explorerWidth]);

  return (
    <>
      {titlebarTarget ? createPortal(
        <WorkspaceTabs
          tabs={tabs}
          activeKey={activeTabKey}
          onActivate={setActiveTabKey}
          onClose={closeTab}
          leftOffset={titlebarTabsLeft}
          saveStates={saveStates}
        />,
        titlebarTarget,
      ) : null}
      <div
        ref={hostRef}
        className="notes-workspace"
        data-wb-notes-workspace
        data-compact={compact ? 'true' : 'false'}
        data-explorer-open={explorerOpen ? 'true' : 'false'}
        style={{ '--notes-explorer-width': `${explorerWidth}px` } as React.CSSProperties}
      >
      <nav className="notes-ribbon" data-notes-ribbon aria-label="笔记应用导航">
        <div>
          <IconButton label="文件浏览器" data-active={explorerOpen ? 'true' : 'false'} onClick={() => setExplorerOpen((value) => !value)}><Files size={20} /></IconButton>
          <IconButton label="搜索" onClick={() => { setExplorerOpen(true); window.setTimeout(() => hostRef.current?.querySelector<HTMLInputElement>('.notes-search-input')?.focus(), 0); }}><MagnifyingGlass size={20} /></IconButton>
        </div>
        <div />
      </nav>

      <aside className="notes-explorer" data-notes-explorer data-open={explorerOpen ? 'true' : 'false'} aria-hidden={!explorerOpen}>
        <header>
          <span>文件</span>
          <div>
            <IconButton label="新建笔记" onClick={() => void createResource('note')}><FileText size={15} /></IconButton>
            <IconButton label="新建思维导图" onClick={() => void createResource('mindmap')}><TreeStructure size={15} /></IconButton>
            <IconButton label="刷新" onClick={() => void loadResources()}><ArrowsClockwise size={15} /></IconButton>
          </div>
        </header>
        <div className="notes-search">
          <MagnifyingGlass size={14} aria-hidden />
          <input className="notes-search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件…" aria-label="搜索文件" />
          {query && <IconButton label="清除搜索" onClick={() => setQuery('')}><X size={12} /></IconButton>}
        </div>
        <div className="notes-tree" aria-busy={loading} aria-live="polite">
          {loading ? (
            <div className="notes-tree-loading" aria-label="正在读取文件">
              <i /><i /><i /><i />
            </div>
          ) : loadError ? (
            <div className="notes-tree-message" data-state="error">
              <span>文件列表加载失败</span>
              <button type="button" onClick={() => void loadResources()}>重试</button>
            </div>
          ) : filteredResources.length === 0 ? (
            <div className="notes-tree-message" data-state="empty">
              <span>{query ? `没有匹配“${query}”的文件` : '知识库中还没有文件'}</span>
              {query ? (
                <button type="button" onClick={() => setQuery('')}>显示全部文件</button>
              ) : (
                <button type="button" onClick={() => void createResource('note')}>新建笔记</button>
              )}
            </div>
          ) : (
            <TreeBranch
              folder={tree}
              activeId={activeTab?.id ?? null}
              onOpen={(ref, title) => void openResource(ref, title)}
              onContextMenu={(event, node) => {
                event.preventDefault();
                setContextMenu({
                  node,
                  x: Math.min(event.clientX, window.innerWidth - 160),
                  y: Math.min(event.clientY, window.innerHeight - 72),
                });
              }}
            />
          )}
        </div>
        <div className="notes-explorer-resize" onPointerDown={startExplorerResize} />
      </aside>

      {!explorerOpen && <IconButton label="打开文件浏览器" className="notes-explorer-handle" onClick={() => setExplorerOpen(true)}><SidebarSimple size={15} /></IconButton>}
      <main className="notes-workspace-main">
        <div className="notes-panes">
          <WorkspacePane
            tabs={tabs}
            activeKey={activeTabKey}
            windowId={windowId}
            workspaceActive={isActive}
            onActivate={setActiveTabKey}
            onTitleChange={updateTabTitle}
          />
        </div>
        <footer className="notes-statusbar" data-notes-statusbar>
          <span>{status}</span>
          <span>{activeTab ? `${activeTab.type === 'note' ? 'Markdown' : '思维导图'} · ${saveStates.get(activeTab.key) === 'saving' ? '正在保存' : saveStates.get(activeTab.key) === 'dirty' ? '未保存' : '已保存'}` : '本地知识库'}</span>
        </footer>
      </main>
      {explorerOpen && <button className="notes-explorer-scrim" aria-label="关闭文件浏览器" onClick={() => setExplorerOpen(false)} />}
      {contextMenu && (
        <div className="notes-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { setResourceDialog({ mode: 'rename', node: contextMenu.node, value: contextMenu.node.name }); setContextMenu(null); }}>重命名</button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => { setResourceDialog({ mode: 'delete', node: contextMenu.node, value: '' }); setContextMenu(null); }}>删除</button>
        </div>
      )}
      {resourceDialog && (
        <div className="notes-dialog-scrim" role="presentation" onPointerDown={() => setResourceDialog(null)}>
          <div
            className="notes-resource-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notes-resource-dialog-title"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === 'Escape') setResourceDialog(null); }}
          >
            <h2 id="notes-resource-dialog-title">{resourceDialog.mode === 'rename' ? '重命名文件' : '删除文件'}</h2>
            {resourceDialog.mode === 'rename' ? (
              <input
                autoFocus
                value={resourceDialog.value}
                onChange={(event) => setResourceDialog({ ...resourceDialog, value: event.target.value })}
                onKeyDown={(event) => { if (event.key === 'Enter') void renameContextResource(); }}
                aria-label="新文件名"
              />
            ) : <p>将“{resourceDialog.node.name}”移到回收站？</p>}
            <div>
              <button type="button" onClick={() => setResourceDialog(null)}>取消</button>
              <button
                type="button"
                className={resourceDialog.mode === 'delete' ? 'is-danger' : 'is-primary'}
                disabled={resourceDialog.mode === 'rename' && (!resourceDialog.value.trim() || resourceDialog.value.trim() === resourceDialog.node.name)}
                onClick={() => void (resourceDialog.mode === 'rename' ? renameContextResource() : deleteContextResource())}
              >
                {resourceDialog.mode === 'rename' ? '重命名' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
};

export default NotesWorkspaceApp;
