import {
  Cpu,
  FolderOpen,
  FolderSimple,
  FolderSimpleStar,
  GridFour,
  GearSix,
  Info,
  Palette,
  Sliders,
  Toolbox,
} from "@phosphor-icons/react";

export type SettingsTabId =
  | "general"
  | "appearance"
  | "models"
  | "tools"
  | "advanced"
  | "demo"
  | "about";

type SettingsNavItem = {
  id: SettingsTabId;
  label: string;
  icon: React.ReactNode;
};

type SidebarFolderItem = {
  id: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  count: number;
};

type ThreadItem = {
  id: number | string;
  title: string;
  active: boolean;
  meta?: string;
  folderId: string;
  pinned?: boolean;
};

export const settingsNavItems: SettingsNavItem[] = [
  { id: "general", label: "通用", icon: <GearSix size={16} /> },
  { id: "appearance", label: "外观", icon: <Palette size={16} /> },
  { id: "models", label: "模型", icon: <Cpu size={16} /> },
  { id: "tools", label: "工具", icon: <Toolbox size={16} /> },
  { id: "advanced", label: "高级", icon: <Sliders size={16} /> },
  { id: "demo", label: "组件 Demo", icon: <GridFour size={16} /> },
  { id: "about", label: "关于", icon: <Info size={16} /> },
];

export const threadItems: ThreadItem[] = [
  { id: 1, title: "调研 DeepStudent 组件框架", active: false, meta: "6 天", folderId: "research", pinned: true },
  { id: 2, title: "请你阅读这篇论文还有指导意...", active: false, meta: "1 天", folderId: "research" },
  { id: 3, title: "移除设置分类提示块内容...", active: true, meta: "3 天", folderId: "study-ui", pinned: true },
  { id: 4, title: "优化按钮更贴近 Apple 视觉...", active: false, meta: "31 分", folderId: "study-ui" },
  { id: 5, title: "按计划修复 Apple 半透明 Sid...", active: false, meta: "3 天", folderId: "ops" },
  { id: 6, title: "Create 苹果风格 UX 规划方案", active: false, meta: "3 天", folderId: "reference" },
];

const sidebarFolderBlueprint = [
  { id: "study-ui", label: "study-ui", icon: <FolderOpen size={16} />, active: true },
  { id: "research", label: "设计研究", icon: <FolderSimple size={16} />, active: false },
  { id: "ops", label: "待跟进", icon: <FolderSimple size={16} />, active: false },
  { id: "reference", label: "参考库", icon: <FolderSimpleStar size={16} />, active: false },
] as const;

export const sidebarFolderItems: SidebarFolderItem[] = sidebarFolderBlueprint.map((folder) => ({
  ...folder,
  count: threadItems.filter((item) => item.folderId === folder.id).length,
}));
