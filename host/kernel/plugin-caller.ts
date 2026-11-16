/**
 * `ctx.pluginCaller`：告诉官方服务「是哪个插件在调用我」。
 *
 * 插件专属的服务（`pluginSecrets`、`pluginNotify`、`pluginSchedule`、`pluginFiles`，见 `host/plugins/plugin-services`）
 * 按调用方插件 id 划分数据：服务写成 Cordis `Service` 子类时，经调用方 `ctx` 访问的方法里 `this.ctx` 就是调用方的
 * context，把它交给 `of(ctx)` 得到已安装插件的 id。归属沿 fiber 父链找第一个插件根 fiber，与 `ctx.uiEvents` 的前缀判定同源。
 *
 * 只是归属查询，不做权限判断。挂在根 fiber 上，不需要 inject。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { KernelState } from './kernel.ts';

export interface PluginCallerInfo {
  /** 已安装插件的 id（清单 id）。 */
  readonly id: string;
  /** 社区插件（含工坊作品）为 true，官方插件为 false。 */
  readonly community: boolean;
  /** 插件包所在目录（社区插件）。 */
  readonly packageRoot?: string;
}

export interface PluginCaller {
  /** `ctx` 所属的已安装插件；根 context 或已卸载插件的残留 context 返回 undefined。 */
  of(ctx: Context): PluginCallerInfo | undefined;
}

export class PluginCallerService extends Service implements PluginCaller {
  private readonly kernel: KernelState;

  constructor(ctx: Context, kernel: KernelState) {
    super(ctx, 'pluginCaller');
    this.kernel = kernel;
  }

  of(ctx: Context): PluginCallerInfo | undefined {
    const fiber = (ctx as { fiber?: Context['fiber'] } | undefined)?.fiber;
    if (!fiber) return undefined;
    const owner = this.kernel.ownerOf(fiber);
    if (!owner) return undefined;
    return Object.freeze({
      id: owner.id,
      community: owner.packageRoot !== undefined,
      ...(owner.packageRoot === undefined ? {} : { packageRoot: owner.packageRoot }),
    });
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 调用方插件归属（`host/kernel/plugin-caller.ts`）。 */
    pluginCaller: PluginCaller;
  }
}
