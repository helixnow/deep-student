declare module '@tauri-apps/api/window' {
  // Fallback typings for older Tauri API versions where these are not included
  export const appWindow: any;
  export class WebviewWindow {
    static getCurrent(): any;
    isDevtoolsOpen?(): Promise<boolean>;
    openDevtools?(): Promise<void>;
    closeDevtools?(): Promise<void>;
    toggleDevtools?(): Promise<void>;
  }

  /**
   * Returns the current window handle.
   * This is a minimal fallback typing for projects that rely on older type shims.
   */
  export function getCurrentWindow(): any;
} 