/** 测试夹具：与 greeter 同 id 的"用户插件"，用于验证 profile 覆盖。 */
import { definePlugin } from '../api.ts';

export default definePlugin({
  meta: { id: 'fixture.greeter', lane: 'F1-fixture', commands: ['fixture_greet'] },
  apply(ctx) {
    ctx.commands.register<{ name: string }, string>('fixture_greet', ({ name }) => `Overridden, ${name}`);
  },
});
