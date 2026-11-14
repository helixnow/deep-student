/**
 * 插件文案（FRONTEND-PLUGINIZATION §2.6）：命名空间隔离与 `useT`。
 *
 * - 每个插件有自己的命名空间（`meta.i18n.namespace`，缺省为插件 id）；`ctx.ui.i18n.addBundles` 只写这里；
 * - v1 的 `addBundle(lng, ns, resources)` 保留：社区插件只能写入未被认领的非官方命名空间，写入即认领；
 *   官方（保留）命名空间与他人命名空间直接拒绝；官方插件不受此限；
 * - 插件的 `t` 由内核解析：只查本插件认领的命名空间，按当前语言链回落语言，绝不跨命名空间回落；
 * - 语言包同时转发给窗口的 i18next 适配器，官方界面用 `ns:key` 渲染插件条目（例如导航标签）时照常工作；
 * - 卸载时移除语言包、释放命名空间，捕获的 `t` 只返回键名。
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { UiPluginScope } from '../scope';

export interface UiI18nAdapter {
  addBundle(lng: string, ns: string, resources: Record<string, unknown>): () => void;
  /** 当前语言的解析顺序（含回落语言），如 `['zh-CN', 'zh', 'en-US']`。 */
  languages?(): readonly string[];
  onLanguageChanged?(listener: () => void): () => void;
  /** 官方命名空间：社区插件不得写入。 */
  isReservedNamespace?(ns: string): boolean;
}

export interface UiTranslateOptions {
  count?: number;
  defaultValue?: string;
  [variable: string]: unknown;
}

export type UiTranslate = (key: string, options?: UiTranslateOptions) => string;

type Resources = Record<string, unknown>;

const DEFAULT_LANGUAGES = ['en-US'] as const;

function isRecord(value: unknown): value is Resources {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge(target: Resources, source: Resources): Resources {
  const out: Resources = { ...target };
  for (const [key, value] of Object.entries(source)) out[key] = isRecord(value) && isRecord(out[key]) ? merge(out[key] as Resources, value) : value;
  return out;
}

function resolvePath(bundle: Resources, key: string): unknown {
  if (key in bundle) return bundle[key];
  let node: unknown = bundle;
  for (const part of key.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

function pluralRule(lng: string, count: number): string {
  try {
    return new Intl.PluralRules(lng).select(count);
  } catch {
    return count === 1 ? 'one' : 'other';
  }
}

function interpolate(text: string, options: UiTranslateOptions): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => (options[name] === undefined ? match : String(options[name])));
}

export class UiI18nService {
  private readonly _claims = new Map<string, UiPluginScope>();
  private readonly _bundles = new Map<string, Map<string, Resources>>();
  private readonly _listeners = new Set<() => void>();
  private _version = 0;
  private _offLanguage: (() => void) | undefined;

  constructor(private readonly _adapter?: UiI18nAdapter) {}

  get adapter(): UiI18nAdapter | undefined {
    return this._adapter;
  }

  languages(): readonly string[] {
    const languages = this._adapter?.languages?.();
    return languages && languages.length ? languages : DEFAULT_LANGUAGES;
  }

  /** 语言变化或插件语言包变化时通知（`useT` 订阅它）。 */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    if (this._listeners.size === 1 && this._adapter?.onLanguageChanged) this._offLanguage = this._adapter.onLanguageChanged(() => this._bump());
    return () => {
      this._listeners.delete(listener);
      if (!this._listeners.size) {
        this._offLanguage?.();
        this._offLanguage = undefined;
      }
    };
  };

  version = (): number => this._version;

  /**
   * 为作用域认领命名空间。社区插件不能认领官方命名空间；官方插件写官方命名空间时不认领（不独占）。
   * @returns 是否由该作用域持有（持有的命名空间才进入内核解析表）。
   */
  claim(scope: UiPluginScope | undefined, ns: string, api: string): boolean {
    if (!ns || ns.includes(':')) throw new Error(`${api}: invalid namespace ${JSON.stringify(ns)}`);
    if (!scope) return false;
    const owner = this._claims.get(ns);
    if (owner === scope) return true;
    if (owner?.active) throw new Error(`${api}: namespace "${ns}" belongs to plugin "${owner.id}"`);
    if (this._adapter?.isReservedNamespace?.(ns)) {
      if (scope.origin === 'builtin') return false;
      throw new Error(`${api}: namespace "${ns}" is reserved for official texts`);
    }
    this._claims.set(ns, scope);
    scope.track(() => {
      if (this._claims.get(ns) !== scope) return;
      this._claims.delete(ns);
      if (this._bundles.delete(ns)) this._bump();
    });
    return true;
  }

  /** 把语言包放进内核解析表（仅限已认领的命名空间）。 */
  store(ns: string, lng: string, resources: Resources): void {
    const byLng = this._bundles.get(ns) ?? new Map<string, Resources>();
    byLng.set(lng, merge(byLng.get(lng) ?? {}, resources));
    this._bundles.set(ns, byLng);
    this._bump();
  }

  translator(scope: UiPluginScope): UiTranslate {
    return (key, options = {}) => {
      if (!scope.active) return key;
      let ns = scope.namespace;
      let path = key;
      const sep = key.indexOf(':');
      if (sep > 0 && this._claims.get(key.slice(0, sep)) === scope) {
        ns = key.slice(0, sep);
        path = key.slice(sep + 1);
      }
      const byLng = this._claims.get(ns) === scope ? this._bundles.get(ns) : undefined;
      if (byLng) {
        for (const lng of this.languages()) {
          const bundle = byLng.get(lng);
          if (!bundle) continue;
          const candidates = typeof options.count === 'number' ? [`${path}_${pluralRule(lng, options.count)}`, `${path}_other`, path] : [path];
          for (const candidate of candidates) {
            const value = resolvePath(bundle, candidate);
            if (typeof value === 'string') return interpolate(value, options);
          }
        }
      }
      return typeof options.defaultValue === 'string' ? interpolate(options.defaultValue, options) : key;
    };
  }

  private _bump(): void {
    this._version++;
    for (const fn of [...this._listeners]) fn();
  }
}

/** React hook：语言或语言包变化时重渲染，返回绑定插件命名空间的 `t`（作用域已撤销时返回键名）。 */
export function useScopedTranslator(service: UiI18nService, scope: UiPluginScope | undefined): UiTranslate {
  const version = useSyncExternalStore(service.subscribe, service.version, service.version);
  return useMemo(() => {
    if (!scope) return (key: string) => key;
    const t = service.translator(scope);
    return (key: string, options?: UiTranslateOptions) => t(key, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, scope, version]);
}
