/**
 * 冻结边界 ③ 的类型快照（插件生态 v1 P0 · W01）：`host/kernel/api.ts` 任何导出的签名、成员或标签变化都会
 * 让本测试失败。确认变化是有意的之后运行
 *   DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts host/kernel/tests/api-surface.test.ts -u
 * 更新 `host/kernel/api.surface.txt`，并在提交信息中说明；`@stable` 导出只允许向后兼容的变化。
 */
import { describe, expect, it } from 'vitest';
import { apiSurface, apiTags } from './api-surface.ts';

/** 社区插件可依赖的稳定接口（插件生态 v1）。增删需要同时改这里与源码中的 `@stable`。 */
const STABLE = [
  'AppInfo', 'BackendEvents', 'CallContext', 'CommandError', 'CommandHandler', 'CommandRegistry', 'Context',
  'DegradedPlugin', 'EventTarget', 'HostPlugin', 'HostPluginOrigin', 'PLUGIN_PLATFORMS', 'PluginMeta', 'PluginPlatform',
  'ProtocolRegistry', 'ProtocolReply', 'ProtocolRequestInfo', 'Schema', 'WindowRef', 'definePlugin', 'errorDisplay',
];

describe('kernel api.ts type surface', () => {
  const surface = apiSurface();

  it('matches the committed snapshot', async () => {
    await expect(surface).toMatchFileSnapshot('../api.surface.txt');
  }, 120_000);

  it('marks exactly the plugin-facing exports @stable, none of them deprecated', () => {
    const tags = apiTags(surface);
    const stable = [...tags].filter(([, list]) => list.includes('@stable')).map(([name]) => name).sort();
    expect(stable).toEqual([...STABLE].sort());
    for (const name of STABLE) expect(tags.get(name), name).not.toContain('@deprecated');
  });
});
