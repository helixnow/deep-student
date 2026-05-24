import React, { useMemo, useState } from "react";

import { AppChrome } from "@/components/shell/AppChrome";
import { Surface } from "@/components/ui/surface";
import { detectDesktopPlatform } from "@/lib/app-shell";
import {
  sidebarFolderItems,
  settingsNavItems,
  threadItems,
  type SettingsTabId,
} from "@/lib/sidebar-data";

const SettingsPanel = React.lazy(() =>
  import("@/components/content/SettingsPanel").then((module) => ({ default: module.SettingsPanel })),
);
const ThreadCanvas = React.lazy(() =>
  import("@/components/content/ThreadCanvas").then((module) => ({ default: module.ThreadCanvas })),
);

type Mode = "app" | "settings";

function AppSurfaceFallback() {
  return (
    <div className="flex h-full min-h-0 flex-1 items-start justify-center px-6 py-10 md:px-10">
      <Surface className="w-full max-w-4xl rounded-[28px] p-6 md:p-8">
        <div className="space-y-3">
          <div className="h-5 w-40 animate-pulse motion-reduce:animate-none rounded-lg bg-secondary/80" />
          <div className="h-24 w-full animate-pulse motion-reduce:animate-none rounded-[24px] bg-secondary/70" />
          <div className="grid gap-3 md:grid-cols-2">
            <div className="h-28 animate-pulse motion-reduce:animate-none rounded-[24px] bg-secondary/70" />
            <div className="h-28 animate-pulse motion-reduce:animate-none rounded-[24px] bg-secondary/70" />
          </div>
        </div>
      </Surface>
    </div>
  );
}

export default function App() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentMode, setCurrentMode] = useState<Mode>("app");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTabId>("general");
  const [orderedFolderItems, setOrderedFolderItems] = useState(sidebarFolderItems);

  const desktopPlatform = useMemo(
    () =>
      detectDesktopPlatform({
        platform: typeof navigator === "undefined" ? "" : navigator.platform,
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      }),
    [],
  );

  const toggleMobileSidebar = () => setMobileSidebarOpen((open) => !open);
  const toggleSidebarCollapsed = () => setSidebarCollapsed((collapsed) => !collapsed);
  const openSettings = () => {
    setCurrentMode("settings");
    setMobileSidebarOpen(true);
    setSidebarCollapsed(false);
  };
  const returnToApp = () => setCurrentMode("app");
  const handleSelectSettingsTab = (tabId: string) => {
    const item = settingsNavItems.find((i) => i.id === tabId);
    if (item) setActiveSettingsTab(item.id);
  };
  const handleReorderFolders = (sourceFolderId: string, targetFolderId: string) => {
    setOrderedFolderItems((current) => {
      const sourceIndex = current.findIndex((item) => item.id === sourceFolderId);
      const targetIndex = current.findIndex((item) => item.id === targetFolderId);

      if (
        sourceIndex === -1 ||
        targetIndex === -1 ||
        sourceIndex === targetIndex
      ) {
        return current;
      }

      const next = [...current];
      const [movedFolder] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, movedFolder);
      return next;
    });
  };

  return (
    <AppChrome
      activeSettingsTab={activeSettingsTab}
      appContent={
        <React.Suspense fallback={<AppSurfaceFallback />}>
          <ThreadCanvas />
        </React.Suspense>
      }
      currentMode={currentMode}
      desktopPlatform={desktopPlatform}
      folderItems={orderedFolderItems}
      mobileSidebarOpen={mobileSidebarOpen}
      onOpenSettings={openSettings}
      onReorderFolders={handleReorderFolders}
      onReturnToApp={returnToApp}
      onSelectSettingsTab={handleSelectSettingsTab}
      onToggleMobileSidebar={toggleMobileSidebar}
      onToggleSidebarCollapsed={toggleSidebarCollapsed}
      sidebarCollapsed={sidebarCollapsed}
      settingsContent={
        <React.Suspense fallback={<AppSurfaceFallback />}>
          <SettingsPanel activeTab={activeSettingsTab} onSelectTab={handleSelectSettingsTab} />
        </React.Suspense>
      }
      settingsNavItems={settingsNavItems}
      threadItems={threadItems}
    />
  );
}
