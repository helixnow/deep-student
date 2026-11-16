import { Service, type Context } from '@deepseek-ai/cordis';
import type { SystemNotificationService } from '../../../../electron/api.ts';
import type { PluginNotification, PluginNotifyResult, PluginNotifyService } from '../api.ts';
import { callerPluginId } from './caller.ts';

const MAX_TITLE = 120;
const MAX_BODY = 1000;

/**
 * `pluginNotify`: a system notification on behalf of the calling plugin. The click action names the plugin, so the
 * renderer opens that plugin's view (`src/ui-kernel/community.ts` `openPluginNotificationTarget`). The user's
 * notification policy (settings) still applies.
 */
export class PluginNotify extends Service implements PluginNotifyService {
  constructor(ctx: Context) {
    super(ctx, 'pluginNotify');
  }

  async notify(notification: PluginNotification): Promise<PluginNotifyResult> {
    const pluginId = callerPluginId(this.ctx, 'pluginNotify');
    const title = typeof notification?.title === 'string' ? notification.title.trim().slice(0, MAX_TITLE) : '';
    const body = typeof notification?.body === 'string' ? notification.body.trim().slice(0, MAX_BODY) : '';
    if (title === '' && body === '') throw new Error('PLUGIN_NOTIFY_INVALID: title or body is required');
    const system = this.ctx.get('systemNotification') as SystemNotificationService | undefined;
    if (!system) return { delivered: false, reason: 'unavailable' };
    const action: Record<string, unknown> = { kind: 'plugin', pluginId };
    if (typeof notification.view === 'string' && notification.view !== '') action.view = notification.view;
    if (notification.params && typeof notification.params === 'object') action.params = JSON.parse(JSON.stringify(notification.params));
    const outcome = await system.notify({
      title: title || body,
      body: title ? body : '',
      ...(notification.silent === true ? { silent: true } : {}),
      action,
    });
    if (outcome.delivered) return { delivered: true };
    return { delivered: false, reason: outcome.suppressed ?? outcome.error ?? 'unknown' };
  }
}
