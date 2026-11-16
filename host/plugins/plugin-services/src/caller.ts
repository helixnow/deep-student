import type { Context } from '@deepseek-ai/cordis';
import type {} from '../../../kernel/plugin-caller.ts';

/**
 * The installed plugin a service method was called from. Plugin services extend Cordis `Service`: reached through
 * the caller's context, a method's `this.ctx` is that context, which the kernel maps to the owning plugin.
 */
export function callerPluginId(ctx: Context, service: string): string {
  const caller = (ctx.get('pluginCaller') as Context['pluginCaller'] | undefined)?.of(ctx);
  if (!caller) throw new Error(`${service} is only available to plugins (call it through your plugin's ctx)`);
  return caller.id;
}
