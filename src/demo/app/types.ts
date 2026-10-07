/**
 * 单应用演示（demo-app.html?app=<id>）的剧本包契约。
 *
 * 官网每一章用户指南嵌一个只含该功能的演示：入口只拉这一个包和它要的应用代码，
 * 不加载整个 App 壳（顶栏、侧栏、命令面板、学习桌面）。
 *
 * 加载顺序：包模块先于 IPC mock 安装求值，所以包的**静态依赖链绝不能触达 app 模块**
 * （它们有模块级 isTauriRuntime() 常量，早于 mock 求值会永久落进非 Tauri 分支）。
 * 包里对 app 代码一律 `import type`，组件在 `load()` 里动态 import。
 */
import type React from 'react';
import type { AppWindowProps } from '@/features/workbench/core/types';

export type DemoArgs = Record<string, unknown>;

/** 返回 undefined 表示「本包不处理」，交给通用 mock */
export type DemoIpcHandler = (cmd: string, args: DemoArgs) => unknown;

export interface DemoAppPack {
  /** 窗口标题（演示壳不画标题栏，供无障碍与调试） */
  title: string;
  /**
   * 要渲染的界面。多数包直接返回 workbench 应用窗口组件（与学习桌面里开出的窗口同一份）；
   * 也可以返回包自己写的一层薄包装（比如先打开某条资源）。
   */
  load(): Promise<React.ComponentType<AppWindowProps>>;
  /** 传给窗口组件的 instanceKey / launchPayload */
  instanceKey?: string | null;
  launchPayload?: unknown;
  /** 本包的 IPC 处理；先于通用 mock 调用 */
  handle?: DemoIpcHandler;
  /** 预置的设置表（get_setting） */
  settings?: Record<string, unknown>;
  /** 预置的 localStorage（应用模块级预读的键，早于应用代码写入） */
  localStorage?: Record<string, string>;
  /**
   * 用到的文案命名空间。给了就只下这几个（更小），不给就下整包。
   * 漏了的命名空间会让界面露出原始键名：烟测会把缺失的键记在 window.__DEMO_MISSING_I18N__。
   */
  namespaces?: string[];
  /** mock 装好、组件渲染前执行（灌 store、打开某条资源等）；可以动态 import app 模块 */
  prepare?(): Promise<void> | void;
  /** 渲染后执行（比如点开某个标签页） */
  afterMount?(root: HTMLElement): Promise<void> | void;
  /** 就绪判断：真时通知父页撤占位、海报截图也在此刻拍。缺省为挂载后界面静止 */
  isReady?(root: HTMLElement): boolean;
  /** 手机宽度下的布局（嵌入框窄于此宽度时用） */
  minWidth?: number;
}

export interface DemoAppEntry {
  /** 官网指南章节 slug（/user-guide/<id>） */
  id: string;
  /** 卡片与 iframe 的默认高度（px） */
  height: number;
  /** 包加载器 */
  pack: () => Promise<{ default: DemoAppPack }>;
}
