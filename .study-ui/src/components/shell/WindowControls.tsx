import { useEffect, useState } from "react";
import { Minus, Square, X } from "@phosphor-icons/react";
import type { Window as TauriWindow } from "@tauri-apps/api/window";

import { cn } from "@/lib/utils";

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

const controlButtonClassName =
  "flex h-7 w-10 items-center justify-center rounded-lg bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-interactive-hover hover:text-foreground";

export function WindowControls({ visible }: { visible: boolean }) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncMaximizeState = async (currentWindow: TauriWindow) => {
      const maximized = await currentWindow.isMaximized();
      if (!disposed) {
        setIsMaximized(maximized);
      }
    };

    const setup = async () => {
      const currentWindow = await getCurrentTauriWindow();
      if (!currentWindow) {
        return;
      }

      await syncMaximizeState(currentWindow);
      unlisten = await currentWindow.onResized(() => {
        void syncMaximizeState(currentWindow);
      });
    };

    void setup();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [visible]);

  if (!visible) {
    return null;
  }

  return (
    <div className="absolute inset-y-0 right-3 z-30 flex items-center gap-1.5">
      <button
        type="button"
        aria-label="最小化窗口"
        className={controlButtonClassName}
        onClick={() => {
          void runWindowAction((currentWindow) => currentWindow.minimize());
        }}
      >
        <Minus size={16} />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? "还原窗口" : "最大化窗口"}
        className={cn(
          controlButtonClassName,
          isMaximized ? "bg-interactive-selected text-foreground" : undefined,
        )}
        onClick={() => {
          void runWindowAction(async (currentWindow) => {
            if (await currentWindow.isMaximized()) {
              await currentWindow.unmaximize();
              return;
            }

            await currentWindow.maximize();
          });
        }}
      >
        <Square size={14} />
      </button>
      <button
        type="button"
        aria-label="关闭窗口"
        className={cn(
          controlButtonClassName,
          "hover:bg-destructive/12 hover:text-destructive",
        )}
        onClick={() => {
          void runWindowAction((currentWindow) => currentWindow.close());
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
