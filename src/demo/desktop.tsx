/**
 * Web 演示壳 - 学习桌面模式（demo.html?desktop=1）
 *
 * 桌面端打开就是学习桌面（desktop.workbenchMode 缺省为 true），这里让演示也能开出来：
 * - 演示构建剔除了设置、待办、资源库等页面（vite.demo.config.ts 的 DEMO_PAGE_STUBS），
 *   它们在桌面上照样能从 Dock / 应用面板打开。除 DEMO_APPS 外的应用，窗口里换成一张
 *   说明卡，而不是一扇空窗或报错页。
 * - 开场：对话窗口打开剧本会话，闪卡停在「今日复习」，两扇窗并排摆在桌面小组件左边。
 *   官网海报（ds-web docs/public/features/workbench-*.webp）就是这个画面。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '@/features/workbench/core/types';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { FLOATING_DOCK_CLEARANCE } from '@/features/workbench/core/metrics';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import { setDockPinned } from '@/features/workbench/components/DockPinnedStore';
import { WB_SYS_WIDTH_MEDIUM, WB_SYS_WIDTH_WIDE } from '@/features/workbench/apps/system/useWbSysSize';
import { sessionManager } from '@/features/chat/core/session/sessionManager';

/** 演示里数据齐全、能完整操作的应用 */
const DEMO_APPS = new Set(['chat', 'chat-session', 'flashcards', 'pomodoro']);

/** Dock 固定区：对话、闪卡在前，其余沿用产品默认（资源库 / 待办 / 设置，打开是说明卡） */
const DEMO_DOCK_PINNED = ['chat', 'flashcards', 'files', 'todo', 'settings'];

const DOWNLOAD_URL = '/download';

const UnavailableApp: React.FC<{ typeId: string; onTitleChange: (title: string) => void }> = ({ typeId, onTitleChange }) => {
  const { t } = useTranslation('workbench');
  const def = appRegistry.get(typeId);
  const name = def ? t(def.nameKey) : typeId;
  React.useEffect(() => onTitleChange(name), [name, onTitleChange]);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="mb-2 scale-150">{def?.icon}</div>
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-foreground">演示版没有包含「{name}」</p>
        <p className="max-w-[22rem] text-sm leading-relaxed text-muted-foreground">
          网页演示只带了对话和闪卡。下载桌面端，导入自己的教材和笔记，就能用上全部应用。
        </p>
      </div>
      <a
        className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground no-underline hover:opacity-90"
        href={DOWNLOAD_URL}
        target="_top"
      >
        下载桌面端
      </a>
    </div>
  );
};

const placeholders = new Map<string, React.LazyExoticComponent<React.FC<AppWindowProps>>>();

function placeholderFor(typeId: string): React.LazyExoticComponent<React.FC<AppWindowProps>> {
  let lazy = placeholders.get(typeId);
  if (!lazy) {
    const Placeholder: React.FC<AppWindowProps> = ({ onTitleChange }) => (
      <UnavailableApp typeId={typeId} onTitleChange={onTitleChange} />
    );
    lazy = React.lazy(async () => ({ default: Placeholder }));
    placeholders.set(typeId, lazy);
  }
  return lazy;
}

/** 应用注册分散在学习桌面 chunk 的各模块里，注册一个换一个 */
function patchUnavailableApps(): void {
  for (const def of appRegistry.list()) {
    if (DEMO_APPS.has(def.typeId) || placeholders.get(def.typeId) === def.render) continue;
    def.render = placeholderFor(def.typeId);
  }
}

/**
 * 状态栏品牌菜单里的「退出学习桌面」会切进经典布局，演示里切过去就回不来了：菜单里不给这一项
 * （mockIpc 的 save_setting 另外兜底拦着其他入口）
 */
const HIDE_EXIT_STYLE = '[data-testid="wb-menubar-brand-exit"], [data-testid="wb-menubar-brand-settings"] + .wb-desk-menu-sep { display: none !important; }';

/** 在 App 挂载前调用：WorkbenchDesktop 只在固定区为空时才填默认值 */
export function prepareDemoDesktop(): void {
  setDockPinned(DEMO_DOCK_PINNED);
  patchUnavailableApps();
  appRegistry.subscribe(patchUnavailableApps);
  const style = document.createElement('style');
  style.textContent = HIDE_EXIT_STYLE;
  document.head.appendChild(style);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(50)) {
    const value = probe();
    if (value) return value;
  }
  return null;
}

const clamp = (value: number, min: number, max: number) => Math.round(Math.min(Math.max(value, min), max));

interface Frame { x: number; y: number; w: number; h: number }

/**
 * 开场两扇窗：对话在左、闪卡紧挨着，一起摆在桌面小组件左边的空地里，有富余就居中；
 * 底边永远停在 Dock 带上方——窗口伸进 Dock 带，Dock 会被强制收起。
 * 对话窗口避开 640–880 这一档（应用窗口的 medium 尺寸）：这一档会展开会话侧栏，正文只剩 500 来宽。
 * 地方够就给到 880 以上（侧栏和正文都宽），不够就收在 620 以内（侧栏收起）；
 * 再窄先收对话、再收闪卡（低于应用的最小拖拽尺寸也能正常排版），还放不下才让闪卡往对话底下错开，
 * 不去压右边的日程和简报。
 */
function layoutWindows(workArea: HTMLElement): { chat: Frame; cards: Frame } {
  const area = workArea.getBoundingClientRect();
  const widgets = document.querySelector<HTMLElement>('.wb-desktop-widget-column');
  const margin = 24;
  const gap = 16;
  const top = 20;
  const right = widgets ? widgets.getBoundingClientRect().left - area.left - gap : area.width - margin;
  const available = right - margin;
  const maxHeight = area.height - top - FLOATING_DOCK_CLEARANCE - 8;

  const roomy = available >= WB_SYS_WIDTH_WIDE + gap + 560;
  let chatW = roomy
    ? clamp(available - gap - 600, WB_SYS_WIDTH_WIDE, 960)
    : clamp(available * 0.56, 560, WB_SYS_WIDTH_MEDIUM - 20);
  let cardsW = clamp(available - chatW - gap, roomy ? 560 : 440, 640);
  let overflow = chatW + gap + cardsW - available;
  const chatShrink = clamp(overflow, 0, chatW - 480);
  chatW -= chatShrink;
  overflow -= chatShrink;
  const cardsShrink = clamp(overflow, 0, cardsW - 400);
  cardsW -= cardsShrink;
  overflow -= cardsShrink;
  // 富余的地方两边分；左边那列桌面图标要么整列让出来，要么整列盖住，别盖一半
  const free = Math.max(0, -overflow);
  const iconsRight = Math.max(0, ...[...document.querySelectorAll('.wb-desk-icon')]
    .map((icon) => icon.getBoundingClientRect().right - area.left));
  let left = margin + Math.round(free / 2);
  if (iconsRight && left < iconsRight + gap) left = margin + free >= iconsRight + gap ? Math.round(iconsRight + gap) : margin;
  return {
    chat: { x: left, y: top, w: chatW, h: Math.round(Math.min(maxHeight, 800)) },
    cards: {
      x: left + chatW + gap - Math.max(0, overflow),
      y: top,
      w: cardsW,
      h: Math.round(Math.max(Math.min(maxHeight - 120, 640), Math.min(maxHeight, 400))),
    },
  };
}

/**
 * 官网上的舞台跟着浏览器窗口变：两扇窗还没被访客碰过，就按新尺寸重排；
 * 一旦在窗口上按下过指针（拖、缩放、点内容），就交给访客自己摆
 */
function rearrangeOnResize(workArea: HTMLElement, ids: { chat: string; cards: string }): void {
  let touched = false;
  let timer = 0;
  const onPointerDown = (event: PointerEvent) => {
    if ((event.target as Element | null)?.closest('.wb-window')) touched = true;
  };
  const onResize = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const { windows, moveWindow } = useWindowStore.getState();
      if (touched || !windows[ids.chat] || !windows[ids.cards]) {
        window.removeEventListener('resize', onResize);
        document.removeEventListener('pointerdown', onPointerDown, true);
        return;
      }
      const next = layoutWindows(workArea);
      moveWindow(ids.chat, next.chat);
      moveWindow(ids.cards, next.cards);
    }, 300);
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('pointerdown', onPointerDown, true);
}

export async function arrangeDemoDesktop(sceneId: string): Promise<boolean> {
  const workArea = await waitFor(() => document.querySelector<HTMLElement>('[data-wb-workarea]'), 20000);
  if (!workArea) return false;
  await waitFor(() => appRegistry.get('chat') && appRegistry.get('flashcards'), 10000);
  // 小组件列在快照恢复链路走完后才挂载（关掉了就没有），排窗要量它的左边
  await waitFor(() => document.querySelector('.wb-desktop-widget-column'), 3000);

  const frames = layoutWindows(workArea);
  const store = useWindowStore.getState();
  const cards = store.openWindow({ typeId: 'flashcards', instanceKey: null, initialFrame: frames.cards });
  const chat = store.openWindow({ typeId: 'chat', instanceKey: sceneId, initialFrame: frames.chat });
  useWindowStore.getState().focusWindow(chat);
  rearrangeOnResize(workArea, { chat, cards });

  // 对话窗口挂载时，导航握手正好从启动草稿切到剧本会话，窗口没赶上这次切换，
  // 标题停在「新对话」：会话标题载入后补一次
  const title = await waitFor(
    () => sessionManager.getCurrentSessionId() === sceneId && sessionManager.peek(sceneId)?.getState().title?.trim(),
    10000,
  );
  if (title) useWindowStore.getState().setTitle(chat, title);

  // 首答播完时对话停在末尾，卡片被顶出窗口：只滚对话自己的滚动区，让正中那张卡离内容区上沿 44px
  const slides = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.wb-window .card-3d')]
      .filter((slide) => slide.getBoundingClientRect().height > 0);
    return found.length > 0 ? found : null;
  }, 15000);
  if (slides) {
    await sleep(120);
    const z = (el: HTMLElement) => Number(getComputedStyle(el).zIndex) || 0;
    const front = slides.reduce((top, slide) => (z(slide) > z(top) ? slide : top), slides[0]);
    for (let el = front.parentElement; el; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) {
        el.scrollTop += front.getBoundingClientRect().top - el.getBoundingClientRect().top - 44;
        break;
      }
    }
  }
  return true;
}
