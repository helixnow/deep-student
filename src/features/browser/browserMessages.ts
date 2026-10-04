/**
 * 内置浏览器面向用户的错误文案（调用时按当前语言求值，勿缓存为模块常量）。
 * 键位于 `settings:browserRuntime.*`。
 */
import i18n from '@/i18n';

export const browserMessages = {
  needWorkbench: (): string =>
    i18n.t('settings:browserRuntime.needWorkbench', {
      defaultValue: '内置浏览器不可用：请先启用学习桌面',
    }),
  needBrowserEnabled: (): string =>
    i18n.t('settings:browserRuntime.needBrowserEnabled', {
      defaultValue: '内置浏览器不可用：请在设置中启用内置浏览器',
    }),
  flagUnreadable: (): string =>
    i18n.t('settings:browserRuntime.flagUnreadable', {
      defaultValue: '内置浏览器不可用：无法读取功能开关，请重试',
    }),
  flagDisabled: (): string =>
    i18n.t('settings:browserRuntime.flagDisabled', {
      defaultValue: '内置浏览器不可用：当前版本未开放此功能（功能开关已关闭）',
    }),
  disabled: (): string =>
    i18n.t('settings:browserRuntime.disabled', {
      defaultValue: '内置浏览器不可用：功能未启用',
    }),
  commandMissing: (command: string): string =>
    i18n.t('settings:browserRuntime.commandMissing', {
      command,
      defaultValue: '浏览器后端命令尚未就绪（{{command}}）。请确认 workbench 浏览器功能已启用并完成接线。',
    }),
  commandFailed: (command: string): string =>
    i18n.t('settings:browserRuntime.commandFailed', {
      command,
      defaultValue: '浏览器命令失败：{{command}}',
    }),
  operationFailed: (): string =>
    i18n.t('settings:browserRuntime.operationFailed', { defaultValue: '浏览器操作失败' }),
  busy: (): string =>
    i18n.t('settings:browserRuntime.busy', { defaultValue: '浏览器正在处理上一项操作' }),
  navigationBlocked: (detail: string): string =>
    i18n.t('settings:browserRuntime.navigationBlocked', {
      detail,
      defaultValue: '导航被阻止：{{detail}}',
    }),
  securityPolicy: (): string =>
    i18n.t('settings:browserRuntime.securityPolicy', {
      defaultValue: '目标不符合浏览器安全策略',
    }),
};
