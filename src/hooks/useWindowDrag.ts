import { getCurrentWindow } from '@tauri-apps/api/window';
import type React from 'react';

export const useWindowDrag = () => {
  const startDragging = async (e?: React.SyntheticEvent) => {
    try {
      e?.preventDefault?.();
    } catch {
      // ignore if preventDefault 不存在
    }
    try {
      await getCurrentWindow().startDragging();
    } catch (error: unknown) {
      console.error('Failed to start dragging:', error);
    }
  };

  return { startDragging };
};
