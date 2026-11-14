/** 管理器配置测试夹具：带 Schemastery `Config` 的官方插件（模块在 host/ 内，来源 builtin）。 */
import Schema from '@deepseek-ai/schemastery';
import type { HostPlugin } from '../api.ts';

const plugin: HostPlugin<{ enabled: boolean; mode: 'fast' | 'safe'; retries: number; label: string; hidden?: string }> = {
  name: 'dstu.configurable',
  meta: { id: 'dstu.configurable' },
  Config: Schema.object({
    enabled: Schema.boolean().default(true).description('开关'),
    mode: Schema.union([Schema.const('fast').description('快'), Schema.const('safe')]).default('fast'),
    retries: Schema.natural().min(0).max(5).default(2),
    label: Schema.string().default('x').description('标签'),
    hidden: Schema.string().hidden().default('h'),
  }),
  apply(_ctx, config) {
    (globalThis as { __w01ManagerConfigs?: unknown[] }).__w01ManagerConfigs?.push(config);
  },
};

export default plugin;
