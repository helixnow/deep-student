/**
 * 插件配置：`HostPlugin.Config`（Schemastery schema）在 `apply` 之前校验 profile 配置并补齐默认值
 * （`decisions/2026-11-07-plugin-ecosystem-v1.md`「配置」）。凭据不进配置：schema 中出现
 * `role('secret')` 或凭据类字段名即拒绝装载，凭据走密钥服务。
 *
 * Cordis 4 自己也会在 `Fiber._reload` 里用 `plugin.Config['~standard'].validate` 校验配置
 * （`@deepseek-ai/cordis/src/fiber.ts` `resolveConfig`）；kernel 先校验一次是为了给出结构化错误码与凭据检查，
 * 交给 Cordis 的已是补齐默认值后的配置（Schemastery 校验幂等），`fiber.update` 热更新仍由 Cordis 校验。
 * 可移植：不依赖 Node 内建模块。
 */
import type Schema from '@deepseek-ai/schemastery';
import type { HostPlugin } from './api.ts';
import { PluginLoadError } from './manifest.ts';

/** 凭据类字段名（大小写、`-`/`_` 不敏感）。 */
const CREDENTIAL_KEY = /^(?:api[-_]?key|secret|client[-_]?secret|password|passwd|pass[-_]?phrase|token|access[-_]?token|refresh[-_]?token|bearer[-_]?token|private[-_]?key|credentials?)$/i;

interface SchemaNode {
  type?: unknown;
  meta?: { role?: unknown };
  dict?: Record<string, SchemaNode>;
  inner?: SchemaNode;
  list?: SchemaNode[];
}

function isSchemastery(value: unknown): value is Schema {
  return typeof value === 'function' && typeof (value as SchemaNode).type === 'string' && typeof (value as SchemaNode).meta === 'object'
    && typeof (value as { '~standard'?: { validate?: unknown } })['~standard']?.validate === 'function';
}

/** schema 中声明凭据的位置（`$.a.b` 形式）；没有返回空数组。 */
export function credentialFields(schema: Schema): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: SchemaNode | undefined, path: string) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.meta?.role === 'secret') found.push(path);
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      const at = `${path}.${key}`;
      if (CREDENTIAL_KEY.test(key) && !found.includes(at)) found.push(at);
      visit(child, at);
    }
    visit(node.inner, `${path}[]`);
    for (const child of node.list ?? []) visit(child, path);
  };
  visit(schema as unknown as SchemaNode, '$');
  return found;
}

/**
 * 按插件的 `Config` 校验配置并补齐默认值；插件没有 `Config` 时原样返回（与旧行为相同）。
 * 失败抛 {@link PluginLoadError}：`CONFIG_INVALID`（不是 Schemastery schema / 配置不合法）或 `CONFIG_CREDENTIAL`。
 */
export function resolvePluginConfig(plugin: HostPlugin<any>, config: unknown): unknown {
  const schema = plugin.Config;
  if (schema === undefined) return config;
  const id = plugin.meta.id;
  if (!isSchemastery(schema)) throw new PluginLoadError('CONFIG_INVALID', id, 'plugin.Config must be a Schemastery schema');
  const credentials = credentialFields(schema);
  if (credentials.length) {
    throw new PluginLoadError('CONFIG_CREDENTIAL', id, `Config declares credential fields ${credentials.join(', ')}; credentials belong in the secrets service, not in plugin config`);
  }
  const result = schema['~standard'].validate(config);
  if ('then' in result) throw new PluginLoadError('CONFIG_INVALID', id, 'asynchronous Config validation is not supported');
  if (result.issues) {
    const issues = result.issues.map(issue => issue.message).join('; ');
    throw new PluginLoadError('CONFIG_INVALID', id, `invalid config: ${issues}`);
  }
  return result.value;
}
