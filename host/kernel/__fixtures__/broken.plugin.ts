/** 测试夹具：apply 中途失败的插件，用于验证 profile 回滚。 */
import { definePlugin } from '../api.ts';

export default definePlugin({
  meta: { id: 'fixture.broken', lane: 'F1-fixture', commands: ['fixture_unported'] },
  apply(ctx) {
    ctx.commands.register('fixture_unported', () => null);
    throw new Error('broken plugin failed to start');
  },
});
