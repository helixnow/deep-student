// What the user is told a workshop candidate can do, and where they will find it once installed.
// Dependency-free on purpose: the plugin manager's tests import it to check that every permission the user consents
// to on the confirmation card is said in the same words the manager uses (src/features/plugin-manager/permissions.ts,
// `plugin_manager.permission.*` in zh-CN).
import type { WorkshopPlace } from '../api.ts';
import { detectedLines, type DetectedUse } from './detect.ts';

interface DeclaringManifest {
  readonly id: string;
  readonly displayName?: string;
  readonly permissions: readonly string[];
  readonly agentTools?: readonly { readonly title: string; readonly sensitivity?: string }[];
}

/** Whole sentences for well-known services (same words as `plugin_manager.permission.services`). */
export const SERVICE_CAPABILITIES: Readonly<Record<string, string>> = {
  pluginModel: '用当前对话模型生成文字',
  storage: '在插件自己的数据目录里保存数据',
  settings: '读取和保存设置',
  studyData: '会读取和修改你的学习数据（笔记、卡片、题目、复习、待办、资料库）',
  pluginSecrets: '保存了你填的密钥（存进系统安全存储，只有这个插件能读）',
  pluginNotify: '会发系统通知',
  pluginSchedule: '会按时自动运行',
};
/** Human names of app services (same words as `plugin_manager.permission.serviceNames`). */
export const SERVICE_NAMES: Readonly<Record<string, string>> = {
  notes: '笔记', anki: 'Anki 卡片', qbank: '题库', review: '复习计划', mastery: '掌握度', chatPipeline: '对话',
  llm: '大模型', translation: '翻译', vfs: '资料库', retrieval: '资料检索', media: '媒体与文档', ocr: '文字识别',
  mcp: 'MCP 工具', webSearch: '联网搜索', browser: '浏览器', files: '本地文件', http: '网络请求', secrets: '安全凭据',
  backup: '备份',
};

export function serviceCapability(name: string): string {
  return SERVICE_CAPABILITIES[name] ?? `使用应用服务「${SERVICE_NAMES[name] ?? name}」`;
}

/**
 * The capability lines the confirmation card shows first. Derived by the Host from the screened manifest and the
 * built module's `inject` list, never from model-written text. Every `agent:tools`, `net:` and `service:`
 * permission yields at least one line. `detected` (detect.ts, read from the built bundles) adds what the code itself
 * uses — files, programs, network, background work, which service methods read or change — as information only.
 */
export function declaredCapabilities(manifest: DeclaringManifest, inject: readonly string[] = [], detected?: DetectedUse): string[] {
  const lines: string[] = [];
  for (const tool of manifest.agentTools ?? []) {
    lines.push(`让 AI 助手学会新本事「${tool.title}」${tool.sensitivity === 'high' ? '（敏感操作，调用前按你的审批设置询问）' : ''}`);
  }
  for (const permission of manifest.permissions) {
    if (permission.startsWith('net:')) lines.push(`联网读取 ${permission.slice('net:'.length)}（只读，仅限这个域名）`);
  }
  const services = new Set<string>();
  for (const permission of manifest.permissions) if (permission.startsWith('service:')) services.add(permission.slice('service:'.length));
  for (const name of inject) if (name !== 'log') services.add(name);
  for (const name of services) lines.push(serviceCapability(name));
  if (detected) {
    // Well-known services already have a whole sentence; the detail is for app services named by their data.
    // studyData / pluginSecrets get their own detail (which data, read or saved) next to the sentence.
    const details = Object.fromEntries(Object.entries(detected.services).filter(([name]) => !(name in SERVICE_CAPABILITIES) || name === 'studyData' || name === 'pluginSecrets'));
    for (const line of detectedLines({ ...detected, services: details }, name => SERVICE_NAMES[name] ?? name)) {
      // A detailed line (「会按时自动运行（每天 22:00）」) replaces the plain sentence it details.
      const plain = lines.findIndex(existing => line.startsWith(`${existing}（`));
      if (plain >= 0) lines.splice(plain, 1);
      if (!lines.includes(line)) lines.push(line);
    }
  }
  return lines;
}

/**
 * Where the user finds the work: a desktop app (a registered view or workbench app), a button in the notes selection
 * toolbar, or a new skill of the AI assistant. Read from the built UI bundle's registrations and the manifest; a
 * hint for the confirmation card, not an authority (the manager uses live contribution points once it runs).
 */
export function detectPlaces(manifest: DeclaringManifest, uiBundle: string | undefined): WorkshopPlace[] {
  const places: WorkshopPlace[] = [];
  const title = manifest.displayName?.trim() || manifest.id;
  if (uiBundle) {
    if (/\bviews\.register\s*\(|["']workbench\.apps["']/.test(uiBundle)) places.push({ kind: 'app', title });
    if (/["']editor\.selectionToolbar["']/.test(uiBundle)) places.push({ kind: 'selectionButton' });
  }
  for (const tool of manifest.agentTools ?? []) places.push({ kind: 'agentTool', title: tool.title });
  return places;
}
