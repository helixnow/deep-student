/** 管理器测试夹具：无配置的官方插件（模块在 host/ 内，来源 builtin）。 */
import type { HostPlugin } from '../api.ts';

const plugin: HostPlugin = {
  name: 'dstu.plain',
  meta: { id: 'dstu.plain' },
  apply() {},
};

export default plugin;
