/**
 * 契约集合（可移植）：按命令名查找 `contracts/ipc/*.json`（格式见 contract.ts）中的契约，
 * 并按 Tauri 2.11.5 的参数语义校验 invoke 载荷。从目录读取契约的 `ContractSet.fromDirectory`
 * 在桌面入口 contracts.ts。
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { CommandContract, EventContract, JsonSchema, LaneContract } from './contract.ts';
import { invalidArgs, missingRequiredKey, rawPayloadForKey } from './errors.ts';
import { isJsonNumberAtom, serdeCheck, normalizeUnitEnums, unexpectedOf, type SchemaRefResolver } from './serde.ts';
import { decodeContractValue, exactJsonType, exactNumberRules, exactSchema } from './inbound-json.ts';

/** 契约 schema 的虚拟 URI 根；`_shared.json` 与各 lane 文件挂在同一目录下，相对 `$ref` 自然解析。 */
const CONTRACT_BASE = 'https://contracts.deep-student.invalid/ipc/';

export class ContractError extends Error {
  override name = 'ContractError';
}

/** 参数校验结果：成功时给出交给处理函数的参数对象；失败时给出前端 reject 的 Tauri 字符串。 */
export type ArgsCheck = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export interface ContractSource {
  /** 文件名（如 `L14-qbank.json`），只用于报错与 `$ref` 解析。 */
  file: string;
  contract: LaneContract;
}

function isBytesPayload(payload: unknown): boolean {
  return payload instanceof Uint8Array || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload);
}

/** serde_json `Value::get(&str)`：只有对象才有键（数组、null 等一律视为键不存在）。 */
function getKey(payload: unknown, key: string): { present: boolean; value: unknown } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || isJsonNumberAtom(payload)) return { present: false, value: undefined };
  if (!Object.hasOwn(payload, key)) return { present: false, value: undefined };
  const value = (payload as Record<string, unknown>)[key];
  // JSON 序列化会丢掉值为 undefined 的键，Rust 侧看到的就是键缺失。
  if (value === undefined) return { present: false, value: undefined };
  return { present: true, value };
}

function collectXKeywords(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectXKeywords(item, out);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('x-')) out.add(key);
    collectXKeywords(value, out);
  }
}

function describeAjvErrors(errors: ErrorObject[] | null | undefined, value: unknown): string {
  const first = errors?.[0];
  if (!first) return `invalid value: ${unexpectedOf(value)}`;
  const where = first.instancePath ? ` at ${first.instancePath}` : '';
  return `${first.message ?? 'invalid value'}${where}`;
}

// Validate consumed file/schema structure before lookup; schema compilation and external
// $ref resolution still use the existing lazy strict Ajv instance. Use the standard meta
// schema rather than maintaining a second handwritten JSON Schema grammar.
const schemaValue = { $ref: 'https://json-schema.org/draft/2020-12/schema' };
const validateContractFile = new Ajv2020().compile<LaneContract>({
  type: 'object', required: ['lane', 'generator', 'commands', 'events', '$defs'],
  properties: {
    lane: { type: 'string' }, generator: { type: 'string' },
    $defs: { type: 'object', additionalProperties: schemaValue },
    commands: { type: 'array', items: {
      type: 'object', required: ['name', 'args', 'result'],
      properties: {
        name: { type: 'string' }, lane: { type: 'string' }, async: { type: 'boolean' },
        renameAll: { enum: ['snake_case', 'camelCase'] },
        result: schemaValue, error: schemaValue,
        args: { type: 'array', items: {
          type: 'object', required: ['key', 'optional', 'schema'],
          properties: { key: { type: 'string' }, rustName: { type: 'string' }, optional: { type: 'boolean' }, schema: schemaValue },
        } },
        injected: { type: 'array', items: { type: 'object', required: ['kind'], properties: { kind: { type: 'string' } } } },
      },
    } },
    events: { type: 'array', items: { type: 'object', required: ['name', 'payload'],
      properties: { name: { type: 'string' }, dynamic: { type: 'boolean' }, payload: schemaValue } } },
  },
});

/**
 * 解析并校验一个契约文件的文本。`file` 是文件名（如 `L14-qbank.json`），`label` 是报错中显示的位置
 * （桌面为完整路径）。
 */
export function parseContractSource(file: string, text: string, label: string = file): ContractSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ContractError(`contract ${label} is not valid JSON: ${(error as Error).message}`);
  }
  if (!validateContractFile(parsed)) {
    throw new ContractError(`invalid contract ${label}: ${describeAjvErrors(validateContractFile.errors, parsed)}`);
  }
  return { file, contract: parsed };
}

/** 已加载契约的集合。实例不可变；`with()` 返回叠加了额外契约的新集合。 */
export class ContractSet {
  readonly commands: ReadonlyMap<string, CommandContract & { file: string }>;
  readonly events: ReadonlyMap<string, EventContract>;
  private readonly sources: readonly ContractSource[];
  private readonly docs = new Map<string, Record<string, unknown>>();
  private readonly ajv: Ajv2020;
  private readonly exactAjv: Ajv2020;
  private readonly exactBranches = new Map<JsonSchema | boolean, Map<string, ValidateFunction>>();
  private branchId = 0;
  private readonly argValidators = new Map<string, ValidateFunction>();
  private readonly resolver: SchemaRefResolver;

  constructor(sources: readonly ContractSource[]) {
    this.sources = sources;
    const commands = new Map<string, CommandContract & { file: string }>();
    const events = new Map<string, EventContract>();
    for (const { file, contract } of sources) {
      if (file !== '_shared.json') {
        if (!contract || !Array.isArray(contract.commands)) throw new ContractError(`contract ${file}: missing "commands" array`);
        for (const command of contract.commands) {
          const existing = commands.get(command.name);
          if (existing && existing.file !== file) {
            throw new ContractError(`command "${command.name}" is defined in both ${existing.file} and ${file}`);
          }
          commands.set(command.name, { ...command, file });
        }
        for (const event of contract.events ?? []) events.set(event.name, event);
      }
      this.docs.set(CONTRACT_BASE + file, { $defs: contract.$defs ?? {} });
    }
    this.commands = commands;
    this.events = events;

    this.ajv = new Ajv2020({
      strict: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allowUnionTypes: true,
      allErrors: false,
      validateFormats: false,
      validateSchema: true,
    });
    this.exactAjv = new Ajv2020({ strict: true, strictTypes: false, strictTuples: false,
      strictRequired: false, allowUnionTypes: true, allErrors: false, validateFormats: false });
    this.exactAjv.addKeyword({ keyword: 'x-host-json-type', validate: exactJsonType, errors: false });
    this.exactAjv.addKeyword({ keyword: 'x-host-number-rules', validate: exactNumberRules, errors: false });
    const keywords = new Set<string>(['x-rust', 'x-int', 'x-float', 'x-option', 'x-unresolved']);
    collectXKeywords(sources.map((s) => s.contract), keywords);
    for (const keyword of keywords) {
      this.ajv.addKeyword({ keyword });
      this.exactAjv.addKeyword({ keyword });
    }
    for (const [id, doc] of this.docs) {
      this.ajv.addSchema({ $id: id, ...doc });
      this.exactAjv.addSchema(exactSchema({ $id: id, ...doc }));
    }

    this.resolver = {
      resolve: (ref, base) => {
        const url = new URL(ref, base);
        const docId = url.href.slice(0, url.href.length - url.hash.length);
        const doc = this.docs.get(docId);
        if (!doc) return undefined;
        const pointer = decodeURIComponent(url.hash.replace(/^#/, ''));
        let node: unknown = doc;
        for (const part of pointer.split('/').slice(1)) {
          const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
          if (typeof node !== 'object' || node === null) return undefined;
          node = (node as Record<string, unknown>)[key];
        }
        if (typeof node !== 'boolean' && (typeof node !== 'object' || node === null)) return undefined;
        return { schema: node as JsonSchema | boolean, base: docId };
      },
    };
  }

  /** 空集合。 */
  static empty(): ContractSet {
    return new ContractSet([]);
  }

  /** 叠加额外契约（同名命令以 `extra` 为准）。 */
  with(extra: readonly ContractSource[]): ContractSet {
    const overridden = new Set(extra.flatMap((s) => (s.contract.commands ?? []).map((c) => c.name)));
    const extraFiles = new Set(extra.map((s) => s.file));
    const base = this.sources
      .filter((s) => !extraFiles.has(s.file))
      .map((s) => ({ file: s.file, contract: { ...s.contract, commands: (s.contract.commands ?? []).filter((c) => !overridden.has(c.name)) } }));
    return new ContractSet([...base, ...extra]);
  }

  get(name: string): (CommandContract & { file: string }) | undefined {
    return this.commands.get(name);
  }

  /** 命令所在契约文件的基址：其 schema 里的 `$ref` 相对它解析（{@link resolveRef}）。 */
  schemaBase(contract: CommandContract & { file: string }): string {
    return `${CONTRACT_BASE}${contract.file}`;
  }

  /** 解析 `$ref`（`#/$defs/X` 或 `_shared.json#/$defs/X`）；返回的 `base` 是目标所在文件，嵌套引用相对它继续解析。 */
  resolveRef(ref: string, base: string): { schema: JsonSchema | boolean; base: string } | undefined {
    return this.resolver.resolve(ref, base);
  }

  private compileArg(contract: CommandContract & { file: string }, index: number, exact = false): ValidateFunction {
    const cacheKey = `${contract.name}\u0000${index}${exact ? '\u0000exact' : ''}`;
    let validate = this.argValidators.get(cacheKey);
    if (!validate) {
      const arg = contract.args[index]!;
      const laneDefs = (this.docs.get(CONTRACT_BASE + contract.file)?.$defs ?? {}) as Record<string, unknown>;
      const schema = typeof arg.schema === 'boolean' ? arg.schema : { ...arg.schema };
      const id = `${CONTRACT_BASE}${contract.file.replace(/\.json$/, '')}.${encodeURIComponent(contract.name)}.${index}.json`;
      const wrapped = typeof schema === 'boolean'
        ? { $id: id, $defs: laneDefs, allOf: [schema] }
        : { ...schema, $id: id, $defs: { ...laneDefs, ...((schema.$defs as Record<string, unknown>) ?? {}) } };
      try {
        validate = exact ? this.exactAjv.compile(exactSchema(wrapped)) : this.ajv.compile(wrapped);
      } catch (error) {
        throw new ContractError(`contract ${contract.file}: schema of arg "${arg.key}" of command "${contract.name}" does not compile: ${(error as Error).message}`);
      }
      this.argValidators.set(cacheKey, validate);
    }
    return validate;
  }

  private compileSchema(contract: CommandContract & { file: string }, which: 'result' | 'error'): ValidateFunction | undefined {
    const cacheKey = `${contract.name}\u0000${which}`;
    let validate = this.argValidators.get(cacheKey);
    if (!validate) {
      const schema = contract[which];
      if (schema === undefined) return undefined;
      const laneDefs = (this.docs.get(CONTRACT_BASE + contract.file)?.$defs ?? {}) as Record<string, unknown>;
      const id = `${CONTRACT_BASE}${contract.file.replace(/\.json$/, '')}.${encodeURIComponent(contract.name)}.${which}.json`;
      const wrapped = typeof schema === 'boolean'
        ? { $id: id, $defs: laneDefs, allOf: [schema] }
        : { ...schema, $id: id, $defs: { ...laneDefs, ...((schema.$defs as Record<string, unknown>) ?? {}) } };
      try {
        validate = this.ajv.compile(wrapped);
      } catch (error) {
        throw new ContractError(`contract ${contract.file}: ${which} schema of command "${contract.name}" does not compile: ${(error as Error).message}`);
      }
      this.argValidators.set(cacheKey, validate);
    }
    return validate;
  }

  /**
   * 按 Tauri 语义校验参数（tauri-2.11.5/src/ipc/command.rs:62-149 与 tauri-macros-2.6.3/src/command/wrapper.rs:427-528）：
   * - 按 Rust 签名顺序逐个参数反序列化，第一个失败的参数决定错误；
   * - 键查找用 `Value::get`，多余键忽略；
   * - 键缺失：`Option<T>` → `None`，否则 `missing required key`；
   * - 键存在且为 `null`：`Option<T>` → `None`（`deserialize_option`），否则按类型报错；
   * - 载荷为字节（`InvokeBody::Raw`）：任何具名参数都报 bytes payload 错误。
   *
   * 交给处理函数的对象只含契约声明的键；`Option` 参数缺失或为 null 时统一为 `null`。
   */
  checkArgs(contract: CommandContract & { file: string }, payload: unknown, exactJson = false): ArgsCheck {
    const args: Record<string, unknown> = {};
    const bytes = isBytesPayload(payload);
    for (let index = 0; index < contract.args.length; index++) {
      const arg = contract.args[index]!;
      if (bytes) return { ok: false, error: invalidArgs(contract.name, arg.key, rawPayloadForKey(contract.name, arg.key)) };
      const { present, value } = getKey(payload, arg.key);
      if (!present || value === null) {
        if (arg.optional) {
          args[arg.key] = null;
          continue;
        }
        if (!present) return { ok: false, error: invalidArgs(contract.name, arg.key, missingRequiredKey(contract.name, arg.key)) };
      }
      const validate = this.compileArg(contract, index, exactJson);
      const base = `${CONTRACT_BASE}${contract.file}`;
      const normalized = normalizeUnitEnums(arg.schema, value, base, this.resolver);
      const serde = serdeCheck(arg.schema, normalized, base, this.resolver);
      if (serde.ok === false) return { ok: false, error: invalidArgs(contract.name, arg.key, serde.detail) };
      const valid = validate(normalized);
      if (!valid) return { ok: false, error: invalidArgs(contract.name, arg.key, describeAjvErrors(validate.errors, value)) };
      args[arg.key] = exactJson ? decodeContractValue(arg.schema, normalized, base, this.resolver,
        (schema, value, base) => this.validateExactBranch(schema, value, base)) : normalized;
    }
    return { ok: true, args };
  }

  private validateExactBranch(schema: JsonSchema | boolean, value: unknown, base: string): boolean {
    let byBase = this.exactBranches.get(schema);
    if (!byBase) this.exactBranches.set(schema, byBase = new Map());
    let validate = byBase.get(base);
    if (!validate) {
      const id = `${base}.decode-${++this.branchId}.json`;
      try {
        validate = this.exactAjv.compile(exactSchema({ $id: id, $defs: this.docs.get(base)?.$defs ?? {}, allOf: [schema] }));
      } catch (error) {
        throw new ContractError(`contract ${base}: argument branch does not compile: ${(error as Error).message}`);
      }
      byBase.set(base, validate);
    }
    return validate(value);
  }

  /**
   * 编译全部命令的参数 / 结果 / 错误 schema，返回编译失败的描述（空数组 = 全部可用）。
   * 运行时按需编译；CI 可以用它提前发现无法编译的契约。
   */
  compileAll(): string[] {
    const problems: string[] = [];
    for (const contract of this.commands.values()) {
      const steps: (() => unknown)[] = [
        ...contract.args.map((_, index) => () => this.compileArg(contract, index)),
        () => this.compileSchema(contract, 'result'),
        () => this.compileSchema(contract, 'error'),
      ];
      for (const step of steps) {
        try {
          step();
        } catch (error) {
          if (!(error instanceof ContractError)) throw error;
          problems.push(error.message);
        }
      }
    }
    return problems;
  }

  /** 校验成功值；返回 `null` 表示通过，否则为问题描述。 */
  checkResult(contract: CommandContract & { file: string }, value: unknown): string | null {
    const validate = this.compileSchema(contract, 'result');
    if (!validate || validate(value)) return null;
    return describeAjvErrors(validate.errors, value);
  }

  /** 校验 `CommandError.value`；契约没有 `error` schema（命令不返回 Result）时返回问题描述。 */
  checkError(contract: CommandContract & { file: string }, value: unknown): string | null {
    if (contract.error === undefined) return `command "${contract.name}" does not return Result in Rust, but the handler threw CommandError`;
    const validate = this.compileSchema(contract, 'error');
    if (!validate || validate(value)) return null;
    return describeAjvErrors(validate.errors, value);
  }
}
