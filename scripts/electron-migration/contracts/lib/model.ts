// 抽取器的中间数据模型（tree-sitter 语法树 → 纯数据；语法树用完即释放）。
import type { Meta } from './attrs.ts';
import type { Sem } from './schema.ts';
import type { CfgVerdict } from './cfg.ts';

/** Rust 类型语法（未解析名字）。 */
export type RType =
  | { k: 'path'; global: boolean; segs: { name: string; args: RType[] }[] }
  | { k: 'ref'; inner: RType }
  | { k: 'tuple'; elems: RType[] }
  | { k: 'array'; elem: RType; len: string }
  | { k: 'slice'; elem: RType }
  | { k: 'unit' }
  | { k: 'never' }
  | { k: 'other'; text: string; why: string };

export interface Attr { text: string; meta: Meta | null; line: number }

export interface Loc { file: string; line: number }

export interface FieldDef { name: string | null; ty: RType; attrs: Attr[]; line: number }

export interface StructDef {
  kind: 'struct';
  name: string;
  generics: string[];
  attrs: Attr[];
  form: 'named' | 'tuple' | 'unit';
  fields: FieldDef[];
  loc: Loc;
  vis: boolean;
  scope: Scope;
  id: string;
}

export interface VariantDef { name: string; attrs: Attr[]; form: 'named' | 'tuple' | 'unit'; fields: FieldDef[]; line: number }

export interface EnumDef {
  kind: 'enum';
  name: string;
  generics: string[];
  attrs: Attr[];
  variants: VariantDef[];
  loc: Loc;
  vis: boolean;
  scope: Scope;
  id: string;
}

export interface AliasDef { kind: 'alias'; name: string; generics: string[]; ty: RType; loc: Loc; vis: boolean; scope: Scope; id: string }

export interface ConstDef { kind: 'const'; name: string; ty: RType | null; value: Expr | null; loc: Loc; vis: boolean; scope: Scope; id: string }

export interface ParamDef { pattern: string; name: string | null; ty: RType; line: number }

export interface LetBinding {
  name: string;
  ty: RType | null;
  value: Expr | null;
  pos: number;
  start: number;
  end: number;
  /** 调用点推出的类型（闭包形参）；优先于 ty。 */
  sem?: Sem;
  /** 赋值/写入产生的伪绑定（不是新声明）：推断不出时可回退到同名声明。 */
  assign?: boolean;
}

export interface EmitSite {
  method: string;
  receiver: Expr;
  args: Expr[];
  line: number;
  pos: number;
}

/** 调用点（供事件包装函数的二次传播）。 */
export interface CallSite { callee: Expr; args: Expr[]; line: number; pos: number }

export interface FnDef {
  kind: 'fn';
  name: string;
  generics: string[];
  attrs: Attr[];
  params: ParamDef[];
  hasSelf: boolean;
  ret: RType | null;
  async: boolean;
  loc: Loc;
  vis: boolean;
  scope: Scope;
  /** impl 方法所在 impl 的 Self 类型。 */
  implSelf: RType | null;
  implTrait: RType | null;
  /** 函数体：let 绑定、emit 调用、尾表达式与 return 表达式。 */
  lets: LetBinding[];
  emits: EmitSite[];
  calls: CallSite[];
  tails: Expr[];
  bodyText: string;
  bodyScope: Scope | null;
  id: string;
  cfg: CfgVerdict | null;
}

export interface ModDef { kind: 'mod'; name: string; scope: Scope; vis: boolean; id: string; loc: Loc }

export interface TraitDef { kind: 'trait'; name: string; vis: boolean; scope: Scope; id: string; loc: Loc }

export type Def = StructDef | EnumDef | AliasDef | ConstDef | FnDef | ModDef | TraitDef;

export interface UseEntry { path: string[]; alias: string | null; glob: boolean; vis: boolean; line: number }

export interface ImplDef { trait: RType | null; selfTy: RType; generics: string[]; scope: Scope; methods: FnDef[]; loc: Loc }

export interface Scope {
  id: string;
  crate: string;
  /** 模块路径（不含 crate 名）；块作用域沿用所在模块的路径。 */
  path: string[];
  file: string;
  parent: Scope | null;
  /** 块作用域（函数体）时为所在作用域；名字查找先查自身再查 outer。 */
  outer: Scope | null;
  defs: Map<string, Def[]>;
  uses: UseEntry[];
  impls: ImplDef[];
}

/** 表达式摘要（只保留类型推断与事件名推断需要的形态）。 */
export type Expr =
  | { k: 'str'; v: string }
  | { k: 'format'; template: string; args: string[] }
  | { k: 'path'; segs: string[]; text: string }
  | { k: 'ref'; inner: Expr }
  | { k: 'struct'; ty: RType; fields: { name: string; value: Expr | null }[] }
  | { k: 'call'; callee: Expr; args: Expr[]; turbofish: RType[] }
  | { k: 'method'; recv: Expr; name: string; args: Expr[]; turbofish: RType[] }
  | { k: 'field'; recv: Expr; name: string }
  | { k: 'macro'; name: string; text: string; toks?: unknown }
  | { k: 'json'; value: JsonLit }
  | { k: 'unit' }
  | { k: 'lit'; t: 'int' | 'float' | 'bool' | 'char'; text: string }
  | { k: 'try'; inner: Expr }
  | { k: 'cast'; ty: RType }
  | { k: 'array'; elems: Expr[] }
  | { k: 'tuple'; elems: Expr[] }
  | { k: 'binary'; op: string; left: Expr; right: Expr }
  | { k: 'index'; recv: Expr }
  | { k: 'branches'; values: Expr[] }
  | { k: 'project'; value: Expr; variant?: string[]; index: number }
  | { k: 'vec'; elems: Expr[] }
  | { k: 'element'; value: Expr }
  | { k: 'never' }
  | { k: 'located'; inner: Expr; pos: number }
  | { k: 'range'; start: Expr; end: Expr }
  | { k: 'closure'; params: string[]; body: Expr }
  | { k: 'other'; text: string; line: number };

/** `json!` 宏字面量的结构。 */
export type JsonLit =
  | { k: 'obj'; entries: { key: string | null; keyText: string; value: JsonLit }[] }
  | { k: 'arr'; elems: JsonLit[] }
  | { k: 'null' }
  | { k: 'bool' }
  | { k: 'num'; text: string }
  | { k: 'str' }
  | { k: 'expr'; text: string; expr?: Expr };
