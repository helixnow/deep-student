/** 官方夹具：把收到的配置记到 `globalThis.__w01ConfigEcho`，用于配置覆盖测试。 */
import { definePlugin } from '../../api.ts';

export default definePlugin<unknown>({
  meta: { id: 'fixture.config-echo', lane: 'W01-test' },
  apply(_ctx, config) {
    (globalThis as { __w01ConfigEcho?: unknown[] }).__w01ConfigEcho?.push(config);
  },
});
