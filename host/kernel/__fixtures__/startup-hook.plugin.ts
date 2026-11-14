/**
 * D2 业务插件注册失败夹具：通过真实 `ctx.storage`（F3 `StorageCordisService`）注册 finalizer。
 *
 * 第一次注册成功后，第二次同名注册触发真实 registry 的 `FINALIZER_DUPLICATE`。用于验证
 * `installProfile` 的既有隔离规则：插件被 degraded，boot 是否仍能 ready，以及第一次注册
 * 的 finalizer 是否会在插件回滚后继续执行（当前 F3 registerFinalizer 没有注销句柄）。
 */
import { definePlugin } from '../api.ts';

export interface RealHookFixtureState {
  /** 该夹具注册的 finalizer 实际被执行时写入。 */
  executed: string[];
}

export const realHookStates: RealHookFixtureState[] = [];

interface FinalizerStorage {
  registerFinalizer(name: string, fn: () => void | Promise<void>): void;
}

export default definePlugin<undefined>({
  inject: ['storage'],
  meta: {
    id: 'fixture.startup-hook',
    lane: 'F1-fixture',
  },
  apply(ctx) {
    const state: RealHookFixtureState = { executed: [] };
    realHookStates.push(state);
    const storage = ctx.get('storage') as FinalizerStorage | undefined;
    if (storage === undefined) throw new Error('fixture.startup-hook requires storage');

    storage.registerFinalizer('fixture.startup-hook.cleanup', () => {
      state.executed.push('cleanup');
    });
    // 真实 registry 在这里抛 FINALIZER_DUPLICATE；apply 失败后 installIsolated 只回滚本插件。
    storage.registerFinalizer('fixture.startup-hook.cleanup', () => {
      state.executed.push('duplicate');
    });
  },
});
