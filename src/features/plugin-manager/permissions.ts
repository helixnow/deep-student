// RUST-FIX(RF-P6-manager-cards): 权限的人话。用词与插件工坊确认卡（host/plugins/plugin-workshop/src/compiler.ts
// `declaredCapabilities`）一致，让用户在确认卡、同意弹窗与管理页看到同一套说法。
import type { ManagedPlugin } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface PermissionLine {
  /** 给人看的一句话。 */
  readonly text: string;
  /** 这句话对应的权限原文（核对与求助用，只放在不显眼的位置）。 */
  readonly raw: string;
}

/** 已知服务的整句说法（与工坊确认卡逐字一致）；其余服务用「使用应用服务「名称」」。 */
const SENTENCE_SERVICES = new Set(['pluginModel', 'storage', 'settings', 'studyData', 'pluginSecrets', 'pluginNotify', 'pluginSchedule']);

function serviceLine(name: string, t: Translate): string {
  if (SENTENCE_SERVICES.has(name)) return t(`permission.services.${name}`);
  const key = `permission.serviceNames.${name}`;
  const human = t(key, { defaultValue: name });
  return t('permission.service', { name: human && human !== key ? human : name });
}

/**
 * 权限串 → 人话行。`agent:tools` 展开成每个声明的工具（`agentTools[].title`）；`net:<host>` 与 `service:<name>`
 * 各一行；不认识的权限照原文显示，不猜它的含义。
 */
export function permissionLines(
  permissions: readonly string[],
  agentTools: ManagedPlugin['agentTools'],
  t: Translate,
): PermissionLine[] {
  const lines: PermissionLine[] = [];
  for (const raw of permissions) {
    const separator = raw.indexOf(':');
    const kind = separator < 0 ? raw : raw.slice(0, separator);
    const target = separator < 0 ? '' : raw.slice(separator + 1);
    if (raw === 'agent:tools') {
      if (agentTools?.length) for (const tool of agentTools) lines.push({ raw, text: t('permission.agentTool', { title: tool.title }) });
      else lines.push({ raw, text: t('permission.agentTools') });
    } else if (kind === 'net' && target.startsWith('write:') && target.length > 'write:'.length) {
      lines.push({ raw, text: t('permission.netWrite', { host: target.slice('write:'.length) }) });
    } else if (kind === 'net' && target.startsWith('local:') && target.length > 'local:'.length) {
      lines.push({ raw, text: t('permission.netLocal', { port: target.slice('local:'.length) }) });
    } else if (kind === 'net' && target) lines.push({ raw, text: t('permission.net', { host: target }) });
    else if (kind === 'service' && target) lines.push({ raw, text: serviceLine(target, t) });
    else lines.push({ raw, text: raw });
  }
  return lines;
}
