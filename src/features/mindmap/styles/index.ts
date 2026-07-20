import { StyleRegistry } from '../registry';
import { builtinThemes } from './themes';

export * from './themes';
export { useMindMapTheme, useMindMapDarkMode } from './useMindMapTheme';

/** 注册所有内置样式主题 */
export function registerBuiltinStyles(): void {
  builtinThemes.forEach(theme => {
    StyleRegistry.register(theme);
  });
}
