/** 官方（应用内）夹具：社区插件 requires 与 inject 的对象；版本取应用版本（没有 meta.version）。 */
import { definePlugin } from '../../api.ts';

export default definePlugin({
  meta: { id: 'fixture.manifest-official', lane: 'W01-test', provides: ['manifestOfficial'] },
  apply(ctx) {
    ctx.provide('manifestOfficial', { hello: () => 'official' });
  },
});
