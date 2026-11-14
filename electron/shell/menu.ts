/**
 * 应用菜单，对应 src-tauri/src/menu.rs：只在 macOS 安装（File/Edit/View/Window/Help + 应用菜单），
 * 自定义项点击时向前端 `emit` `menu://*` 事件（payload `()` → null）。Windows/Linux 不安装菜单
 * （Tauri 在这两个平台默认无菜单；Electron 默认菜单需显式移除）。
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron';

export const MENU_EVENTS = {
  preferences: 'menu://preferences',
  new_session: 'menu://new-session',
  close_window: 'menu://close-window',
  command_palette: 'menu://command-palette',
  toggle_sidebar: 'menu://toggle-sidebar',
  documentation: 'menu://documentation',
  report_issue: 'menu://report-issue',
} as const;

export function installMenu(platform: NodeJS.Platform, version: string, emit: (event: string) => void): void {
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  app.setAboutPanelOptions({ applicationName: 'Deep Student', applicationVersion: version, copyright: 'Deep Student contributors' });
  const item = (id: keyof typeof MENU_EVENTS, label: string, accelerator?: string): MenuItemConstructorOptions => ({
    id,
    label,
    ...(accelerator !== undefined ? { accelerator } : {}),
    click: () => emit(MENU_EVENTS[id]),
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Deep Student',
      submenu: [
        { role: 'about', label: 'About Deep Student' },
        { type: 'separator' },
        item('preferences', 'Preferences…', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'File', submenu: [item('new_session', 'New Conversation', 'CmdOrCtrl+N'), { type: 'separator' }, item('close_window', 'Close Window', 'CmdOrCtrl+W')] },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [item('command_palette', 'Command Palette…', 'CmdOrCtrl+K'), item('toggle_sidebar', 'Toggle Sidebar', 'CmdOrCtrl+B'), { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    { label: 'Help', submenu: [item('documentation', 'Deep Student Documentation'), item('report_issue', 'Report Issue…')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
