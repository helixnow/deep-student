declare module '@tauri-apps/plugin-os' {
  // Minimal runtime-only shape; we avoid strict typings to keep build portable
  export function platform(): Promise<string>;
}

declare module '@tauri-apps/plugin-opener' {
  /** Opens a url with the system's default app, or the one specified with openWith */
  export function openUrl(url: string | URL, openWith?: 'inAppBrowser' | string): Promise<void>;
  /** Opens a path with the system's default app, or the one specified with openWith */
  export function openPath(path: string, openWith?: string): Promise<void>;
  /** Reveal a path with the system's default explorer */
  export function revealItemInDir(path: string | string[]): Promise<void>;
}

