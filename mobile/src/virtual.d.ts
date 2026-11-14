/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DSTU_APP_VERSION?: string;
}

declare module 'virtual:dstu-app-entry' {}

declare module 'virtual:dstu-profile/mobile' {
  import type { HostPlugin } from '../../host/kernel/api.ts';

  /** `host/profiles/mobile.json` 的条目，模块已在构建期静态导入。 */
  const entries: readonly { id: string; module: string; plugin: HostPlugin<any>; config?: unknown }[];
  export default entries;
}

declare module 'virtual:dstu-rust-app-commands' {
  /** 应用 `allow-application-commands` 的命令名（`resources/app/permissions/*.toml`，构建期读出，已排序去重）。 */
  const commands: readonly string[];
  export default commands;
}
