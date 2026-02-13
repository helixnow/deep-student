import { RefObject, useEffect } from 'react';

interface UseSlashMenuCustomScrollbarOptions {
  wrapperRef: RefObject<HTMLElement>;
  enabled?: boolean;
}

const HIDE_DELAY_MS = 700;
const MIN_THUMB_SIZE = 36;

export function useSlashMenuCustomScrollbar({
  wrapperRef,
  enabled = true,
}: UseSlashMenuCustomScrollbarOptions) {
  useEffect(() => {
    if (!enabled) return;

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

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

      const clearHideTimer = () => {
        if (hideTimer === null) return;
        window.clearTimeout(hideTimer);
        hideTimer = null;
      };

      const hasOverflow = () => menuGroups.scrollHeight > menuGroups.clientHeight + 1;

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
        const size = Math.max((clientHeight / scrollHeight) * clientHeight, MIN_THUMB_SIZE);
        const maxOffset = clientHeight - size;
        const offset =
          maxOffset <= 0 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxOffset;

        thumb.style.height = `${size}px`;
        thumb.style.transform = `translateY(${Math.max(0, offset)}px)`;
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
        scheduleHide();
      };

      const handleThumbPointerDown = (event: PointerEvent) => {
        event.preventDefault();
        event.stopPropagation();
        isDragging = true;
        pointerId = event.pointerId;
        dragStartY = event.clientY;
        dragStartScrollTop = menuGroups.scrollTop;
        clearHideTimer();
        track.dataset.visible = 'true';
        thumb.setPointerCapture(pointerId);
      };

      const resizeObserver = new ResizeObserver(() => {
        updateTrackLayout();
        updateThumb();
      });

      resizeObserver.observe(menuGroups);
      resizeObserver.observe(menuRoot);

      menuGroups.addEventListener('scroll', handleScroll, { passive: true });
      menuGroups.addEventListener('pointerenter', showTrack);
      menuGroups.addEventListener('pointerleave', scheduleHide);
      thumb.addEventListener('pointermove', handlePointerMove);
      thumb.addEventListener('pointerup', stopDragging);
      thumb.addEventListener('pointercancel', stopDragging);
      thumb.addEventListener('pointerdown', handleThumbPointerDown);

      updateTrackLayout();
      updateThumb();

      const cleanup = () => {
        clearHideTimer();
        stopDragging();
        resizeObserver.disconnect();
        menuGroups.removeEventListener('scroll', handleScroll);
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
