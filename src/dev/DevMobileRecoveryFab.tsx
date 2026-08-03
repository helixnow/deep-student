/**
 * Dev-only 移动端恢复浮层：页面卡住时可热重载、重置导航、打开 DevTools。
 * 仅在 DEV + 小屏时挂载（见 App.tsx）。支持拖动，避免挡住侧栏内容。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Bug, House } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import { toggleDevtools } from '@/dev/devtools';
import { Z_INDEX } from '@/config/zIndex';

export const LEARNING_HUB_MOBILE_RESET_EVENT = 'learning-hub:mobile-reset';
export const MOBILE_VIEW_RESET_EVENT = 'deep-student:mobile-view-reset';

const POS_STORAGE_KEY = 'dstu-dev-recovery-fab-pos';
const FAB_WIDTH = 52;
const FAB_HEIGHT = 36;
const DRAG_THRESHOLD = 4;

type FabPosition = { x: number; y: number };

function readStoredPosition(): FabPosition | null {
  try {
    const stored = localStorage.getItem(POS_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as FabPosition;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function defaultPosition(): FabPosition {
  const safeBottom = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--mobile-safe-area-bottom') || '0',
  ) || 0;
  return {
    x: Math.max(8, window.innerWidth - FAB_WIDTH - 12),
    y: Math.max(8, window.innerHeight - FAB_HEIGHT - 12 - safeBottom),
  };
}

function clampPosition(position: FabPosition): FabPosition {
  return {
    x: Math.max(8, Math.min(position.x, Math.max(8, window.innerWidth - FAB_WIDTH - 8))),
    y: Math.max(8, Math.min(position.y, Math.max(8, window.innerHeight - FAB_HEIGHT - 8))),
  };
}

async function openDevTools() {
  const opened = await toggleDevtools();
  if (opened === null) {
    console.info('[DevMobileRecovery] DevTools 不可用：请在浏览器中按 F12 打开 DevTools');
  }
}

export const DevMobileRecoveryFab: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FabPosition>(() => readStoredPosition() ?? defaultPosition());
  const [dragging, setDragging] = useState(false);
  const positionRef = useRef(position);
  positionRef.current = position;
  const dragRef = useRef({
    pointerId: -1,
    offsetX: 0,
    offsetY: 0,
    moved: false,
    startX: 0,
    startY: 0,
  });

  useEffect(() => {
    const clamp = () => {
      setPosition((prev) => clampPosition(prev));
    };
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  const persistPosition = useCallback((next: FabPosition) => {
    try {
      localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleResetView = useCallback(() => {
    window.dispatchEvent(new CustomEvent(LEARNING_HUB_MOBILE_RESET_EVENT));
    window.dispatchEvent(new CustomEvent(MOBILE_VIEW_RESET_EVENT));
    setOpen(false);
  }, []);

  const handleDevTools = useCallback(() => {
    void openDevTools();
    setOpen(false);
  }, []);

  const handleFabPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - position.x,
      offsetY: event.clientY - position.y,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, [position.x, position.y]);

  const handleFabPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging || dragRef.current.pointerId !== event.pointerId) return;
    const dx = Math.abs(event.clientX - dragRef.current.startX);
    const dy = Math.abs(event.clientY - dragRef.current.startY);
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      dragRef.current.moved = true;
      setOpen(false);
    }
    const next = clampPosition({
      x: event.clientX - dragRef.current.offsetX,
      y: event.clientY - dragRef.current.offsetY,
    });
    setPosition(next);
  }, [dragging]);

  const handleFabPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    persistPosition(positionRef.current);
    if (!dragRef.current.moved) {
      setOpen((prev) => !prev);
    }
    dragRef.current.moved = false;
  }, [persistPosition]);

  return (
    <div
      className="pointer-events-none fixed"
      style={{
        left: position.x,
        top: position.y,
        zIndex: Z_INDEX.toast,
      }}
      data-dev-mobile-recovery
    >
      <div className="pointer-events-auto flex flex-col items-end gap-2">
        {open && !dragging && (
          <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-background/95 p-1.5 shadow-lg backdrop-blur-md">
            <DsButton
              variant="ghost"
              size="sm"
              className="!justify-start gap-2 !px-3"
              onClick={handleReload}
            >
              <ArrowClockwise size={16} />
              热重载
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              className="!justify-start gap-2 !px-3"
              onClick={handleResetView}
            >
              <House size={16} />
              重置导航
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              className="!justify-start gap-2 !px-3"
              onClick={handleDevTools}
            >
              <Bug size={16} />
              DevTools
            </DsButton>
          </div>
        )}
        <DsButton
          variant="secondary"
          size="sm"
          className={cn(
            'h-9 rounded-full px-3 text-xs font-semibold shadow-md touch-none select-none',
            open && !dragging && 'ring-2 ring-primary/30',
            dragging && 'cursor-grabbing opacity-90',
          )}
          aria-expanded={open}
          aria-label="开发恢复菜单（可拖动）"
          onPointerDown={handleFabPointerDown}
          onPointerMove={handleFabPointerMove}
          onPointerUp={handleFabPointerUp}
          onPointerCancel={handleFabPointerUp}
        >
          DEV
        </DsButton>
      </div>
    </div>
  );
};

export default DevMobileRecoveryFab;
