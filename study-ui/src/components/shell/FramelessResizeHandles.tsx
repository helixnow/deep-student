import type { Window as TauriWindow } from "@tauri-apps/api/window";

import { cn } from "@/lib/utils";

type ResizeDirection = Parameters<TauriWindow["startResizeDragging"]>[0];

const RESIZE_HANDLE_MAP: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: "North", className: "left-3 right-3 top-0 h-1 cursor-n-resize" },
  { direction: "South", className: "bottom-0 left-3 right-3 h-1 cursor-s-resize" },
  { direction: "West", className: "bottom-3 left-0 top-3 w-1 cursor-w-resize" },
  { direction: "East", className: "bottom-3 right-0 top-3 w-1 cursor-e-resize" },
  { direction: "NorthWest", className: "left-0 top-0 h-3 w-3 cursor-nw-resize" },
  { direction: "NorthEast", className: "right-0 top-0 h-3 w-3 cursor-ne-resize" },
  { direction: "SouthWest", className: "bottom-0 left-0 h-3 w-3 cursor-sw-resize" },
  { direction: "SouthEast", className: "bottom-0 right-0 h-3 w-3 cursor-se-resize" },
];

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getCurrentTauriWindow() {
  if (!hasTauriRuntime()) {
    return null;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function runWindowAction(action: (currentWindow: TauriWindow) => Promise<void>) {
  const currentWindow = await getCurrentTauriWindow();
  if (!currentWindow) {
    return;
  }

  await action(currentWindow);
}

export function FramelessResizeHandles({ enabled }: { enabled: boolean }) {
  if (!enabled) {
    return null;
  }

  return (
    <>
      {RESIZE_HANDLE_MAP.map((handle) => (
        <div
          key={handle.direction}
          className={cn("absolute z-40 select-none", handle.className)}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void runWindowAction((currentWindow) =>
              currentWindow.startResizeDragging(handle.direction),
            );
          }}
        />
      ))}
    </>
  );
}
