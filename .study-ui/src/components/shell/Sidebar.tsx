import { useState } from "react";
import {
  ArrowLeft,
  Books,
  CaretRight,
  CheckSquare,
  ChatCenteredText,
  GearSix,
  Plus,
  PushPinSimple,
  SidebarSimple,
} from "@phosphor-icons/react";

import {
  getOverlayLeadingInset,
  getSidebarHeaderHeight,
  getSidebarSurfaceClass,
  type TitlebarMode,
} from "@/lib/app-shell";
import type { WindowBackgroundMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { ShellButton } from "./ShellButton";
import { SidebarUpdateBadge } from "./SidebarUpdateBadge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  SETTINGS_BACK_BUTTON_LABEL,
  SETTINGS_NAV_ITEM_LABEL_CLASS_NAME,
} from "./sidebar-settings";

type SidebarProps = {
  className?: string;
  titlebarMode: TitlebarMode;
  currentMode: "app" | "settings";
  isSidebarVisible: boolean;
  isSidebarClosing?: boolean;
  closeOnSelect?: boolean;
  showNewConversationShortcut?: boolean;
  showFloatingSidebarToggle: boolean;
  activeSettingsTab: string;
  folderItems: Array<{ id: string; label: string; icon: React.ReactNode; active: boolean; count: number }>;
  settingsNavItems: Array<{ id: string; label: string; icon: React.ReactNode }>;
  threadItems: Array<{ id: number | string; title: string; active: boolean; meta?: string; folderId: string; pinned?: boolean }>;
  windowBackgroundPreference: WindowBackgroundMode;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onReturnToApp: () => void;
  onSelectSettingsTab: (tabId: string) => void;
};

function NewConversationShortcutHint() {
  return (
    <kbd
      aria-hidden="true"
      className="hidden shrink-0 items-center rounded-md border border-sidebar-border bg-sidebar-accent/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-sidebar-muted opacity-0 transition-opacity duration-150 ease-out group-hover/new-conversation-action:opacity-100 group-focus-visible/new-conversation-action:opacity-100 motion-reduce:transition-none lg:inline-flex"
    >
      ⌘N
    </kbd>
  );
}

export function Sidebar({
  activeSettingsTab,
  className,
  closeOnSelect = false,
  currentMode,
  folderItems,
  isSidebarClosing = false,
  isSidebarVisible,
  onOpenSettings,
  onReturnToApp,
  onSelectSettingsTab,
  onToggleSidebar,
  settingsNavItems,
  showNewConversationShortcut = false,
  showFloatingSidebarToggle,
  threadItems,
  titlebarMode,
  windowBackgroundPreference,
}: SidebarProps) {
  const sectionLabelClassName = "px-3 text-[11px] font-normal text-sidebar-muted";
  const sidebarHeaderSurfaceClass =
    titlebarMode === "native-transparent"
      ? getSidebarSurfaceClass(windowBackgroundPreference)
      : "bg-transparent";
  const folderLabelById = new Map(folderItems.map((item) => [item.id, item.label]));
  const primaryItems = [
    { id: "new-conversation", label: "新对话", icon: <ChatCenteredText size={18} />, active: false },
    { id: "learning-resources", label: "学习资源", icon: <Books size={18} />, active: false },
    { id: "todo", label: "待办", icon: <CheckSquare size={18} />, active: false },
  ] as const;
  const threadGroups = {
    pinned: threadItems.filter((item) => item.pinned),
    recent: threadItems.filter((item) => !item.pinned),
  } as const;
  const recentFolders = folderItems
    .map((folder) => ({
      ...folder,
      items: threadGroups.recent.filter((item) => item.folderId === folder.id),
    }))
    .filter((folder) => folder.items.length > 0 || folder.active);
  const [expandedFolderIds, setExpandedFolderIds] = useState(() => {
    const initial = new Set(
      recentFolders
        .filter((folder) => folder.active || folder.items.some((item) => item.active))
        .map((folder) => folder.id),
    );

    if (initial.size === 0 && recentFolders[0]) {
      initial.add(recentFolders[0].id);
    }

    return initial;
  });

  const closeSidebarAfterSelection = () => {
    if (closeOnSelect) {
      onToggleSidebar();
    }
  };

  const handleReturnToApp = () => {
    onReturnToApp();
    closeSidebarAfterSelection();
  };

  const handleOpenSettings = () => {
    onOpenSettings();
    closeSidebarAfterSelection();
  };

  const handleSelectSettingsTab = (tabId: string) => {
    onSelectSettingsTab(tabId);
    closeSidebarAfterSelection();
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);

      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }

      return next;
    });
  };

  return (
    <aside
      aria-hidden={!isSidebarVisible}
      data-floating-sidebar-surface
      className={cn(
        "relative z-20 flex h-full w-68 shrink-0 flex-col overflow-hidden text-sidebar-foreground",
        getSidebarSurfaceClass(windowBackgroundPreference),
        isSidebarVisible && !isSidebarClosing ? "pointer-events-auto" : "pointer-events-none",
        className,
      )}
    >
      <div className="flex h-full flex-col">
        <div data-tauri-drag-region className="w-full shrink-0" style={{ height: 0 }} />

        <div
          className={cn("relative shrink-0 pr-4", sidebarHeaderSurfaceClass)}
          style={{
            height: getSidebarHeaderHeight(titlebarMode),
            paddingLeft: getOverlayLeadingInset(titlebarMode) + 16,
          }}
        >
          <div data-tauri-drag-region className="absolute inset-0" />
          <div className="pointer-events-none relative z-10 flex h-full items-center">
            <div className="flex-1" />

            {currentMode === "app" && titlebarMode === "frameless" && !showFloatingSidebarToggle ? (
              <div className="pointer-events-auto flex items-center gap-1.5">
                <ShellButton
                  variant="icon"
                  onClick={onToggleSidebar}
                  className="text-sidebar-muted hover:text-sidebar-foreground"
                  aria-label="收起侧边栏"
                >
                  <SidebarSimple size={18} weight="regular" />
                </ShellButton>
                <SidebarUpdateBadge className="shrink-0" />
              </div>
            ) : null}
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-2 top-0 z-10 h-14 rounded-t-[1.25rem]"
            style={{
              backgroundImage:
                "linear-gradient(to bottom, color-mix(in oklab, var(--sidebar) 97%, white 3%) 0%, color-mix(in oklab, var(--sidebar) 88%, transparent) 48%, transparent 100%)",
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-2 bottom-0 z-10 h-16 rounded-b-[1.25rem]"
            style={{
              backgroundImage:
                "linear-gradient(to top, color-mix(in oklab, var(--sidebar) 98%, white 2%) 0%, color-mix(in oklab, var(--sidebar) 90%, transparent) 52%, transparent 100%)",
            }}
          />

          <ScrollArea className="h-full min-w-0" viewportClassName="px-2">
            {currentMode === "app" ? (
              <div className="space-y-3">
                <div aria-hidden="true" className="h-6 shrink-0" />

                <div className="space-y-1">
                  <nav aria-label="工作区主入口">
                    <div className="space-y-0.5" role="list">
                      {primaryItems.map((item) => {
                        const showShortcut = showNewConversationShortcut && item.id === "new-conversation";

                        return (
                          <ShellButton
                            key={item.id}
                            variant="nav"
                            role="listitem"
                            aria-current={item.active ? "page" : undefined}
                            onClick={closeSidebarAfterSelection}
                            className={cn(
                              item.active
                                ? "w-full rounded-2xl bg-interactive-selected text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1"
                                : "rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1",
                              showShortcut && "group/new-conversation-action",
                            )}
                          >
                            {item.icon}
                            <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                              <span className="truncate">{item.label}</span>
                              {showShortcut ? <NewConversationShortcutHint /> : null}
                            </span>
                          </ShellButton>
                        );
                      })}
                    </div>
                  </nav>
                </div>

                {threadGroups.pinned.length > 0 ? (
                  <section className="space-y-0.5">
                    <nav aria-label="置顶会话">
                      <div className="space-y-0.5" role="list">
                        {threadGroups.pinned.map((item) => (
                          <ShellButton
                            key={item.id}
                            variant="nav"
                            role="listitem"
                            aria-current={item.active ? "page" : undefined}
                            onClick={closeSidebarAfterSelection}
                            className={
                              item.active
                                ? "w-full rounded-2xl bg-interactive-selected text-sidebar-foreground"
                                : "rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground"
                            }
                          >
                            <span className="min-w-0 flex-1 space-y-0.5">
                              <span className="flex items-center gap-2 leading-4">
                                <PushPinSimple size={12} weight="fill" className="text-sidebar-muted" />
                                <span className="truncate">{item.title}</span>
                              </span>
                              <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-normal text-sidebar-muted leading-4">
                                <span className="truncate">{folderLabelById.get(item.folderId) ?? "未分类"}</span>
                                {item.meta ? <span aria-hidden="true">·</span> : null}
                                {item.meta ? <span className="shrink-0 tabular-nums">{item.meta}</span> : null}
                              </span>
                            </span>
                          </ShellButton>
                        ))}
                      </div>
                    </nav>
                  </section>
                ) : null}

                {threadGroups.recent.length > 0 ? (
                  <section className="space-y-0.5">
                    <div className="px-3">
                      <p className={sectionLabelClassName}>最近</p>
                    </div>
                    <nav aria-label="会话分组">
                      <div className="space-y-0.5">
                        {recentFolders.map((folder) => {
                          const isExpanded = expandedFolderIds.has(folder.id);
                          const isCurrentFolder = folder.active || folder.items.some((item) => item.active);

                          return (
                            <section key={folder.id} className="space-y-0.5">
                              <ShellButton
                                variant="nav"
                                aria-expanded={isExpanded}
                                className={
                                  isCurrentFolder
                                    ? "group w-full rounded-2xl bg-interactive-selected text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1"
                                    : "group rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1"
                                }
                                onClick={() => toggleFolder(folder.id)}
                              >
                                {folder.icon}
                                <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                  <span className="truncate">{folder.label}</span>
                                  <span className="flex items-center gap-1.5 text-sidebar-muted">
                                    <span
                                      aria-hidden="true"
                                      className="flex items-center opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                                    >
                                      <Plus size={12} />
                                    </span>
                                    <CaretRight
                                      size={12}
                                      className={cn(
                                        "shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
                                        isExpanded && "rotate-90",
                                      )}
                                    />
                                  </span>
                                </span>
                              </ShellButton>

                              <div
                                className={cn(
                                  "grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none",
                                  isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                                )}
                              >
                                <div
                                  aria-hidden={!isExpanded}
                                  className={cn(
                                    "space-y-0.5 overflow-hidden pl-4",
                                    !isExpanded && "pointer-events-none",
                                  )}
                                  role="list"
                                >
                                  {folder.items.map((item) => (
                                    <ShellButton
                                      key={item.id}
                                      variant="nav"
                                      role="listitem"
                                      aria-current={item.active ? "page" : undefined}
                                      tabIndex={isExpanded ? undefined : -1}
                                      onClick={closeSidebarAfterSelection}
                                      className={
                                        item.active
                                          ? "w-full rounded-2xl bg-interactive-selected text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1"
                                          : "rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1"
                                      }
                                    >
                                      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                        <span className="min-w-0 flex-1 truncate leading-4">{item.title}</span>
                                        {item.meta ? (
                                          <span className="shrink-0 text-[11px] font-normal tabular-nums text-sidebar-muted leading-4">
                                            {item.meta}
                                          </span>
                                        ) : null}
                                      </span>
                                    </ShellButton>
                                  ))}
                                </div>
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    </nav>
                  </section>
                ) : null}

                <div aria-hidden="true" className="h-16 shrink-0" />
              </div>
            ) : (
              <div>
                <div aria-hidden="true" className="h-6 shrink-0" />
                <ShellButton
                  variant="nav"
                  onClick={handleReturnToApp}
                  className="text-sidebar-muted hover:bg-interactive-hover hover:text-sidebar-foreground"
                >
                  <ArrowLeft size={18} />
                  <span>{SETTINGS_BACK_BUTTON_LABEL}</span>
                </ShellButton>
                <nav aria-label="设置导航" className="mt-1">
                  <div className="space-y-0.5" role="list">
                    {settingsNavItems.map((item) => {
                      const isActive = activeSettingsTab === item.id;
                      return (
                        <ShellButton
                          key={item.id}
                          variant="nav"
                          role="listitem"
                          aria-current={isActive ? "page" : undefined}
                          className={
                            isActive
                              ? "w-full rounded-2xl bg-interactive-selected text-sidebar-foreground cursor-default"
                              : "rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground"
                          }
                          onClick={isActive ? undefined : () => handleSelectSettingsTab(item.id)}
                        >
                          {item.icon}
                          <span className={`truncate ${SETTINGS_NAV_ITEM_LABEL_CLASS_NAME}`}>{item.label}</span>
                        </ShellButton>
                      );
                    })}
                  </div>
                </nav>
                <div aria-hidden="true" className="h-16 shrink-0" />
              </div>
            )}
          </ScrollArea>
        </div>

        <div aria-label="侧边栏底部" className="mt-auto px-2 pb-2 pt-1.5">
          {currentMode === "app" ? (
            <ShellButton
              variant="nav"
              data-slot="sidebar-app-settings-action"
              onClick={handleOpenSettings}
              className="rounded-2xl text-sidebar-muted hover:bg-interactive-hover hover:text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1"
            >
              <GearSix size={18} />
              <span>设置</span>
            </ShellButton>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
