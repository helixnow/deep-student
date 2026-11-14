// Host 内核自有的命令与事件（不来自 Rust，Rust 侧没有对应物）：手写在 scripts/electron-migration/contracts/host-native.json，
// 由抽取器原样校验后写进对应 lane 契约的 `hostNative` 段。放在独立段而不是 `commands`/`events`，
// 因为 kernel 对 `commands` 做参数校验与注册约束（ctx.commands.register 要求契约存在），内核命令走 _registerKernel。
import type { JsonSchema } from '../../../../host/kernel/contract.ts';
import type { SourceTree } from './source.ts';

export const HOST_NATIVE_JSON = 'scripts/electron-migration/contracts/host-native.json';

export interface HostLocation { file: string; const: string; handler?: string }
export interface HostNativeCommand {
  name: string;
  host: HostLocation;
  args: { key: string; optional: boolean; schema: JsonSchema }[];
  result: JsonSchema;
  error?: JsonSchema;
  description?: string;
}
export interface HostNativeEvent { name: string; host: HostLocation; payload: JsonSchema; description?: string }
export type HostDefExtensions = Record<string, Record<string, Record<string, JsonSchema>>>;
export interface HostNative {
  lane: string;
  commands: HostNativeCommand[];
  events: HostNativeEvent[];
  defExtensions?: HostDefExtensions;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function location(v: unknown, where: string): HostLocation {
  if (!isObj(v) || typeof v.file !== 'string' || typeof v.const !== 'string') throw new Error(`${HOST_NATIVE_JSON}: ${where}.host must be { file, const }`);
  return { file: v.file, const: v.const, ...(typeof v.handler === 'string' ? { handler: v.handler } : {}) };
}

/** 读取并校验 host-native.json；文件不存在时返回 null。 */
export function loadHostNative(src: SourceTree): HostNative | null {
  if (!src.exists(HOST_NATIVE_JSON)) return null;
  const doc: unknown = JSON.parse(src.read(HOST_NATIVE_JSON));
  if (!isObj(doc) || typeof doc.lane !== 'string' || !Array.isArray(doc.commands) || !Array.isArray(doc.events)) {
    throw new Error(`${HOST_NATIVE_JSON}: expected { lane, commands: [], events: [] }`);
  }
  const names = new Set<string>();
  const unique = (name: unknown, where: string): string => {
    if (typeof name !== 'string' || !name) throw new Error(`${HOST_NATIVE_JSON}: ${where}.name must be a non-empty string`);
    if (names.has(name)) throw new Error(`${HOST_NATIVE_JSON}: duplicate name ${name}`);
    names.add(name);
    return name;
  };
  const commands = doc.commands.map((c, i): HostNativeCommand => {
    const where = `commands[${i}]`;
    if (!isObj(c) || !Array.isArray(c.args) || !isObj(c.result)) throw new Error(`${HOST_NATIVE_JSON}: ${where} needs args[] and result`);
    const args = c.args.map((a, j) => {
      if (!isObj(a) || typeof a.key !== 'string' || typeof a.optional !== 'boolean' || !isObj(a.schema)) throw new Error(`${HOST_NATIVE_JSON}: ${where}.args[${j}] must be { key, optional, schema }`);
      return { key: a.key, optional: a.optional, schema: a.schema as JsonSchema };
    });
    return {
      name: unique(c.name, where), host: location(c.host, where), args, result: c.result as JsonSchema,
      ...(isObj(c.error) ? { error: c.error as JsonSchema } : {}),
      ...(typeof c.description === 'string' ? { description: c.description } : {}),
    };
  });
  const events = doc.events.map((e, i): HostNativeEvent => {
    const where = `events[${i}]`;
    if (!isObj(e) || !isObj(e.payload)) throw new Error(`${HOST_NATIVE_JSON}: ${where} needs payload`);
    return { name: unique(e.name, where), host: location(e.host, where), payload: e.payload as JsonSchema, ...(typeof e.description === 'string' ? { description: e.description } : {}) };
  });
  let defExtensions: HostDefExtensions | undefined;
  if (doc.defExtensions !== undefined) {
    if (!isObj(doc.defExtensions)) throw new Error(`${HOST_NATIVE_JSON}: defExtensions must be an object`);
    defExtensions = {};
    for (const [laneKey, defsObj] of Object.entries(doc.defExtensions)) {
      if (!isObj(defsObj)) throw new Error(`${HOST_NATIVE_JSON}: defExtensions.${laneKey} must be an object`);
      const laneMap: Record<string, Record<string, JsonSchema>> = {};
      for (const [defName, propsObj] of Object.entries(defsObj)) {
        if (!isObj(propsObj)) throw new Error(`${HOST_NATIVE_JSON}: defExtensions.${laneKey}.${defName} must be an object`);
        const propMap: Record<string, JsonSchema> = {};
        for (const [propKey, propSchema] of Object.entries(propsObj)) {
          if (!isObj(propSchema)) throw new Error(`${HOST_NATIVE_JSON}: defExtensions.${laneKey}.${defName}.${propKey} must be a schema object`);
          propMap[propKey] = propSchema as JsonSchema;
        }
        laneMap[defName] = propMap;
      }
      defExtensions[laneKey] = laneMap;
    }
  }
  return { lane: doc.lane, commands, events, ...(defExtensions ? { defExtensions } : {}) };
}
