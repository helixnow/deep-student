/**
 * Analysis Panel host: the floating frame's position and size (restored from localStorage, saved when a drag or
 * resize ends), pointer drag and resize for mouse, touch and pen, and clamping to the viewport on mount and resize.
 */
import React from 'react';

const STORAGE_KEYS = {
  POSITION: 'DSTU_DBG_POS',
  SIZE: 'DSTU_DBG_SIZE',
};

/** 面板最小宽度：360px，小视口（如 320–359px 手机）退让为 视口宽-16，避免横向溢出 */
const getMinPanelWidth = () => Math.min(360, Math.max(240, (window.innerWidth || 1024) - 16));
const MIN_PANEL_HEIGHT = 240;

export function useFloatingFrame() {
  const [pos, setPos] = React.useState<{ x: number; y: number }>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.POSITION);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          return parsed;
        }
      }
    } catch {
      // localStorage 不可用或数据损坏，使用默认位置
    }
    return { x: 12, y: 12 };
  });
  const [size, setSize] = React.useState<{ w: number; h: number }>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SIZE);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (typeof parsed.w === 'number' && typeof parsed.h === 'number') {
          return parsed;
        }
      }
    } catch {
      // localStorage 不可用或数据损坏，使用默认尺寸
    }
    return { w: Math.min(720, Math.floor(window.innerWidth * 0.92)), h: Math.floor(window.innerHeight * 0.5) };
  });
  const [dragging, setDragging] = React.useState(false);
  const [resizing, setResizing] = React.useState(false);
  const dragStart = React.useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const sizeStart = React.useRef<{ sw: number; sh: number; sx: number; sy: number }>({ sw: 0, sh: 0, sx: 0, sy: 0 });

  // 拖动/缩放统一走 Pointer Events：触屏（手指/触控笔）与鼠标共用一条路径
  React.useEffect(() => {
    const handleMove = (ev: PointerEvent) => {
      if (dragging) {
        setPos(prev => {
          const next = {
            x: Math.max(0, ev.clientX - dragStart.current.dx),
            y: Math.max(0, ev.clientY - dragStart.current.dy),
          };
          return next;
        });
      } else if (resizing) {
        const dx = ev.clientX - sizeStart.current.sx;
        const dy = ev.clientY - sizeStart.current.sy;
        setSize(prev => ({
          w: Math.max(getMinPanelWidth(), sizeStart.current.sw + dx),
          h: Math.max(MIN_PANEL_HEIGHT, sizeStart.current.sh + dy),
        }));
      }
    };

    const handleUp = () => {
      if (dragging) {
        try {
          localStorage.setItem(STORAGE_KEYS.POSITION, JSON.stringify(pos));
        } catch {
          // 拖拽位置保存失败时，下次打开使用默认位置
        }
      }
      if (resizing) {
        try {
          localStorage.setItem(STORAGE_KEYS.SIZE, JSON.stringify(size));
        } catch {
          // 面板尺寸保存失败时，下次打开使用默认尺寸
        }
      }
      setDragging(false);
      setResizing(false);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [dragging, resizing, pos, size]);

  React.useEffect(() => {
    const clamp = () => {
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      setPos(prev => {
        const nx = Math.min(Math.max(0, prev.x ?? 0), Math.max(0, vw - 120));
        const ny = Math.min(Math.max(0, prev.y ?? 0), Math.max(0, vh - 80));
        if (nx !== prev.x || ny !== prev.y) {
          return { x: nx, y: ny };
        }
        return prev;
      });
      setSize(prev => {
        // 最小宽度随视口退让（320–359px 手机上固定 360px 会横向溢出）
        const minW = getMinPanelWidth();
        const nw = Math.min(Math.max(minW, prev.w ?? minW), Math.max(minW, vw - 24));
        const nh = Math.min(Math.max(220, prev.h ?? 220), Math.max(220, vh - 24));
        if (nw !== prev.w || nh !== prev.h) {
          return { w: nw, h: nh };
        }
        return prev;
      });
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => {
      window.removeEventListener('resize', clamp);
    };
  }, []);

  return { pos, setPos, size, setSize, setDragging, setResizing, dragStart, sizeStart };
}
