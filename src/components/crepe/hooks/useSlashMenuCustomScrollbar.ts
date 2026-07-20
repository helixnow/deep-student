import { RefObject, useEffect } from 'react';

interface UseSlashMenuCustomScrollbarOptions {
  wrapperRef: RefObject<HTMLElement>;
  enabled?: boolean;
}

const HIDE_DELAY_MS = 700;
const DEFAULT_MIN_THUMB_SIZE = 40;
const WHEEL_SMOOTH_FACTOR = 0.32; // 每帧向目标推进的比例（指数趋近）
const WHEEL_SETTLE_EPSILON = 0.5;

export function useSlashMenuCustomScrollbar({
  wrapperRef,
  enabled = true,
}: UseSlashMenuCustomScrollbarOptions) {
  useEffect(() => {
    if (!enabled) return;

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const reducedMotionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

    const cleanupMap = new Map<HTMLElement, () => void>();

    const cleanupDisconnectedTargets = () => {
      cleanupMap.forEach((cleanup, menuGroups) => {
        if (menuGroups.isConnected) return;
        cleanup();
        cleanupMap.delete(menuGroups);
      });
    };

    const attachCustomScrollbar = (menuGroups: HTMLElement) => {
      if (cleanupMap.has(menuGroups)) return;
      if (menuGroups.dataset.dsScrollEnhanced === 'true') return;

      const menuRoot = menuGroups.closest<HTMLElement>('.milkdown-slash-menu');
      if (!menuRoot) return;

      menuGroups.dataset.dsScrollEnhanced = 'true';
      menuGroups.classList.add('ds-slash-scroll-viewport');

      const track = document.createElement('div');
      track.className = 'ds-slash-scroll-track';
      track.dataset.visible = 'false';
      track.dataset.enabled = 'false';

      const thumb = document.createElement('div');
      thumb.className = 'ds-slash-scroll-thumb';
      track.appendChild(thumb);
      menuRoot.appendChild(track);

      let hideTimer: number | null = null;
      let isDragging = false;
      let dragStartY = 0;
      let dragStartScrollTop = 0;
      let pointerId: number | null = null;
      let wheelTarget: number | null = null;
      let wheelFrame: number | null = null;

      const clearHideTimer = () => {
        if (hideTimer === null) return;
        window.clearTimeout(hideTimer);
        hideTimer = null;
      };

      const hasOverflow = () => menuGroups.scrollHeight > menuGroups.clientHeight + 1;

      const getMinThumbSize = () => {
        const token = Number.parseFloat(
          getComputedStyle(menuRoot).getPropertyValue('--scrollbar-thumb-min-size'),
        );
        return Number.isFinite(token) && token > 0 ? token : DEFAULT_MIN_THUMB_SIZE;
      };

      // 样式表给 menu-groups 设了 scroll-behavior:smooth，直接赋值 scrollTop
      // 会触发浏览器自身的平滑动画，与逐帧驱动叠加产生迟滞；程序化滚动
      // 期间临时切到 auto，结束后恢复。
      const suppressNativeSmooth = () => {
        menuGroups.style.scrollBehavior = 'auto';
      };

      const restoreNativeSmooth = () => {
        if (!isDragging && wheelFrame === null) {
          menuGroups.style.scrollBehavior = '';
        }
      };

      const stopWheelAnimation = () => {
        if (wheelFrame !== null) {
          cancelAnimationFrame(wheelFrame);
          wheelFrame = null;
        }
        wheelTarget = null;
        restoreNativeSmooth();
      };

      const wheelTick = () => {
        wheelFrame = null;
        if (wheelTarget === null) {
          restoreNativeSmooth();
          return;
        }
        const maxScrollTop = Math.max(
          0,
          menuGroups.scrollHeight - menuGroups.clientHeight,
        );
        wheelTarget = Math.max(0, Math.min(wheelTarget, maxScrollTop));
        const current = menuGroups.scrollTop;
        const delta = wheelTarget - current;
        if (Math.abs(delta) <= WHEEL_SETTLE_EPSILON) {
          menuGroups.scrollTop = wheelTarget;
          wheelTarget = null;
          restoreNativeSmooth();
          return;
        }
        menuGroups.scrollTop = current + delta * WHEEL_SMOOTH_FACTOR;
        wheelFrame = requestAnimationFrame(wheelTick);
      };

      const handleWheel = (event: WheelEvent) => {
        if (!hasOverflow()) return;
        if (isDragging) return;
        // 减动效偏好或非像素滚动（行/页模式）交给原生处理
        if (reducedMotionQuery?.matches) return;
        if (event.deltaMode !== 0) return;
        if (event.ctrlKey) return;

        event.preventDefault();
        const maxScrollTop = menuGroups.scrollHeight - menuGroups.clientHeight;
        const base = wheelTarget ?? menuGroups.scrollTop;
        wheelTarget = Math.max(0, Math.min(base + event.deltaY, maxScrollTop));
        suppressNativeSmooth();
        if (wheelFrame === null) {
          wheelFrame = requestAnimationFrame(wheelTick);
        }
      };

      const updateTrackLayout = () => {
        const top = menuGroups.offsetTop;
        const height = menuGroups.clientHeight;
        track.style.top = `${top}px`;
        track.style.height = `${height}px`;
      };

      const updateThumb = () => {
        if (!hasOverflow()) {
          track.dataset.enabled = 'false';
          track.dataset.visible = 'false';
          return;
        }

        track.dataset.enabled = 'true';
        const { scrollTop, scrollHeight, clientHeight } = menuGroups;
        const size = Math.min(
          clientHeight,
          Math.max((clientHeight / scrollHeight) * clientHeight, getMinThumbSize()),
        );
        const maxOffset = clientHeight - size;
        const rawOffset =
          maxOffset <= 0 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxOffset;
        // WKWebView rubber-band scrolling can temporarily report a negative
        // or over-max scrollTop; never let the visual thumb leave its track.
        const offset = Math.max(0, Math.min(rawOffset, maxOffset));

        thumb.style.height = `${size}px`;
        thumb.style.transform = `translateY(${offset}px)`;
      };

      const showTrack = () => {
        if (!hasOverflow()) return;
        track.dataset.visible = 'true';
      };

      const scheduleHide = () => {
        if (isDragging) return;
        clearHideTimer();
        hideTimer = window.setTimeout(() => {
          if (!isDragging) {
            track.dataset.visible = 'false';
          }
          hideTimer = null;
        }, HIDE_DELAY_MS);
      };

      const handleScroll = () => {
        updateTrackLayout();
        updateThumb();
        showTrack();
        scheduleHide();
      };

      const handlePointerMove = (event: PointerEvent) => {
        if (!isDragging) return;
        const deltaY = event.clientY - dragStartY;
        const trackHeight = menuGroups.clientHeight;
        const thumbHeight = thumb.getBoundingClientRect().height;
        const maxThumbOffset = Math.max(trackHeight - thumbHeight, 1);
        const scrollRange = menuGroups.scrollHeight - menuGroups.clientHeight;
        const scrollDelta = (deltaY / maxThumbOffset) * scrollRange;
        menuGroups.scrollTop = dragStartScrollTop + scrollDelta;
      };

      const stopDragging = () => {
        if (!isDragging) return;
        if (pointerId !== null && thumb.hasPointerCapture(pointerId)) {
          thumb.releasePointerCapture(pointerId);
        }
        isDragging = false;
        pointerId = null;
        restoreNativeSmooth();
        scheduleHide();
      };

      const handleThumbPointerDown = (event: PointerEvent) => {
        event.preventDefault();
        event.stopPropagation();
        stopWheelAnimation();
        isDragging = true;
        pointerId = event.pointerId;
        dragStartY = event.clientY;
        dragStartScrollTop = menuGroups.scrollTop;
        clearHideTimer();
        suppressNativeSmooth();
        track.dataset.visible = 'true';
        thumb.setPointerCapture(pointerId);
      };

      const resizeObserver = new ResizeObserver(() => {
        updateTrackLayout();
        updateThumb();
      });

      const contentObserver = new MutationObserver(() => {
        updateTrackLayout();
        updateThumb();
      });

      resizeObserver.observe(menuGroups);
      resizeObserver.observe(menuRoot);
      contentObserver.observe(menuGroups, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      menuGroups.addEventListener('scroll', handleScroll, { passive: true });
      menuGroups.addEventListener('wheel', handleWheel, { passive: false });
      menuGroups.addEventListener('pointerenter', showTrack);
      menuGroups.addEventListener('pointerleave', scheduleHide);
      thumb.addEventListener('pointermove', handlePointerMove);
      thumb.addEventListener('pointerup', stopDragging);
      thumb.addEventListener('pointercancel', stopDragging);
      thumb.addEventListener('pointerdown', handleThumbPointerDown);

      updateTrackLayout();
      updateThumb();

      const cleanup = () => {
        stopDragging();
        stopWheelAnimation();
        clearHideTimer();
        menuGroups.style.scrollBehavior = '';
        resizeObserver.disconnect();
        contentObserver.disconnect();
        menuGroups.removeEventListener('scroll', handleScroll);
        menuGroups.removeEventListener('wheel', handleWheel);
        menuGroups.removeEventListener('pointerenter', showTrack);
        menuGroups.removeEventListener('pointerleave', scheduleHide);
        thumb.removeEventListener('pointermove', handlePointerMove);
        thumb.removeEventListener('pointerup', stopDragging);
        thumb.removeEventListener('pointercancel', stopDragging);
        thumb.removeEventListener('pointerdown', handleThumbPointerDown);
        menuGroups.classList.remove('ds-slash-scroll-viewport');
        delete menuGroups.dataset.dsScrollEnhanced;
        track.remove();
      };

      cleanupMap.set(menuGroups, cleanup);
    };

    const scanSlashMenus = () => {
      const menuGroupsList = wrapper.querySelectorAll<HTMLElement>('.milkdown-slash-menu .menu-groups');
      menuGroupsList.forEach(attachCustomScrollbar);
      cleanupDisconnectedTargets();
    };

    scanSlashMenus();

    const observer = new MutationObserver(() => {
      scanSlashMenus();
    });

    observer.observe(wrapper, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      cleanupMap.forEach((cleanup) => cleanup());
      cleanupMap.clear();
    };
  }, [enabled, wrapperRef]);
}
