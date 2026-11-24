import type { PluginInfo } from '@/features/settings/api/pluginsApi';

export type ChannelTranslateFn = (key: string, options?: Record<string, unknown>) => string;

const KNOWN_ILINK_LABELS = new Set([
  '',
  '微信 iLink Bot',
  'WeChat iLink Bot',
]);

const KNOWN_ILINK_BLURBS = new Set([
  '',
  '通过官方 ClawBot / iLink 协议收发微信消息，并由本地 AI 自动回复。',
  'Send and receive WeChat messages via the official ClawBot / iLink protocol with automatic local AI replies.',
]);

function isIlinkChannelPlugin(plugin: Pick<PluginInfo, 'id' | 'label'>): boolean {
  const id = plugin.id.trim().toLowerCase();
  return id === 'ilinkbot' || id === 'ilink_bot' || plugin.label.trim() === '微信 iLink Bot';
}

/**
 * Localizes builtin channel plugin title & blurb (such as WeChat iLink Bot)
 * when using the host plugin's default strings, while preserving custom overrides.
 */
export function getChannelPluginDisplay(
  plugin: Pick<PluginInfo, 'id' | 'label' | 'blurb'>,
  t: ChannelTranslateFn,
  keyPrefix = 'plugin_manager:',
): { label: string; blurb: string } {
  if (!isIlinkChannelPlugin(plugin)) {
    return { label: plugin.label, blurb: plugin.blurb };
  }
  const rawLabel = plugin.label.trim();
  const rawBlurb = plugin.blurb.trim();
  const label = KNOWN_ILINK_LABELS.has(rawLabel)
    ? t(`${keyPrefix}channel.ilinkLabel`, { defaultValue: plugin.label })
    : plugin.label;
  const blurb = rawBlurb && !KNOWN_ILINK_BLURBS.has(rawBlurb)
    ? plugin.blurb
    : (rawBlurb ? t(`${keyPrefix}channel.ilinkBlurb`, { defaultValue: plugin.blurb }) : '');
  return { label, blurb };
}
