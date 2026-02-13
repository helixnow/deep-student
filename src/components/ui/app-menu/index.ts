/**
 * AppMenu - 现代化菜单组件导出
 */

export {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuSub,
  AppMenuSubTrigger,
  AppMenuSubContent,
  AppMenuSeparator,
  AppMenuLabel,
  AppMenuFooter,
  AppMenuSwitchItem,
  AppMenuCheckboxItem,
  AppMenuOptionGroup,
  AppMenuShortcut,
  // 命名空间导出
  AppMenu as Root,
  AppMenuTrigger as Trigger,
  AppMenuContent as Content,
  AppMenuGroup as Group,
  AppMenuItem as Item,
  AppMenuSub as Sub,
  AppMenuSubTrigger as SubTrigger,
  AppMenuSubContent as SubContent,
  AppMenuSeparator as Separator,
  AppMenuLabel as Label,
  AppMenuFooter as Footer,
  AppMenuSwitchItem as SwitchItem,
  AppMenuCheckboxItem as CheckboxItem,
  AppMenuOptionGroup as OptionGroup,
  AppMenuShortcut as Shortcut,
} from './AppMenu';

export type {
  AppMenuProps,
  AppMenuTriggerProps,
  AppMenuContentProps,
  AppMenuGroupProps,
  AppMenuItemProps,
  AppMenuSubProps,
  AppMenuSubTriggerProps,
  AppMenuSubContentProps,
  AppMenuSeparatorProps,
  AppMenuLabelProps,
  AppMenuFooterProps,
  AppMenuSwitchItemProps,
  AppMenuCheckboxItemProps,
  AppMenuOptionItem,
  AppMenuOptionGroupProps,
  AppMenuShortcutProps,
} from './AppMenu';

// Demo component
export { AppMenuDemo } from './AppMenuDemo';

// Select component (基于 AppMenu 的下拉选择框)
export { AppSelect } from './AppSelect';
export type { AppSelectProps, AppSelectOption, AppSelectGroup } from './AppSelect';
