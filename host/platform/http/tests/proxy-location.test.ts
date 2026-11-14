/**
 * 代理解析与系统代理读取下沉到 `host/platform/http/`（W14）：llm 原位置只做 re-export，
 * 值保持同一个；llm 的 HTTP 客户端仍经 llm 自己的日志出口记录创建结果。
 * `ctx.http` 的桌面入口不再引用任何插件目录。
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import * as platformProxy from '../proxy.ts';
import * as platformSystemProxy from '../system-proxy.ts';
import * as llmProxy from '../../../plugins/llm/src/http_proxy.ts';
import * as llmSystemProxy from '../../../plugins/llm/src/system_proxy.ts';
import { setLlmLogger } from '../../../plugins/llm/src/logging.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const noPlatformProxy = async () => null;

afterEach(() => setLlmLogger(null));

describe('proxy modules live in platform/http', () => {
  it('llm system_proxy.ts re-exports the platform module unchanged', () => {
    const names = Object.keys(platformSystemProxy);
    expect(names).toEqual(expect.arrayContaining([
      'WINDOWS_INTERNET_SETTINGS_KEY', 'createPlatformProxyReader', 'parsePlatformProxyValues', 'parseRegProxy',
      'parseScutilProxy', 'resolveSystemProxy', 'systemProxyBypassed',
    ]));
    expect(Object.keys(llmSystemProxy).sort()).toEqual(names.sort());
    for (const name of names) {
      expect((llmSystemProxy as Record<string, unknown>)[name], name).toBe((platformSystemProxy as Record<string, unknown>)[name]);
    }
  });

  it('llm http_proxy.ts re-exports the pure proxy helpers unchanged', () => {
    expect(llmProxy.PROXY_ENV_KEYS).toBe(platformProxy.PROXY_ENV_KEYS);
    expect(llmProxy.environmentDefinesProxy).toBe(platformProxy.environmentDefinesProxy);
    expect(llmProxy.proxyUrlFor).toBe(platformProxy.proxyUrlFor);
  });

  it('the llm client keeps logging through the llm logger; the platform client uses the injected logger', async () => {
    const llmLines: string[] = [];
    setLlmLogger({ error: () => {}, warn: (m) => llmLines.push(`warn ${m}`), info: (m) => llmLines.push(`info ${m}`), debug: () => {} });
    const llmClient = llmProxy.createLlmHttpClient({}, { platformProxy: noPlatformProxy });
    await llmClient.close();
    expect(llmLines).toEqual(['info HTTP客户端创建成功: 完整配置（超时120s，连接15s，rustls TLS）']);

    const platformLines: string[] = [];
    const client = platformProxy.createProxyHttpClient({}, {
      platformProxy: noPlatformProxy,
      logger: { info: (m) => platformLines.push(`info ${m}`), warn: (m) => platformLines.push(`warn ${m}`) },
    });
    await client.close();
    expect(platformLines).toEqual(['info HTTP客户端创建成功: 完整配置（超时120s，连接15s，rustls TLS）']);
    expect(llmLines).toHaveLength(1);
  });

  it('ctx.http desktop entry no longer reaches into host/plugins', () => {
    const files = new Set(checkModulesClosure(ROOT, ['host/platform/http/index.ts']).map((violation) => violation.file));
    expect([...files].filter((file) => file.startsWith('host/plugins/'))).toEqual([]);
    expect(files.has('host/platform/http/system-proxy.ts')).toBe(true);
  });
});
