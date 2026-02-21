import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { PanelGroup, Panel, PanelResizeHandle, ImperativePanelHandle } from "react-resizable-panels";
import { useNotes } from "./NotesContext";
import { NotesAPI } from "../../utils/notesApi";
import { NotesSidebarV2 } from "./NotesSidebarV2";
import { NotesHeader } from "./NotesHeader";
import { NotesCrepeEditor } from "./NotesCrepeEditor";
import { NotesLibraryDialog } from "./dialogs/NotesLibraryDialog";
import { TrashDialog } from "./dialogs/TrashDialog";
import "./NotesHome.css";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useCommandEvents, COMMAND_EVENTS } from "@/command-palette";
import { useMobileHeader, MobileSlidingLayout } from "../layout";
import { useBreakpoint } from "../../hooks/useBreakpoint";
import { MOBILE_LAYOUT } from "../../config/mobileLayout";

export default function NotesHome() {
  const { t } = useTranslation(['notes', 'common']);
  const { active } = useNotes();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { isSmallScreen } = useBreakpoint();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarRef = useRef<ImperativePanelHandle>(null);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // 移动端统一顶栏配置
  useMobileHeader('notes', {
    title: active?.title || t('notes:sidebar.title', '笔记'),
    showMenu: true,
    onMenuClick: () => setIsMobileSidebarOpen(prev => !prev),
  }, [active?.title, t]);

  // Auto-collapse sidebar on mobile
  useEffect(() => {
    if (isMobile) {
      setSidebarCollapsed(true);
    } else {
      setSidebarCollapsed(false);
      setIsMobileSidebarOpen(false);
    }
  }, [isMobile]);


  const toggleSidebar = () => {
    const panel = sidebarRef.current;
    if (panel) {
        const isCollapsing = !sidebarCollapsed;
        setSidebarCollapsed(isCollapsing);
        
        if (isCollapsing) {
            // Collapse to ~50px
            // react-resizable-panels uses percentages.
            // We assume a min-width via CSS, but to be safe we set a small % or 0 if we were fully hiding.
            // But we want a mini-sidebar.
            // Let's rely on the conditional props (minSize/maxSize) which will force update on re-render.
            // Or we can use resize() to animate it.
            panel.resize(4); 
        } else {
            panel.resize(20); // Expand to default 20%
        }
    } else {
        // Fallback if ref missing
        setSidebarCollapsed(!sidebarCollapsed);
    }
  };


  // 渲染侧边栏
  const renderSidebar = useCallback(() => (
    <NotesSidebarV2
      autoResponsive={false}
      displayMode="panel"
      className="h-full"
      width="full"
      onClose={() => setIsMobileSidebarOpen(false)}
    />
  ), []);

  // 渲染主内容（移动端）
  const renderMobileMainContent = useCallback(() => (
    <div
      className="flex-1 flex flex-col relative h-full overflow-hidden bg-background"
      style={{
        paddingBottom: isSmallScreen ? `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)` : 0,
      }}
    >
      <NotesHeader
      />
      <NotesCrepeEditor />
    </div>
  ), [isSmallScreen]);

  // ===== 移动端布局：DeepSeek 风格推拉式侧边栏 =====
  if (isMobile) {
    return (
      <div className="notes-home-container absolute inset-0 flex flex-col overflow-hidden bg-background text-foreground">
        <NotesEventsBridge />
        <MobileSlidingLayout
          sidebar={
            <div
              className="h-full flex flex-col bg-background"
              style={{
                paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
              }}
            >
              {renderSidebar()}
            </div>
          }
          sidebarOpen={isMobileSidebarOpen}
          onSidebarOpenChange={setIsMobileSidebarOpen}
          enableGesture={true}
          threshold={0.3}
          className="flex-1"
        >
          {renderMobileMainContent()}
        </MobileSlidingLayout>

        {/* Dialogs */}
        <NotesLibraryDialog />
        <TrashDialog />
      </div>
    );
  }

  // ===== 桌面端布局 =====
  return (
      <div className="notes-home-container h-full flex flex-col bg-background text-foreground relative">
        {/* Bridge editor events to NotesContext */}
        <NotesEventsBridge />
        <PanelGroup direction="horizontal" className="flex-1 min-h-0">
          {/* Sidebar - 极简侧边栏 */}
          <Panel
              ref={sidebarRef}
              defaultSize={sidebarCollapsed ? 4 : 20}
              minSize={sidebarCollapsed ? 3 : 15}
              maxSize={sidebarCollapsed ? 6 : 30}
              id="notes-sidebar"
              order={1}
              collapsible={true}
              onCollapse={() => setSidebarCollapsed(true)}
              onExpand={() => setSidebarCollapsed(false)}
              className={`flex flex-col bg-muted/5 transition-all duration-300 ease-in-out ${sidebarCollapsed ? 'min-w-[50px] max-w-[50px]' : 'min-w-[220px]'}`}
          >
              <NotesSidebarV2 />
          </Panel>
          {/* Hide handle when collapsed to prevent resizing the mini-bar */}
          {!sidebarCollapsed && <PanelResizeHandle className="w-px bg-border/40 hover:bg-primary/20 transition-colors" />}

          {/* Editor Area - 核心编辑区 */}
          <Panel className="flex flex-col min-w-[300px] bg-background" minSize={30} id="notes-editor" order={2}>
            <div className="flex-1 flex flex-col relative h-full overflow-hidden">
                <NotesHeader />
                <NotesCrepeEditor />
            </div>
          </Panel>

        </PanelGroup>

        {/* Dialogs */}
        <NotesLibraryDialog />
        <TrashDialog />
      </div>
  );
}

const NotesEventsBridge: React.FC = () => {
  const { 
    setSidebarRevealId, 
    openTab, 
    ensureNoteContent, 
    createNote,
    createFolder,
    active,
    editor,
    saveNoteContent,
  } = useNotes();

  // 原有的 notes:open-note 事件监听
  React.useEffect(() => {
    const handler = (e: any) => {
      const detail = e.detail || {};
      const id: string | undefined = detail.id;
      const title: string | undefined = detail.title;
      if (id) {
        setSidebarRevealId(id);
        openTab(id);
        void ensureNoteContent(id);
      }
    };
    window.addEventListener('notes:open-note' as any, handler as any);
    return () => window.removeEventListener('notes:open-note' as any, handler as any);
  }, [setSidebarRevealId, openTab, ensureNoteContent]);

  // 命令面板事件监听
  useCommandEvents({
    [COMMAND_EVENTS.NOTES_CREATE_NEW]: () => {
      createNote();
    },
    [COMMAND_EVENTS.NOTES_CREATE_FOLDER]: () => {
      createFolder();
    },
    [COMMAND_EVENTS.NOTES_FOCUS_SEARCH]: () => {
      // 聚焦搜索框
      const searchInput = document.querySelector('.notes-sidebar-search input') as HTMLInputElement;
      searchInput?.focus();
    },
    [COMMAND_EVENTS.NOTES_FORCE_SAVE]: () => {
      // 强制保存当前笔记
      if (active && editor) {
        const content = editor.getMarkdown?.() || '';
        saveNoteContent(active.id, content).catch(console.error);
      }
    },
  }, true);

  return null;
};
