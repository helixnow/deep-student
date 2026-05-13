export { defaultTheme } from './default';
export { darkTheme } from './dark';
export { minimalTheme } from './minimal';
export { colorfulTheme } from './colorful';
export { defaultDarkTheme } from './defaultDark';
export { minimalDarkTheme } from './minimalDark';
export { colorfulDarkTheme } from './colorfulDark';

import { defaultTheme } from './default';
import { darkTheme } from './dark';
import { minimalTheme } from './minimal';
import { colorfulTheme } from './colorful';
import { defaultDarkTheme } from './defaultDark';
import { minimalDarkTheme } from './minimalDark';
import { colorfulDarkTheme } from './colorfulDark';

export const builtinThemes = [
  defaultTheme,
  darkTheme,
  minimalTheme,
  colorfulTheme,
  // 暗色变体（hidden: true，不会出现在主题选择列表中，
  // 由 StyleRegistry.get() 在暗色模式下自动解析）
  defaultDarkTheme,
  minimalDarkTheme,
  colorfulDarkTheme,
];
