/** 系统代理读取已下沉到 `host/platform/http/system-proxy.ts`（W14）；本路径保留原导出。 */
export {
  WINDOWS_INTERNET_SETTINGS_KEY,
  createPlatformProxyReader,
  parsePlatformProxyValues,
  parseRegProxy,
  parseScutilProxy,
  resolveSystemProxy,
  systemProxyBypassed,
} from '../../../platform/http/system-proxy.ts';
export type {
  CommandRunner,
  PlatformProxyReader,
  PlatformProxySettings,
  SystemProxy,
} from '../../../platform/http/system-proxy.ts';
