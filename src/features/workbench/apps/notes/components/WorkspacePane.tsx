import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FileArrowUp,
  FileText,
  MagnifyingGlass,
  Notebook,
  Robot,
  TreeStructure,
} from '@phosphor-icons/react';
import type { DstuNode } from '@/dstu';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import type { NoteBreadcrumbItem } from '@/features/notes/components/NotesEditorHeader';
import { NotesChromeSlotVisibleContext } from '@/features/notes/notesChromeSlot';
import { DsButton } from '@/components/ui/DsButton';
import { isMacOS } from '@/utils/platform';
import {
  getTabSaveState,
  type SaveState,
  type WorkspacePaneId,
  type WorkspaceTab,
} from '../workspaceTreeModel';
import { ResourceGlyph } from './WorkspaceTabStrip';

// 导图视图懒加载：@xyflow/react 体积大，只有导图标签页真正展示时才拉取，
// 避免拖入 Notes 窗口启动 chunk（加载态用下方轻量占位）
const MindMapContentView = React.lazy(() =>
  import('@/features/mindmap/MindMapContentView').then((module) => ({
    default: module.MindMapContentView,
  })),
);

/** 导图 pane 懒加载占位：与文档树加载骨架同款脉冲条 */
const MindMapPaneFallback: React.FC = () => (
  <div className="notes-mindmap-loading" aria-hidden="true">
    <i /><i /><i />
  </div>
);

export interface WorkspacePaneProps {
  paneId: WorkspacePaneId;
  tabs: WorkspaceTab[];
  activeKey: string | null;
  windowId: string;
  workspaceActive: boolean;
  onActivate: (key: string) => void;
  onTitleChange: (key: string, title: string) => void;
  onSaveStateChange: (key: string, state: SaveState) => void;
  onCreateNote?: () => void;
  onCreateMindmap?: () => void;
  onOpenSearch?: () => void;
  onImport?: () => void;
  onAskAgent?: () => void;
  recentResources?: readonly DstuNode[];
  onOpenRecent?: (node: DstuNode) => void;
  getNoteBreadcrumbs?: (noteId: string, title: string) => readonly NoteBreadcrumbItem[];
  onNoteBreadcrumbClick?: (item: NoteBreadcrumbItem) => void;
  suppressFloatingToc?: boolean;
}

export const WorkspacePane: React.FC<WorkspacePaneProps> = ({
  paneId,
  tabs,
  activeKey,
  windowId,
  workspaceActive,
  onActivate,
  onTitleChange,
  onSaveStateChange,
  onCreateNote,
  onCreateMindmap,
  onOpenSearch,
  onImport,
  onAskAgent,
  recentResources,
  onOpenRecent,
  getNoteBreadcrumbs,
  onNoteBreadcrumbClick,
  suppressFloatingToc = false,
}) => {
  const { t } = useTranslation(['workbench', 'notes']);
  const active = tabs.find((tab) => tab.key === activeKey) ?? null;
  const modKey = isMacOS() ? '⌘' : 'Ctrl+';
  // 只挂载当前 + 最近 1 个标签的完整编辑器：后台标签不再用 hidden 常驻整份 Crepe，
  // 显著压低窗口 DOM 规模（拖窗每帧税 ∝ 节点数）。内容已由 DSTU/脏标记持久化。
  const [mountedKeys, setMountedKeys] = useState<string[]>(() => (activeKey ? [activeKey] : []));
  useEffect(() => {
    if (!activeKey) return;
    setMountedKeys((prev) => {
      const next = [activeKey, ...prev.filter((key) => key !== activeKey)];
      const living = new Set(tabs.map((tab) => tab.key));
      const livingNext = next.filter((key) => living.has(key));
      // C3：脏/保存中的标签豁免淘汰——切到第三篇时不能以卸载换取内存下降，
      // 未持久化草稿必须先有主人（与 Learning Hub 的 dirty 额外保活同策略）。
      const keep = livingNext.slice(0, 2);
      const keepSet = new Set(keep);
      const tabByKey = new Map(tabs.map((tab) => [tab.key, tab]));
      for (const key of livingNext) {
        if (keepSet.has(key)) continue;
        const tab = tabByKey.get(key);
        if (tab && getTabSaveState(tab, windowId) !== 'saved') {
          keepSet.add(key);
        }
      }
      return livingNext.filter((key) => keepSet.has(key));
    });
  }, [activeKey, tabs, windowId]);

  return (
    <section
      className="notes-workspace-pane"
      data-notes-pane={paneId}
      data-focused={workspaceActive ? 'true' : 'false'}
      data-resource-type={active?.type}
      data-resource-id={active?.id}
      role="region"
      aria-label={paneId === 'main'
        ? t('notesWorkspace.panes.main', 'Main editor')
        : t('notesWorkspace.panes.right', 'Right editor')}
      onPointerDown={() => active && onActivate(active.key)}
    >
      <div className="notes-pane-content">
        {!active && (
          <div className="nes-empty-pane notes-empty-pane" data-nes-empty-pane>
            <div className="nes-empty-pane__inner ui-zoom-fade-in">
              <div className="nes-empty-pane__icon" aria-hidden>
                <Notebook size={48} weight="thin" />
              </div>
              <p className="nes-empty-pane__title">
                {t('workbench:notesWorkspace.empty.paneTitle')}
              </p>
              <div className="nes-empty-pane__actions">
                <DsButton
                  variant="outline"
                  size="sm"
                  className="nes-action"
                  onClick={() => onCreateNote?.()}
                >
                  <FileText size={14} aria-hidden />
                  {t('workbench:notesWorkspace.empty.paneNewNote')}
                </DsButton>
                {onCreateMindmap && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="nes-action nes-action--ghost"
                    onClick={() => onCreateMindmap()}
                  >
                    <TreeStructure size={14} aria-hidden />
                    {t('notes:workspace.emptyNewMindmap')}
                  </DsButton>
                )}
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="nes-action nes-action--ghost"
                  onClick={() => onOpenSearch?.()}
                >
                  <MagnifyingGlass size={14} aria-hidden />
                  {t('workbench:notesWorkspace.empty.paneOpenSearch')}
                </DsButton>
                <DsButton variant="ghost" size="sm" className="nes-action nes-action--ghost" onClick={onImport}>
                  <FileArrowUp size={14} aria-hidden />
                  {t('workbench:notesWorkspace.empty.paneImport', 'Import notes')}
                </DsButton>
                <DsButton variant="ghost" size="sm" className="nes-action nes-action--ghost" onClick={onAskAgent}>
                  <Robot size={14} aria-hidden />
                  {t('workbench:notesWorkspace.empty.paneAskAgent', 'Ask Agent')}
                </DsButton>
              </div>
              {recentResources && recentResources.length > 0 && onOpenRecent && (
                <div
                  className="flex w-full max-w-xs flex-col gap-1 border-t border-border/50 pt-3 text-left"
                  data-testid="notes-empty-recents"
                >
                  <p className="px-2 text-2xs font-medium text-muted-foreground/70">
                    {t('notes:workspace.recentSectionTitle')}
                  </p>
                  {recentResources.map((node) => (
                    <DsButton
                      key={`${node.type}:${node.id}`}
                      variant="ghost"
                      size="sm"
                      title={node.name}
                      className="h-7 w-full min-w-0 justify-start gap-2 px-2 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150 motion-reduce:transition-none"
                      onClick={() => onOpenRecent(node)}
                    >
                      <ResourceGlyph type={node.type === 'mindmap' ? 'mindmap' : 'note'} id={node.id} size={14} />
                      <span className="min-w-0 truncate">
                        {t('notes:workspace.resumeItem', { title: node.name })}
                      </span>
                    </DsButton>
                  ))}
                </div>
              )}
              <ul className="nes-empty-pane__hints">
                <li className="nes-empty-pane__hint">
                  <kbd className="nes-kbd">{modKey}P</kbd>
                  <span>{t('notes:workspace.hintQuickSwitch')}</span>
                </li>
                <li className="nes-empty-pane__hint">
                  <kbd className="nes-kbd">{modKey}O</kbd>
                  <span>{t('workbench:notesWorkspace.empty.hintQuickOpen')}</span>
                </li>
                <li className="nes-empty-pane__hint">
                  <kbd className="nes-kbd">{modKey}N</kbd>
                  <span>{t('workbench:notesWorkspace.empty.hintNewNote')}</span>
                </li>
                <li className="nes-empty-pane__hint">
                  <kbd className="nes-kbd">{modKey}\</kbd>
                  <span>{t('notes:workspace.hintToggleSidebar')}</span>
                </li>
              </ul>
            </div>
          </div>
        )}
        {tabs
          .filter((tab) => mountedKeys.includes(tab.key))
          .map((tab) => {
            const visible = tab.key === activeKey;
            return (
              <div className="notes-document-host" hidden={!visible} key={tab.key}>
                {tab.type === 'note' ? (
                  <NotesChromeSlotVisibleContext.Provider value={visible}>
                    <UnifiedAppPanel
                      type="note"
                      resourceId={tab.id}
                      dstuPath={`/${tab.id}`}
                      strictType
                      isActive={workspaceActive && visible}
                      focusOnActive={workspaceActive && visible}
                      hostWindowId={windowId}
                      propertiesPanelDisabled
                      noteBreadcrumbs={getNoteBreadcrumbs?.(tab.id, tab.title)}
                      onNoteBreadcrumbClick={onNoteBreadcrumbClick}
                      suppressFloatingToc={suppressFloatingToc}
                      onTitleChange={(title) => onTitleChange(tab.key, title)}
                      onSaveStateChange={(state) => onSaveStateChange(tab.key, state)}
                      className="h-full"
                    />
                  </NotesChromeSlotVisibleContext.Provider>
                ) : (
                  <React.Suspense fallback={<MindMapPaneFallback />}>
                    <MindMapContentView
                      resourceId={tab.id}
                      storeInstanceId={`${windowId}:${tab.key}`}
                      isActive={workspaceActive && visible}
                      focusOnActive={workspaceActive && visible}
                      onTitleChange={(title) => onTitleChange(tab.key, title)}
                      onSaveStateChange={(state) => onSaveStateChange(tab.key, state)}
                      className="h-full"
                    />
                  </React.Suspense>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
};
