import type { CSSProperties, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import './app.generated.css';
import './surface.css';
import { appI18n } from './i18n';

/**
 * 主应用里 html / body / #root 的全局规则收进作用域后落在 .ds-app 上（100vw × 100dvh、overflow: clip 等），
 * 这里按挂载面复位；调用方的 style 优先。
 */
const RESET: CSSProperties = {
  position: 'absolute',
  width: 'auto',
  height: 'auto',
  maxHeight: 'none',
  overflow: 'visible',
  borderRadius: 0,
  boxShadow: 'none',
};

/**
 * 主应用真实组件的挂载面：.ds-app 作用域内生效主应用的 Tailwind、设计 token 与全局样式（scripts/app-css.mjs 生成），
 * 并提供 i18n。尺寸与位置由调用方通过 style 给出。
 */
export const AppSurface = ({ dark = false, style, children }: { dark?: boolean; style?: CSSProperties; children: ReactNode }) => (
  <I18nextProvider i18n={appI18n}>
    <div className={dark ? 'ds-app dark' : 'ds-app'} style={{ ...RESET, ...style }}>
      {children}
    </div>
  </I18nextProvider>
);
