/**
 * OpenUI-Lang 行级生成式 UI DSL 解析器
 *
 * 支持语法：
 * - 按行或跨行声明：`name = Component(arg1, arg2, ...)`
 * - 入口节点：优先使用 `root = ...`，否则取首条组件声明（兼容直接写 `Stack([...])`）
 * - 参数字面量：字符串 `"..."` / `'...'`、数字、布尔值、`null`、数组 `[...]`、
 *   JSON/JS 风格对象 `{title: "x", status: "done"}`、内联组件调用 `Series("A", [1, 2])`、
 *   以及跨行标识符引用 `item1`。
 * - 流式容错：未闭合的字符串、括号、数组与尚未流式到达的标识符引用均可安全降级。
 */

export type OpenUIValue =
  | string
  | number
  | boolean
  | null
  | OpenUIValue[]
  | { [key: string]: OpenUIValue }
  | OpenUIComponentNode
  | OpenUIRefNode;

export interface OpenUIComponentNode {
  kind: 'component';
  name: string;
  args: OpenUIValue[];
  /** 具名参数：`Card(title="x", children=[...])` / `Stat(label: "QPS", value: 12)` */
  namedArgs?: Record<string, OpenUIValue>;
  id?: string;
}

export interface OpenUIRefNode {
  kind: 'ref';
  name: string;
}

export interface OpenUIProgram {
  root: OpenUIComponentNode | null;
  statements: Map<string, OpenUIValue>;
  errors: string[];
  hasInteractiveControls: boolean;
  hasExplicitButton: boolean;
}

const INTERACTIVE_COMPONENTS = new Set([
  'Choice',
  'Input',
  'DateInput',
  'Slider',
  'Button',
]);

export function isOpenUIComponentNode(val: unknown): val is OpenUIComponentNode {
  return Boolean(val && typeof val === 'object' && (val as OpenUIComponentNode).kind === 'component');
}

export function isOpenUIRefNode(val: unknown): val is OpenUIRefNode {
  return Boolean(val && typeof val === 'object' && (val as OpenUIRefNode).kind === 'ref');
}

/**
 * 将顶层源码按语句切分（仅在括号深度为 0 且不在字符串中时按换行或分号切分）
 */
function splitStatements(source: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < source.length) {
        current += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    // 处理行注释 // 或 #
    if ((ch === '/' && source[i + 1] === '/') || (ch === '#' && (i === 0 || /[\s;([{,]/.test(source[i - 1])))) {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      current += ch;
      i += 1;
      continue;
    }

    if ((ch === '\n' || ch === ';') && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        result.push(trimmed);
      }
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail) {
    result.push(tail);
  }
  return result;
}

class ExpressionParser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  public isAtEnd(): boolean {
    this.skipWhitespace();
    return this.pos >= this.text.length;
  }

  public skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        this.pos += 1;
      } else if (ch === '/' && this.text[this.pos + 1] === '/') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') {
          this.pos += 1;
        }
      } else {
        break;
      }
    }
  }

  public parseValue(): OpenUIValue {
    this.skipWhitespace();
    if (this.pos >= this.text.length) {
      return null;
    }

    const ch = this.text[this.pos];

    if (ch === '"' || ch === "'") {
      return this.parseString();
    }

    if (ch === '[') {
      return this.parseArray();
    }

    if (ch === '{') {
      return this.parseObject();
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const num = this.tryParseNumber();
      if (num !== null) return num;
    }

    // 标识符、布尔字面量或组件调用 Component(...)
    const ident = this.parseIdentifier();
    if (!ident) {
      // 跳过意外字符继续
      this.pos += 1;
      return null;
    }

    this.skipWhitespace();
    if (this.pos < this.text.length && this.text[this.pos] === '(') {
      const { args, namedArgs } = this.parseArgList();
      return {
        kind: 'component',
        name: ident,
        args,
        ...(namedArgs ? { namedArgs } : {}),
      };
    }

    if (ident === 'true') return true;
    if (ident === 'false') return false;
    if (ident === 'null' || ident === 'undefined') return null;

    return {
      kind: 'ref',
      name: ident,
    };
  }

  private parseString(): string {
    const quote = this.text[this.pos];
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '\\') {
        this.pos += 1;
        if (this.pos >= this.text.length) break;
        const esc = this.text[this.pos];
        switch (esc) {
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case '"':
            out += '"';
            break;
          case "'":
            out += "'";
            break;
          case '\\':
            out += '\\';
            break;
          default:
            out += esc;
            break;
        }
        this.pos += 1;
        continue;
      }
      if (ch === quote) {
        this.pos += 1;
        break;
      }
      out += ch;
      this.pos += 1;
    }
    return out;
  }

  private tryParseNumber(): number | null {
    const slice = this.text.slice(this.pos);
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(slice);
    if (!match) return null;
    const raw = match[0];
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    this.pos += raw.length;
    return num;
  }

  private parseIdentifier(): string {
    const start = this.pos;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (/[a-zA-Z0-9_$-]/.test(ch)) {
        this.pos += 1;
      } else {
        break;
      }
    }
    return this.text.slice(start, this.pos);
  }

  private parseArray(): OpenUIValue[] {
    // 跳过 '['
    this.pos += 1;
    const items: OpenUIValue[] = [];
    while (this.pos < this.text.length) {
      this.skipWhitespace();
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === ']') {
        this.pos += 1;
        break;
      }
      if (this.text[this.pos] === ',') {
        this.pos += 1;
        continue;
      }
      const before = this.pos;
      const item = this.parseValue();
      if (item !== null || this.pos > before) {
        items.push(item);
      }
      this.skipWhitespace();
      if (this.pos < this.text.length && this.text[this.pos] === ',') {
        this.pos += 1;
      }
    }
    return items;
  }

  private parseObject(): { [key: string]: OpenUIValue } {
    // 跳过 '{'
    this.pos += 1;
    const obj: { [key: string]: OpenUIValue } = {};
    while (this.pos < this.text.length) {
      this.skipWhitespace();
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === '}') {
        this.pos += 1;
        break;
      }
      if (this.text[this.pos] === ',') {
        this.pos += 1;
        continue;
      }

      let key = '';
      const ch = this.text[this.pos];
      if (ch === '"' || ch === "'") {
        key = this.parseString();
      } else {
        key = this.parseIdentifier();
      }

      if (!key) {
        this.pos += 1;
        continue;
      }

      this.skipWhitespace();
      if (this.pos < this.text.length && this.text[this.pos] === ':') {
        this.pos += 1;
        const val = this.parseValue();
        obj[key] = val;
      } else {
        // 简写属性 { title } -> { title: ref(title) }
        obj[key] = { kind: 'ref', name: key };
      }

      this.skipWhitespace();
      if (this.pos < this.text.length && this.text[this.pos] === ',') {
        this.pos += 1;
      }
    }
    return obj;
  }

  /**
   * 具名参数键探测：`ident = value` 或 `ident: value`。
   * 命中时消费 `ident` 与其后的 `=`/`:`，返回键名；未命中回退到原位置。
   */
  private tryParseNamedArgKey(): string | null {
    const start = this.pos;
    const first = this.text[this.pos];
    if (!first || !/[a-zA-Z_$]/.test(first)) return null;

    const ident = this.parseIdentifier();
    if (!ident) {
      this.pos = start;
      return null;
    }
    this.skipWhitespace();
    const next = this.text[this.pos];
    if (next === '=' || next === ':') {
      this.pos += 1;
      return ident;
    }
    this.pos = start;
    return null;
  }

  private parseArgList(): {
    args: OpenUIValue[];
    namedArgs: Record<string, OpenUIValue> | null;
  } {
    // 跳过 '('
    this.pos += 1;
    const args: OpenUIValue[] = [];
    let namedArgs: Record<string, OpenUIValue> | null = null;
    while (this.pos < this.text.length) {
      this.skipWhitespace();
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === ')') {
        this.pos += 1;
        break;
      }
      if (this.text[this.pos] === ',') {
        this.pos += 1;
        continue;
      }

      const namedKey = this.tryParseNamedArgKey();
      if (namedKey) {
        const before = this.pos;
        const value = this.parseValue();
        if (value !== null || this.pos > before) {
          args.push(value);
          namedArgs = namedArgs ?? {};
          namedArgs[namedKey] = value;
        }
        this.skipWhitespace();
        if (this.pos < this.text.length && this.text[this.pos] === ',') {
          this.pos += 1;
        }
        continue;
      }

      const before = this.pos;
      const arg = this.parseValue();
      if (arg !== null || this.pos > before) {
        args.push(arg);
      }
      this.skipWhitespace();
      if (this.pos < this.text.length && this.text[this.pos] === ',') {
        this.pos += 1;
      }
    }
    return { args, namedArgs };
  }
}

/**
 * 解析引用并展开 AST（带环检测）
 */
export function resolveOpenUIValue(
  value: OpenUIValue,
  statements: Map<string, OpenUIValue>,
  visited: Set<string> = new Set(),
): OpenUIValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => resolveOpenUIValue(item, statements, visited))
      .filter((item) => item !== undefined);
  }

  if (isOpenUIRefNode(value)) {
    if (visited.has(value.name)) {
      return null;
    }
    if (!statements.has(value.name)) {
      return null;
    }
    const target = statements.get(value.name)!;
    const nextVisited = new Set(visited);
    nextVisited.add(value.name);
    const resolved = resolveOpenUIValue(target, statements, nextVisited);
    if (isOpenUIComponentNode(resolved) && !resolved.id) {
      return { ...resolved, id: value.name };
    }
    return resolved;
  }

  if (isOpenUIComponentNode(value)) {
    const resolvedArgs = value.args.map((arg) => resolveOpenUIValue(arg, statements, visited));
    if (!value.namedArgs) {
      return {
        ...value,
        args: resolvedArgs,
      };
    }
    const namedArgs: Record<string, OpenUIValue> = {};
    for (const [key, arg] of Object.entries(value.namedArgs)) {
      namedArgs[key] = resolveOpenUIValue(arg, statements, visited);
    }
    return {
      ...value,
      args: resolvedArgs,
      namedArgs,
    };
  }

  const out: { [key: string]: OpenUIValue } = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = resolveOpenUIValue(v, statements, visited);
  }
  return out;
}

function scanInteractiveFlags(
  node: OpenUIValue,
  flags: { hasInteractiveControls: boolean; hasExplicitButton: boolean },
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => scanInteractiveFlags(child, flags));
    return;
  }
  if (isOpenUIComponentNode(node)) {
    if (INTERACTIVE_COMPONENTS.has(node.name)) {
      flags.hasInteractiveControls = true;
    }
    if (node.name === 'Button') {
      flags.hasExplicitButton = true;
    }
    node.args.forEach((arg) => scanInteractiveFlags(arg, flags));
    if (node.namedArgs) {
      Object.values(node.namedArgs).forEach((arg) => scanInteractiveFlags(arg, flags));
    }
    return;
  }
  if (!isOpenUIRefNode(node)) {
    Object.values(node).forEach((val) => scanInteractiveFlags(val, flags));
  }
}

/**
 * 解析完整或流式中的 `openui-lang` 源码
 */
export function parseOpenUILang(source: string): OpenUIProgram {
  const statements = new Map<string, OpenUIValue>();
  const errors: string[] = [];
  let firstComponentKey: string | null = null;

  const trimmedSource = (source ?? '').trim();
  if (!trimmedSource) {
    return {
      root: null,
      statements,
      errors,
      hasInteractiveControls: false,
      hasExplicitButton: false,
    };
  }

  const rawStatements = splitStatements(trimmedSource);

  rawStatements.forEach((stmt, index) => {
    // 匹配 `identifier = expr`（注意避免把 `Component(a = 1)` 误判为顶层赋值）
    const assignMatch = /^([a-zA-Z_$][a-zA-Z0-9_$-]*)\s*=\s*([\s\S]+)$/.exec(stmt);
    if (assignMatch) {
      const varName = assignMatch[1];
      const rhs = assignMatch[2].trim();
      const parser = new ExpressionParser(rhs);
      const val = parser.parseValue();
      if (isOpenUIComponentNode(val)) {
        val.id = varName;
        if (!firstComponentKey) {
          firstComponentKey = varName;
        }
      }
      statements.set(varName, val);
    } else {
      const parser = new ExpressionParser(stmt);
      const val = parser.parseValue();
      if (isOpenUIComponentNode(val)) {
        const syntheticKey = index === 0 ? 'root' : `__anon_${index}`;
        val.id = syntheticKey;
        if (!firstComponentKey) {
          firstComponentKey = syntheticKey;
        }
        statements.set(syntheticKey, val);
      } else if (stmt.trim().length > 0) {
        errors.push(`Unrecognized statement at line ${index + 1}: ${stmt.slice(0, 60)}`);
      }
    }
  });

  const entryKey = statements.has('root') ? 'root' : firstComponentKey;
  let rootNode: OpenUIComponentNode | null = null;

  if (entryKey && statements.has(entryKey)) {
    const resolved = resolveOpenUIValue(
      { kind: 'ref', name: entryKey },
      statements,
    );
    if (isOpenUIComponentNode(resolved)) {
      rootNode = resolved;
    }
  }

  const flags = { hasInteractiveControls: false, hasExplicitButton: false };
  if (rootNode) {
    scanInteractiveFlags(rootNode, flags);
  }

  return {
    root: rootNode,
    statements,
    errors,
    hasInteractiveControls: flags.hasInteractiveControls,
    hasExplicitButton: flags.hasExplicitButton,
  };
}
