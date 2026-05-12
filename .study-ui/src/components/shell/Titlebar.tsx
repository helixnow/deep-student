import type React from "react";

import {
  getHeaderRightPadding,
  getMacTitlebarControlTopInset,
  getMainWorkspaceSurfaceClass,
  getTitlebarSurfaceClass,
  shouldShowCustomWindowControls,
  type DesktopPlatform,
  type TitlebarMode,
} from "@/lib/app-shell";
import type { WindowBackgroundMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { WindowControls } from "./WindowControls";

type TitlebarProps = {
  variant: "app" | "settings";
  headerTopInset: number;
  desktopPlatform: DesktopPlatform;
  titlebarMode: TitlebarMode;
  windowBackgroundPreference: WindowBackgroundMode;
  children: React.ReactNode;
  leadingInset?: number;
  leadingAccessory?: React.ReactNode;
  leadingAccessoryOffset?: number;
};

export function Titlebar({
  children,
  desktopPlatform,
  headerTopInset,
  leadingAccessory,
  leadingAccessoryOffset = 0,
  leadingInset = 0,
  titlebarMode,
  variant,
  windowBackgroundPreference,
}: TitlebarProps) {
  const headerHeight = 46 + headerTopInset;
  const headerPaddingRight = getHeaderRightPadding(desktopPlatform, titlebarMode) + 12;
  const headerPaddingLeft = (variant === "app" ? 20 : 24) + leadingInset;
  const shouldUseNativeTransparentChromeAlignment =
    desktopPlatform === "macos" && titlebarMode === "native-transparent";
  const headerContentTop = shouldUseNativeTransparentChromeAlignment
    ? getMacTitlebarControlTopInset(titlebarMode)
    : headerTopInset;
  const headerContentClassName = cn(
    "pointer-events-none relative z-10 flex h-full transition-[padding-left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
    shouldUseNativeTransparentChromeAlignment ? "items-start" : "items-center",
  );
  const leadingAccessoryTop =
    titlebarMode === "native-transparent" ? getMacTitlebarControlTopInset(titlebarMode) : headerTopInset + 7;
  const titlebarSurfaceClass =
    variant === "app"
      ? getMainWorkspaceSurfaceClass(windowBackgroundPreference)
      : desktopPlatform === "macos" && titlebarMode === "native-transparent"
      ? getTitlebarSurfaceClass(windowBackgroundPreference)
      : "bg-transparent";

  return (
    <header className={cn("relative shrink-0", titlebarSurfaceClass)} style={{ height: headerHeight }}>
      <div data-tauri-drag-region className="absolute inset-0" />
      {leadingAccessory ? (
        <div
          className="pointer-events-none absolute z-20"
          style={{
            left: leadingAccessoryOffset,
            top: leadingAccessoryTop,
          }}
        >
          <div className="pointer-events-auto">{leadingAccessory}</div>
        </div>
      ) : null}
      <div
        className={headerContentClassName}
        style={{
          paddingTop: headerContentTop,
          paddingLeft: headerPaddingLeft,
          paddingRight: headerPaddingRight,
        }}
      >
        <div className={cn("flex min-w-0 flex-1 items-center justify-between gap-4", shouldUseNativeTransparentChromeAlignment && "min-h-8")}>
          {children}
        </div>
      </div>
      <WindowControls visible={shouldShowCustomWindowControls(desktopPlatform, titlebarMode)} />
    </header>
  );
}
