/**
 * 笔记工作区的演示外壳：学习桌面里笔记的标签页是 portal 进窗口标题栏的
 * （[data-wb-titlebar-slot]），演示壳不画标题栏，这里补一条 40px 的标题栏位。
 * 左段与文件树侧栏同宽同色，标签页落在正文上方，和桌面窗口一致。
 *
 * 另外接上学习桌面 WorkbenchEventBridge 的那几条「打开资源」事件（双链点击、
 * 由笔记生成导图后自动打开），演示里没有桌面总线，直接交给工作区宿主。
 *
 * 只在 load() 里动态加载（引用 react 与应用组件）。
 */
import React from 'react';
import type { AppWindowProps } from '@/features/workbench/core/types';
import { requestWorkspaceResource } from '@/features/workbench/apps/notes/workspaceRegistry';
import { publishNotesHeadingTarget } from '@/features/notes/headingTargetBridge';
import { shouldWorkbenchHandleOpenNote, type DstuOpenNoteDetail } from '@/features/notes/openNoteEvent';
import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu/folderEvents';
import { NotificationContainer } from '@/components/NotificationContainer';

function openInWorkspace(id: string, windowId: string): void {
  const type = id.startsWith('mm_') ? 'mindmap' : 'note';
  void requestWorkspaceResource({ type, id }, windowId);
}

function useOpenResourceEvents(windowId: string): void {
  React.useEffect(() => {
    const onOpenNote = (event: Event) => {
      const detail = (event as CustomEvent<DstuOpenNoteDetail>).detail;
      if (!shouldWorkbenchHandleOpenNote(detail) || !detail?.noteId) return;
      if (detail.heading) publishNotesHeadingTarget({ noteId: detail.noteId, heading: detail.heading });
      openInWorkspace(detail.noteId, windowId);
    };
    const onNavigateToNote = (event: Event) => {
      const noteId = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
      if (noteId) openInWorkspace(noteId, windowId);
    };
    const onNavigateToView = (event: Event) => {
      const openResource = (event as CustomEvent<{ openResource?: string }>).detail?.openResource;
      const id = typeof openResource === 'string' ? openResource.trim().replace(/^\/+/, '') : '';
      if (!id) return;
      // 新生成的导图要先出现在文件树里（桌面版由后端的资源变更事件刷新）
      window.dispatchEvent(new CustomEvent(DSTU_FOLDER_CHANGE_EVENT, { detail: { kind: 'item-added' } }));
      openInWorkspace(id, windowId);
    };
    window.addEventListener('DSTU_OPEN_NOTE', onOpenNote);
    window.addEventListener('navigateToNote', onNavigateToNote);
    window.addEventListener('NAVIGATE_TO_VIEW', onNavigateToView);
    return () => {
      window.removeEventListener('DSTU_OPEN_NOTE', onOpenNote);
      window.removeEventListener('navigateToNote', onNavigateToNote);
      window.removeEventListener('NAVIGATE_TO_VIEW', onNavigateToView);
    };
  }, [windowId]);
}

const BAR_HEIGHT = 40;

export function createNotesDemoWindow(Inner: React.ComponentType<AppWindowProps>): React.FC<AppWindowProps> {
  const NotesDemoWindow: React.FC<AppWindowProps> = (props) => {
    const rootRef = React.useRef<HTMLDivElement>(null);
    const barRef = React.useRef<HTMLDivElement>(null);
    useOpenResourceEvents(props.windowId);

    // 标题栏左段跟随侧栏的实际宽度与底色（收起 / 窄窗时侧栏宽度会变）
    React.useEffect(() => {
      const root = rootRef.current;
      const bar = barRef.current;
      if (!root || !bar) return;
      const sync = () => {
        const aside = root.querySelector<HTMLElement>('[data-wb-notes-workspace] aside');
        const width = aside && aside.offsetParent !== null ? aside.getBoundingClientRect().width : 0;
        bar.style.setProperty('--demo-notes-sidebar-w', `${Math.round(width)}px`);
        if (aside) bar.style.setProperty('--demo-notes-sidebar-bg', getComputedStyle(aside).backgroundColor);
      };
      sync();
      const resize = new ResizeObserver(sync);
      resize.observe(root);
      const mutation = new MutationObserver(sync);
      mutation.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-explorer-open', 'data-compact'] });
      return () => {
        resize.disconnect();
        mutation.disconnect();
      };
    }, []);

    return React.createElement(
      'div',
      {
        ref: rootRef,
        'data-wb-window-id': props.windowId,
        style: { display: 'flex', flexDirection: 'column', height: '100%', width: '100%' },
      },
      React.createElement(
        'div',
        {
          ref: barRef,
          style: {
            position: 'relative',
            flex: `0 0 ${BAR_HEIGHT}px`,
            borderBottom: '1px solid hsl(var(--border))',
            background:
              'linear-gradient(to right, var(--demo-notes-sidebar-bg, transparent) var(--demo-notes-sidebar-w, 0px), hsl(var(--background)) var(--demo-notes-sidebar-w, 0px))',
            '--wb-macos-traffic-lights-inset': '0px',
          } as React.CSSProperties,
        },
        React.createElement('div', {
          className: 'wb-title-app-slot',
          'data-wb-titlebar-slot': '',
          'data-window-id': props.windowId,
          style: { position: 'absolute', inset: 0, zIndex: 5, overflow: 'hidden', pointerEvents: 'none' },
        }),
      ),
      React.createElement('div', { style: { position: 'relative', flex: '1 1 auto', minHeight: 0 } }, React.createElement(Inner, props)),
      // 演示壳不渲染 App 壳里的全局通知宿主（保存成功、生成导图、需要桌面版等提示）
      React.createElement(NotificationContainer),
    );
  };
  return NotesDemoWindow;
}
