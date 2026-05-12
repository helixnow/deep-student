import type {
  SidebarPreviewFolder,
  SidebarPreviewItem,
  SidebarPreviewThread,
} from "@/components/content/settings-demo-sections";

import { settingsNavItems, sidebarFolderItems, threadItems } from "./sidebar-data";

export const demoSidebarPreviewItems: SidebarPreviewItem[] = settingsNavItems
  .filter((item) => item.id === "demo" || item.id === "about");

export const demoSidebarPreviewFolders: SidebarPreviewFolder[] = sidebarFolderItems;

export const demoSidebarPreviewThreads: SidebarPreviewThread[] = threadItems;
