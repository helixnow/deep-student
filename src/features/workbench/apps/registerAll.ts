/**
 * 应用装配入口（P11）
 *
 * WorkbenchDesktop 挂载前统一 import 全部应用注册模块，保证 appRegistry 完整。
 * 本模块只应被 workbench lazy chunk（WorkbenchDesktop）引用——
 * 开关关闭时不加载，不污染 legacy bundle。
 *
 * - chat / content(六类：textbook/exam/translation/essay/image/file) /
 *   notes(承载 note + mindmap 资源) / files / preview(file-preview)：
 *   import 即幂等注册（files register 同时启动资源删除联动 resourceSync）。
 *   独立 mindmap 应用定义存在但**有意不注册**（导图在 notes 工作区打开，
 *   契约见 content/__tests__/registers.test.tsx）。
 * - system(七个) / sandbox / browser：调用幂等注册函数。
 *   browser 不钉 DEFAULT_DOCK_PINNED；发现走 AppsPanel。
 */
import './chat/register';
import './content/register';
import './notes/register';
import './files/register';
import './preview/register';
import { registerSystemApps } from './system/register';
import { registerSandboxApp } from './sandbox/register';
import { registerBrowserApp } from './browser/register';
import { registerDesktopAgentTarget } from './desktop/register';

/** Dock 固定区默认值（编排文档 P11：chat/files/settings/todo）
 * 保持短 Dock 4 钉；全部应用发现走 L4 AppsPanel（Dock 右侧 `__apps__` 入口），勿钉满。 */
export const DEFAULT_DOCK_PINNED: readonly string[] = ['chat', 'files', 'settings', 'todo'];

let registered = false;

/** 幂等装配全部 workbench 应用 */
export function registerAllWorkbenchApps(): void {
  if (registered) return;
  registered = true;
  registerSystemApps();
  registerSandboxApp();
  registerBrowserApp();
  // ACR 4.0（A2）：desktop 虚拟目标（仅 agent 能力面，不进 appRegistry）
  registerDesktopAgentTarget();
}

registerAllWorkbenchApps();
