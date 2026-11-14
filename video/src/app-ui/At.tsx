import type { ReactNode } from 'react';
import { AppSurface } from './AppSurface';

export const noop = () => {};

/** 检查用合成里按画布坐标摆一块主应用组件。 */
export const At = ({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) => (
  <AppSurface style={{ left: x, top: y, width: w, background: 'transparent' }}>{children}</AppSurface>
);
