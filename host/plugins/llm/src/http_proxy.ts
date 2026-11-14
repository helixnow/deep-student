/**
 * 代理解析与代理 HTTP 客户端已下沉到 `host/platform/http/proxy.ts`（W14）；本路径保留原名导出，
 * `createLlmHttpClient` 把客户端创建日志接到 llm 的日志出口（`logging.ts`）。
 */
import {
  createProxyHttpClient,
  type ProxyEnvironment,
  type ProxyHttpClient,
  type ProxyHttpClientOptions,
} from '../../../platform/http/proxy.ts';
import { logInfo, logWarn } from './logging.ts';
import { runtimeEnvironment } from './runtime_env.ts';

export { PROXY_ENV_KEYS, environmentDefinesProxy, proxyUrlFor } from '../../../platform/http/proxy.ts';
export type {
  ProxyEnvironment,
  ProxyHttpClient as LlmHttpClient,
  ProxyRequestInit as LlmRequestInit,
} from '../../../platform/http/proxy.ts';
export type LlmHttpClientOptions = Omit<ProxyHttpClientOptions, 'logger'>;

/** mod.rs:5549. Each manager owns its pool; no global dispatcher mutation. */
export function createLlmHttpClient(environment: ProxyEnvironment = runtimeEnvironment(),
  clientOptions: LlmHttpClientOptions = {}): ProxyHttpClient {
  return createProxyHttpClient(environment, { ...clientOptions, logger: { info: logInfo, warn: logWarn } });
}
