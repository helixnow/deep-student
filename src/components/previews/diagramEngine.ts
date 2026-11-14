/**
 * 声明式 diagram 几何与函数绘图引擎
 *
 * 包含三部分核心能力：
 * 1. 零动态代码执行的安全数学表达式编译器 compileDiagramExpr
 * 2. 严格 Schema 校验器 validateDiagram 与流式增量提取器 peekStreamingDiagram
 * 3. 确定性拓扑分层与函数采样 SVG 渲染器 renderDiagramSvg / renderDiagram
 */

// ============================================================================
// 1. 安全数学表达式编译器（手写词法 + 优先级爬升解析，无动态代码求值）
// ============================================================================

const FUNCS: Record<string, { arity: number | [number, number]; fn: (...a: number[]) => number }> = {
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  sinh: { arity: 1, fn: Math.sinh },
  cosh: { arity: 1, fn: Math.cosh },
  tanh: { arity: 1, fn: Math.tanh },
  exp: { arity: 1, fn: Math.exp },
  ln: { arity: 1, fn: Math.log },
  log: { arity: [1, 2], fn: (a, b) => (b === undefined ? Math.log10(a) : Math.log(b) / Math.log(a)) },
  log2: { arity: 1, fn: Math.log2 },
  log10: { arity: 1, fn: Math.log10 },
  sqrt: { arity: 1, fn: Math.sqrt },
  cbrt: { arity: 1, fn: Math.cbrt },
  abs: { arity: 1, fn: Math.abs },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  round: { arity: 1, fn: Math.round },
  sign: { arity: 1, fn: Math.sign },
  min: { arity: [1, 8], fn: (...a) => Math.min(...a) },
  max: { arity: [1, 8], fn: (...a) => Math.max(...a) },
  pow: { arity: 2, fn: Math.pow },
  atan2: { arity: 2, fn: Math.atan2 },
  hypot: { arity: [1, 8], fn: (...a) => Math.hypot(...a) },
};

const CONSTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

export type CompiledExpr = (x: number) => number;

type Tok =
  | { t: 'num'; v: number; at: number }
  | { t: 'id'; v: string; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: '('; at: number }
  | { t: ')'; at: number }
  | { t: ','; at: number };

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '^', '%']);

function failExpr(src: string, at: number, msg: string): never {
  const from = Math.max(0, at - 12);
  const snippet = src.slice(from, at + 12).replace(/\s+/g, ' ');
  throw new Error(`表达式第 ${at + 1} 字符附近出错：${msg}（…${snippet}…）`);
}

function tokenizeExpr(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      if (c === '.' && toks.length > 0 && (toks[toks.length - 1].t === 'id' || toks[toks.length - 1].t === ')') && /[A-Za-z_$]/.test(src[i + 1] ?? '')) {
        failExpr(src, i, '不支持属性访问「.」');
      }
      const m = /^\d*\.?\d*(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m && m[0] ? m[0] : '';
      if (!text || text === '.') failExpr(src, i, '数字写法不完整');
      if (/[eE]/.test(src[i + text.length] ?? '')) {
        failExpr(src, i + text.length, '数字指数不完整');
      }
      // 拒绝类似 1.2.3 的多小数点数字面量
      if (src[i + text.length] === '.') {
        failExpr(src, i + text.length, '数字写法不完整（多余的小数点）');
      }
      const v = Number(text);
      if (!Number.isFinite(v)) failExpr(src, i, `数字超出范围：${text}`);
      toks.push({ t: 'num', v, at: i });
      i += text.length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    if (OPERATOR_CHARS.has(c)) {
      toks.push({ t: 'op', v: c, at: i });
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ t: '(', at: i });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ t: ')', at: i });
      i++;
      continue;
    }
    if (c === ',') {
      toks.push({ t: ',', at: i });
      i++;
      continue;
    }
    failExpr(src, i, `不认识的字符「${c}」（只支持数字、x、+ - * / ^ %、括号与常用函数）`);
  }
  return toks;
}

type ExprNode =
  | { k: 'num'; v: number }
  | { k: 'var' }
  | { k: 'unary'; op: string; a: ExprNode }
  | { k: 'binary'; op: string; a: ExprNode; b: ExprNode }
  | { k: 'call'; name: string; args: ExprNode[] };

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };

function parseExprAst(src: string): ExprNode {
  const toks = tokenizeExpr(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t: Tok['t']) => {
    const tk = toks[p];
    if (!tk || tk.t !== t) return null;
    p++;
    return tk;
  };

  function parseExpr(minPrec: number): ExprNode {
    let left = parseUnary();
    for (;;) {
      const tk = peek();
      if (!tk) break;
      if (tk.t === 'op') {
        const prec = PREC[tk.v];
        if (prec === undefined || prec < minPrec) break;
        p++;
        const right = parseExpr(tk.v === '^' ? prec : prec + 1);
        left = { k: 'binary', op: tk.v, a: left, b: right };
        continue;
      }
      // 隐式乘法：值与值相邻（2x、2sin(x)、x(x+1)、(x+1)(x-1)）
      // 但禁止函数调用后紧跟括号形成调用链（如 sin(x)(y)）
      if ((tk.t === 'num' || tk.t === 'id' || tk.t === '(') && minPrec <= 2) {
        if (left.k === 'call' && tk.t === '(') {
          failExpr(src, tk.at, '不支持函数调用链，乘法请显式写 *');
        }
        const right = parseUnary();
        left = { k: 'binary', op: '*', a: left, b: right };
        continue;
      }
      break;
    }
    return left;
  }

  function parseUnary(): ExprNode {
    const tk = peek();
    if (tk && tk.t === 'op' && (tk.v === '-' || tk.v === '+')) {
      p++;
      return { k: 'unary', op: tk.v, a: parsePower() };
    }
    return parsePower();
  }

  function parsePower(): ExprNode {
    const base = parsePrimary();
    const tk = peek();
    if (tk && tk.t === 'op' && tk.v === '^') {
      p++;
      return { k: 'binary', op: '^', a: base, b: parseUnary() };
    }
    return base;
  }

  function parsePrimary(): ExprNode {
    const tk = peek();
    if (!tk) failExpr(src, src.length, '表达式在这里断了（缺少内容）');
    if (tk.t === 'num') {
      p++;
      return { k: 'num', v: tk.v };
    }
    if (tk.t === '(') {
      p++;
      const inner = parseExpr(0);
      if (!eat(')')) failExpr(src, peek()?.at ?? src.length, '括号没有闭合（缺少 ））');
      return inner;
    }
    if (tk.t === 'id') {
      p++;
      const name = tk.v.toLowerCase();
      if (name === 'x') return { k: 'var' };
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) {
        return { k: 'num', v: CONSTS[name] };
      }
      if (peek()?.t === '(') {
        const spec = Object.prototype.hasOwnProperty.call(FUNCS, name) ? FUNCS[name] : undefined;
        if (!spec) {
          failExpr(
            src,
            tk.at,
            `不认识的函数「${tk.v}」。可用：${Object.keys(FUNCS).join(' / ')}`,
          );
        }
        p++;
        const args: ExprNode[] = [];
        if (peek()?.t !== ')') {
          for (;;) {
            args.push(parseExpr(0));
            if (eat(',')) continue;
            break;
          }
        }
        if (!eat(')')) failExpr(src, peek()?.at ?? src.length, `函数 ${tk.v}( 的参数表缺少 ）`);
        const [lo, hi] = Array.isArray(spec.arity) ? spec.arity : [spec.arity, spec.arity];
        if (args.length < lo || args.length > hi) {
          failExpr(src, tk.at, `${tk.v} 需要 ${lo === hi ? `${lo}` : `${lo}~${hi}`} 个参数（实得 ${args.length}）`);
        }
        return { k: 'call', name, args };
      }
      failExpr(
        src,
        tk.at,
        `不认识的标识符「${tk.v}」。曲线里只能用 x、pi、e、tau 与函数（${Object.keys(FUNCS).slice(0, 8).join(' / ')} 等）`,
      );
    }
    failExpr(src, tk.at, '这里应该是一个数字、x 或函数');
  }

  const ast = parseExpr(0);
  if (p < toks.length) {
    const tk = toks[p];
    failExpr(src, tk.at, `表达式末尾多了内容（${tk.t === 'op' ? `运算符 ${tk.v}` : tk.t === 'id' ? tk.v : tk.t}）`);
  }
  return ast;
}

function computeExprNode(n: ExprNode, x: number): number {
  switch (n.k) {
    case 'num':
      return n.v;
    case 'var':
      return x;
    case 'unary':
      return n.op === '-' ? -computeExprNode(n.a, x) : computeExprNode(n.a, x);
    case 'binary': {
      const a = computeExprNode(n.a, x);
      const b = computeExprNode(n.b, x);
      switch (n.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '%':
          return a % b;
        case '^':
          return a ** b;
      }
      return NaN;
    }
    case 'call':
      return FUNCS[n.name].fn(...n.args.map((a) => computeExprNode(a, x)));
  }
}

/**
 * 将数学表达式编译为安全的求值函数 (x: number) => number。
 */
export function compileDiagramExpr(src: string): CompiledExpr {
  if (src.length > 512) throw new Error('表达式长度不能超过 512');
  const trimmed = src.trim();
  if (!trimmed) throw new Error('曲线 fn 不能为空：写 "x^2"、"sin(x)" 这样的表达式');
  let depth = 0;
  for (const c of trimmed) {
    if (c === '(' && ++depth > 64) throw new Error('表达式括号深度不能超过 64');
    if (c === ')') depth--;
  }
  const ast = parseExprAst(trimmed);
  return (x: number) => computeExprNode(ast, x);
}

export const compileExpression = compileDiagramExpr;

// ============================================================================
// 2. Diagram Schema 定义与校验器
// ============================================================================

export type Point2 = [number, number];

export type NodeShape = 'box' | 'round' | 'ellipse' | 'diamond';

export interface GraphNode {
  id: string;
  label: string;
  shape?: NodeShape;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GraphDoc {
  type: 'graph';
  direction?: 'TB' | 'LR';
  nodes: GraphNode[];
  edges?: GraphEdge[];
}

export interface Curve {
  fn: string;
  label?: string;
  color?: string;
  domain?: Point2;
}

export interface PlotPoint {
  at: Point2;
  label?: string;
}

export interface Segment {
  from: Point2;
  to: Point2;
  label?: string;
  dashed?: boolean;
}

export interface Polygon {
  points: Point2[];
  label?: string;
}

export interface CircleGeom {
  center: Point2;
  r: number;
  label?: string;
}

export interface TextLabel {
  at: Point2;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
}

export interface PlotDoc {
  type: 'plot';
  x?: Point2;
  y?: Point2;
  axes?: boolean;
  curves?: Curve[];
  points?: PlotPoint[];
  segments?: Segment[];
  polygons?: Polygon[];
  circles?: CircleGeom[];
  labels?: TextLabel[];
}

export interface ChartDatum {
  label: string;
  value: number;
}

export interface ChartDoc {
  type: 'chart';
  kind: 'bar' | 'line' | 'pie';
  data: ChartDatum[];
  y?: Point2;
}

export type DiagramDoc = GraphDoc | PlotDoc | ChartDoc;

export interface DiagramShape {
  key: string;
  svg: string;
}

export const LIMITS = {
  maxData: 12,
  maxNodes: 100,
  maxEdges: 200,
  maxNodeLabel: 80,
  maxEdgeLabel: 40,
  maxText: 40,
  maxCurves: 4,
  maxPoints: 12,
  maxSegments: 12,
  maxPolygons: 6,
  maxCircles: 6,
  maxLabels: 8,
} as const;

export class DiagramSchemaError extends Error {}

function bad(msg: string): never {
  throw new DiagramSchemaError(msg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rejectUnknown(where: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      bad(`${where}有不认识的字段「${k}」。可用字段：${allowed.join(' / ')}（大小写敏感，不要自己发明字段名）`);
    }
  }
}

function reqStr(where: string, v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim()) bad(`${where}必须是非空字符串`);
  const s = v.trim();
  if (s.length > max) bad(`${where}超过 ${max} 字（实得 ${s.length} 字）：图里放不下的长文改正文`);
  return s;
}

function optStr(where: string, v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  return reqStr(where, v, max);
}

function reqNum(where: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${where}必须是有限数字（实得 ${JSON.stringify(v)}）`);
  return v;
}

function optBool(where: string, v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') bad(`${where}必须是 true / false`);
  return v;
}

function reqPair(where: string, v: unknown): Point2 {
  if (!Array.isArray(v) || v.length !== 2) bad(`${where}必须是 [a, b] 两个数的数组（实得 ${JSON.stringify(v)}）`);
  return [reqNum(`${where}[0]`, v[0]), reqNum(`${where}[1]`, v[1])];
}

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NAMED_COLORS = new Set([
  'black', 'white', 'red', 'green', 'blue', 'gray', 'grey', 'orange', 'purple', 'pink', 'brown', 'cyan', 'magenta', 'yellow',
]);

function optColor(where: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(COLOR_RE.test(v) || NAMED_COLORS.has(v.toLowerCase()))) {
    bad(`${where}只能是 #1677ff 这样的十六进制颜色或少数命名色（实得 ${JSON.stringify(v)}）`);
  }
  return v;
}

const NODE_SHAPES: readonly NodeShape[] = ['box', 'round', 'ellipse', 'diamond'];
const ANCHORS: readonly ('start' | 'middle' | 'end')[] = ['start', 'middle', 'end'];

function checkNode(where: string, raw: unknown): GraphNode {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"id": …, "label": …}`);
  rejectUnknown(where, raw, ['id', 'label', 'shape']);
  const id = reqStr(`${where}.id`, raw.id, 24);
  const label = reqStr(`${where}.label`, raw.label, LIMITS.maxNodeLabel);
  const node: GraphNode = { id, label };
  if (raw.shape !== undefined && raw.shape !== null) {
    if (!NODE_SHAPES.includes(raw.shape as NodeShape)) {
      bad(`${where}.shape 只能是 ${NODE_SHAPES.join(' / ')}（实得 ${JSON.stringify(raw.shape)}）`);
    }
    node.shape = raw.shape as NodeShape;
  }
  return node;
}

function checkEdge(where: string, raw: unknown): GraphEdge {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"from": …, "to": …}`);
  rejectUnknown(where, raw, ['from', 'to', 'label']);
  const edge: GraphEdge = { from: reqStr(`${where}.from`, raw.from, 24), to: reqStr(`${where}.to`, raw.to, 24) };
  const label = optStr(`${where}.label`, raw.label, LIMITS.maxEdgeLabel);
  if (label !== undefined) edge.label = label;
  return edge;
}

function checkCurve(where: string, raw: unknown): Curve {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"fn": "sin(x)", …}`);
  rejectUnknown(where, raw, ['fn', 'label', 'color', 'domain']);
  const fn = reqStr(`${where}.fn`, raw.fn, 200);
  let domain: Point2 | undefined;
  if (raw.domain !== undefined && raw.domain !== null) {
    domain = reqPair(`${where}.domain`, raw.domain);
    if (!(domain[0] < domain[1])) bad(`${where}.domain 必须 [起点, 终点] 且起点小于终点`);
  }
  const curve: Curve = { fn };
  const label = optStr(`${where}.label`, raw.label, LIMITS.maxText);
  if (label !== undefined) curve.label = label;
  const color = optColor(`${where}.color`, raw.color);
  if (color !== undefined) curve.color = color;
  if (domain !== undefined) curve.domain = domain;
  return curve;
}

function checkPoint(where: string, raw: unknown): PlotPoint {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"at": [x, y], "label": "A"}`);
  rejectUnknown(where, raw, ['at', 'label']);
  const pt: PlotPoint = { at: reqPair(`${where}.at`, raw.at) };
  const label = optStr(`${where}.label`, raw.label, LIMITS.maxText);
  if (label !== undefined) pt.label = label;
  return pt;
}

function checkSegment(where: string, raw: unknown): Segment {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"from": [x,y], "to": [x,y]}`);
  rejectUnknown(where, raw, ['from', 'to', 'label', 'dashed']);
  const seg: Segment = {
    from: reqPair(`${where}.from`, raw.from),
    to: reqPair(`${where}.to`, raw.to),
  };
  const label = optStr(`${where}.label`, raw.label, LIMITS.maxText);
  if (label !== undefined) seg.label = label;
  const dashed = optBool(`${where}.dashed`, raw.dashed);
  if (dashed !== undefined) seg.dashed = dashed;
  return seg;
}

function checkPolygon(where: string, raw: unknown): Polygon {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"points": [[x,y], …]}`);
  rejectUnknown(where, raw, ['points', 'label']);
  if (!Array.isArray(raw.points) || raw.points.length < 3) {
    bad(`${where}.points 至少需要 3 个点（实得 ${Array.isArray(raw.points) ? raw.points.length : 0} 个）`);
  }
  if ((raw.points as unknown[]).length > 12) bad(`${where}.points 超过 12 个点`);
  const poly: Polygon = {
    points: (raw.points as unknown[]).map((p, j) => reqPair(`${where}.points[${j}]`, p)),
  };
  const label = optStr(`${where}.label`, raw.label, LIMITS.maxText);
  if (label !== undefined) poly.label = label;
  return poly;
}

function checkCircle(where: string, raw: unknown): CircleGeom {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"center": [x,y], "r": 3}`);
  rejectUnknown(where, raw, ['center', 'r', 'label']);
  const r = reqNum(`${where}.r`, raw.r);
  if (r <= 0) bad(`${where}.r 必须是正数（实得 ${r}）`);
  const circle: CircleGeom = { center: reqPair(`${where}.center`, raw.center), r };
  const label = optStr(`${where}.label`, raw.label, LIMITS.maxText);
  if (label !== undefined) circle.label = label;
  return circle;
}

function checkLabel(where: string, raw: unknown): TextLabel {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"at": [x,y], "text": "顶点"}`);
  rejectUnknown(where, raw, ['at', 'text', 'anchor']);
  let anchor: 'start' | 'middle' | 'end' | undefined;
  if (raw.anchor !== undefined && raw.anchor !== null) {
    if (!ANCHORS.includes(raw.anchor as 'start')) {
      bad(`${where}.anchor 只能是 ${ANCHORS.join(' / ')}（实得 ${JSON.stringify(raw.anchor)}）`);
    }
    anchor = raw.anchor as 'start' | 'middle' | 'end';
  }
  const lbl: TextLabel = { at: reqPair(`${where}.at`, raw.at), text: reqStr(`${where}.text`, raw.text, LIMITS.maxText) };
  if (anchor !== undefined) lbl.anchor = anchor;
  return lbl;
}

function checkDatum(where: string, raw: unknown): ChartDatum {
  if (!isPlainObject(raw)) bad(`${where}必须是对象 {"label": …, "value": …}`);
  rejectUnknown(where, raw, ['label', 'value']);
  return { label: reqStr(`${where}.label`, raw.label, 12), value: reqNum(`${where}.value`, raw.value) };
}

function pick<T>(check: (where: string, raw: unknown) => T) {
  return (raw: unknown): T | null => {
    try {
      return check('流式项', raw);
    } catch {
      return null;
    }
  };
}

export const pickValidNode = pick(checkNode);
export const pickValidEdge = pick(checkEdge);
export const pickValidCurve = pick(checkCurve);
export const pickValidPoint = pick(checkPoint);
export const pickValidSegment = pick(checkSegment);
export const pickValidPolygon = pick(checkPolygon);
export const pickValidCircle = pick(checkCircle);
export const pickValidLabel = pick(checkLabel);
export const pickValidDatum = pick(checkDatum);

function validateChart(input: Record<string, unknown>): ChartDoc {
  rejectUnknown('chart', input, ['type', 'kind', 'data', 'y']);
  if (input.kind !== 'bar' && input.kind !== 'line' && input.kind !== 'pie') bad('chart.kind 必须是 bar / line / pie');
  if (!Array.isArray(input.data) || !input.data.length || input.data.length > LIMITS.maxData) {
    bad(`chart.data 必须有 1～${LIMITS.maxData} 项`);
  }
  const data = input.data.map((item, i) => checkDatum(`data[${i}]`, item));
  const y = input.y == null ? undefined : reqPair('y', input.y);
  if (y && (!(y[0] < y[1]) || !Number.isFinite(y[1] - y[0]))) bad('y 范围必须递增且跨度有限');
  if (y && data.some((d) => d.value < y[0] || d.value > y[1])) bad('data.value 超出了 y 范围');
  if (input.kind === 'pie') {
    if (y) bad('pie 不支持 y 范围');
    if (data.some((d) => d.value < 0) || !data.some((d) => d.value > 0)) bad('pie 的 value 必须非负，且至少一项大于 0');
  }
  return { type: 'chart', kind: input.kind, data, ...(y ? { y } : {}) };
}

function validateGraph(input: Record<string, unknown>): GraphDoc {
  let direction: 'TB' | 'LR' | undefined;
  if (input.direction !== undefined && input.direction !== null) {
    if (input.direction !== 'TB' && input.direction !== 'LR') {
      bad(`direction 只能是 "TB"（纵向）或 "LR"（横向），实得 ${JSON.stringify(input.direction)}`);
    }
    direction = input.direction;
  }

  if (!Array.isArray(input.nodes)) bad('graph 必须有 nodes 数组：[{"id":"a","label":"客户端"}, …]');
  if (input.nodes.length === 0) bad('nodes 不能为空：至少写一个节点');
  if (input.nodes.length > LIMITS.maxNodes) {
    bad(`nodes 超过渲染安全上限 ${LIMITS.maxNodes} 个（实得 ${input.nodes.length} 个）：按主题分图，保留全部节点与关系`);
  }

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  input.nodes.forEach((raw, i) => {
    const node = checkNode(`nodes[${i}]`, raw);
    if (seen.has(node.id)) {
      bad(`节点 id 重复：「${node.id}」。id 只在图内做连线引用，重复了连线会指错`);
    }
    seen.add(node.id);
    nodes.push(node);
  });

  let edges: GraphEdge[] | undefined;
  if (input.edges !== undefined && input.edges !== null) {
    if (!Array.isArray(input.edges)) bad('edges 必须是数组：[{"from":"a","to":"b"}, …]');
    if (input.edges.length > LIMITS.maxEdges) {
      bad(`edges 超过渲染安全上限 ${LIMITS.maxEdges} 条（实得 ${input.edges.length} 条）：按主题分图，保留全部节点与关系`);
    }
    edges = [];
    input.edges.forEach((raw, i) => {
      const where = `edges[${i}]`;
      const edge = checkEdge(where, raw);
      if (edge.from === edge.to) {
        bad(`${where} 是自环（from 与 to 都是「${edge.from}」）：本渲染器不支持自环，去掉它或把说明写进节点文案`);
      }
      for (const [role, id] of [['from', edge.from], ['to', edge.to]] as const) {
        if (!seen.has(id)) {
          bad(`${where}.${role} 引用了不存在的节点「${id}」。可用 id：${[...seen].join(' / ')}`);
        }
      }
      edges!.push(edge);
    });
  }

  const doc: GraphDoc = { type: 'graph', nodes };
  if (direction !== undefined) doc.direction = direction;
  if (edges !== undefined) doc.edges = edges;
  return doc;
}

function validatePlot(input: Record<string, unknown>): PlotDoc {
  const x = input.x === undefined || input.x === null ? undefined : reqPair('x', input.x);
  if (x && !(x[0] < x[1])) bad(`x 范围必须 [最小值, 最大值] 且最小值小于最大值（实得 [${x[0]}, ${x[1]}]）`);
  const y = input.y === undefined || input.y === null ? undefined : reqPair('y', input.y);
  if (y && !(y[0] < y[1])) bad(`y 范围必须 [最小值, 最大值] 且最小值小于最大值（实得 [${y[0]}, ${y[1]}]）`);

  const doc: PlotDoc = { type: 'plot' };
  if (x !== undefined) doc.x = x;
  if (y !== undefined) doc.y = y;
  const axes = optBool('axes', input.axes);
  if (axes !== undefined) doc.axes = axes;

  const arr = <T>(key: string, limit: number, check: (where: string, raw: unknown) => T): T[] | undefined => {
    const v = input[key];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) bad(`${key} 必须是数组`);
    if (v.length > limit) bad(`${key} 超过 ${limit} 项（实得 ${v.length} 项）：一张图讲一件事，拆开画`);
    return v.map((item, i) => check(`${key}[${i}]`, item));
  };

  const curves = arr('curves', LIMITS.maxCurves, checkCurve);
  if (curves !== undefined) doc.curves = curves;
  const points = arr('points', LIMITS.maxPoints, checkPoint);
  if (points !== undefined) doc.points = points;
  const segments = arr('segments', LIMITS.maxSegments, checkSegment);
  if (segments !== undefined) doc.segments = segments;
  const polygons = arr('polygons', LIMITS.maxPolygons, checkPolygon);
  if (polygons !== undefined) doc.polygons = polygons;
  const circles = arr('circles', LIMITS.maxCircles, checkCircle);
  if (circles !== undefined) doc.circles = circles;
  const labels = arr('labels', LIMITS.maxLabels, checkLabel);
  if (labels !== undefined) doc.labels = labels;

  if (doc.curves && x) {
    doc.curves.forEach((c, i) => {
      if (c.domain && (c.domain[0] < x[0] || c.domain[1] > x[1])) {
        bad(`curves[${i}].domain [${c.domain[0]}, ${c.domain[1]}] 超出了 x 范围 [${x[0]}, ${x[1]}]：曲线只能画在坐标轴范围内`);
      }
    });
  }

  return doc;
}

/**
 * 校验并规范化一段 diagram JSON。
 */
export function validateDiagram(input: unknown): DiagramDoc {
  if (!isPlainObject(input)) bad('diagram 围栏里必须是一个 JSON 对象：{"type": "graph"|"plot", …}');

  const type = input.type;
  if (type === 'chart') return validateChart(input);
  if (type !== 'graph' && type !== 'plot') {
    bad(
      `type 必须是 "graph"（结构图）、"plot"（函数/几何）或 "chart"（柱/折/饼），实得 ${JSON.stringify(type)}。` +
        '时序等未覆盖图种用 ```mermaid 围栏',
    );
  }
  rejectUnknown(
    'diagram',
    input,
    type === 'graph'
      ? ['type', 'direction', 'nodes', 'edges']
      : ['type', 'x', 'y', 'axes', 'curves', 'points', 'segments', 'polygons', 'circles', 'labels'],
  );

  if (type === 'graph') return validateGraph(input);
  return validatePlot(input);
}

// ============================================================================
// 3. 流式半截 JSON 提取器 peekStreamingDiagram / peekDiagramProgress
// ============================================================================

export interface DiagramProgress {
  viewBox: string;
  shapes: DiagramShape[];
}

const SCALAR_ARRAY_KEYS = new Set(['x', 'y']);

interface ScanResult {
  type: string | null;
  scalars: Record<string, unknown>;
  arrays: Record<string, unknown[]>;
}

function skipWs(src: string, i: number): number {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++;
  return i;
}

function scanString(src: string, i: number): number {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i++;
  }
  return -1;
}

function scanContainer(src: string, i: number): number {
  const stack: string[] = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const e = scanString(src, i);
      if (e < 0) return -1;
      i = e;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      i++;
      if (stack.length === 0) return i;
      continue;
    }
    i++;
  }
  return -1;
}

function scanValue(src: string, i: number): number {
  i = skipWs(src, i);
  if (i >= src.length) return -1;
  const c = src[i];
  if (c === '"') return scanString(src, i);
  if (c === '{' || c === '[') return scanContainer(src, i);
  let j = i;
  while (j < src.length && !/[\s,}\]]/.test(src[j])) j++;
  return j >= src.length ? -1 : j;
}

function scanArrayItems(src: string, from: number): unknown[] {
  const items: unknown[] = [];
  let j = from + 1;
  for (;;) {
    j = skipWs(src, j);
    if (j >= src.length) break;
    if (src[j] === ']') break;
    if (src[j] === ',') {
      j++;
      continue;
    }
    const end = scanValue(src, j);
    if (end <= j) { j += 1; continue; }
    try {
      items.push(JSON.parse(src.slice(j, end)));
    } catch {
      // 跳过畸形元素
    }
    j = end;
  }
  return items;
}

function scanTop(src: string): ScanResult | null {
  const start = src.indexOf('{');
  if (start < 0) return null;
  if (src.slice(0, start).trim()) return null;
  const out: ScanResult = { type: null, scalars: Object.create(null), arrays: Object.create(null) };
  let i = start + 1;
  for (;;) {
    i = skipWs(src, i);
    if (i >= src.length) return out;
    const c = src[i];
    if (c === '}') return out;
    if (c === ',') {
      i++;
      continue;
    }
    if (c !== '"') return out;
    const keyEnd = scanString(src, i);
    if (keyEnd < 0) return out;
    let key: string;
    try {
      key = JSON.parse(src.slice(i, keyEnd)) as string;
    } catch {
      return out;
    }
    i = skipWs(src, keyEnd);
    if (i >= src.length || src[i] !== ':') return out;
    i = skipWs(src, i + 1);
    if (i >= src.length) return out;

    if (src[i] === '[') {
      const arrEnd = scanContainer(src, i);
      if (arrEnd < 0) {
        out.arrays[key] = scanArrayItems(src, i);
        return out;
      }
      if (SCALAR_ARRAY_KEYS.has(key)) {
        try {
          out.scalars[key] = JSON.parse(src.slice(i, arrEnd));
        } catch {
          // 留待终态报错
        }
      }
      out.arrays[key] = scanArrayItems(src.slice(0, arrEnd), i);
      i = arrEnd;
      continue;
    }
    const valEnd = scanValue(src, i);
    if (valEnd < 0) return out;
    try {
      const v = JSON.parse(src.slice(i, valEnd));
      if (key === 'type' && typeof v === 'string') out.type = v;
      else out.scalars[key] = v;
    } catch {
      // 跳过单项错误
    }
    i = valEnd;
  }
}

function pair(v: unknown): Point2 | undefined {
  if (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1])
  ) {
    return [v[0], v[1]];
  }
  return undefined;
}

/**
 * 从未闭合的半截 JSON 流中提取已完整的 DiagramDoc。
 */
export function peekStreamingDiagram(rawJsonPrefix: string): DiagramDoc | null {
  const scan = scanTop(rawJsonPrefix);
  if (!scan || !scan.type) return null;
  if (scan.type !== 'graph' && scan.type !== 'plot' && scan.type !== 'chart') return null;

  if (scan.type === 'chart') {
    const kind = scan.scalars.kind;
    if (kind !== 'bar' && kind !== 'line' && kind !== 'pie') return null;
    const data = (scan.arrays.data ?? [])
      .slice(0, LIMITS.maxData)
      .map(pickValidDatum)
      .filter((d): d is ChartDatum => d !== null && (kind !== 'pie' || d.value >= 0));
    if (!data.length) return null;
    const y = pair(scan.scalars.y);
    return {
      type: 'chart',
      kind,
      data,
      ...(y && y[0] < y[1] && Number.isFinite(y[1] - y[0]) ? { y } : {}),
    };
  }

  if (scan.type === 'graph') {
    const seen = new Set<string>();
    const nodes: GraphNode[] = [];
    for (const item of (scan.arrays.nodes ?? []).slice(0, LIMITS.maxNodes)) {
      const n = pickValidNode(item);
      if (n && !seen.has(n.id)) {
        seen.add(n.id);
        nodes.push(n);
      }
    }
    if (nodes.length === 0) return null;
    const edges: GraphEdge[] = (scan.arrays.edges ?? [])
      .slice(0, LIMITS.maxEdges)
      .map(pickValidEdge)
      .filter((e): e is GraphEdge => e !== null && e.from !== e.to && seen.has(e.from) && seen.has(e.to));
    return {
      type: 'graph',
      direction: scan.scalars.direction === 'LR' ? 'LR' : 'TB',
      nodes,
      edges,
    };
  }

  const plot: PlotDoc = { type: 'plot' };
  const x = pair(scan.scalars.x);
  if (x && x[0] < x[1]) plot.x = x;
  const y = pair(scan.scalars.y);
  if (y && y[0] < y[1]) plot.y = y;
  if (typeof scan.scalars.axes === 'boolean') plot.axes = scan.scalars.axes;
  const curves = (scan.arrays.curves ?? [])
    .slice(0, LIMITS.maxCurves)
    .map(pickValidCurve)
    .filter((c): c is Curve => c !== null);
  if (curves.length > 0) plot.curves = curves;
  const points = (scan.arrays.points ?? [])
    .slice(0, LIMITS.maxPoints)
    .map(pickValidPoint)
    .filter((p): p is PlotPoint => p !== null);
  if (points.length > 0) plot.points = points;
  const segments = (scan.arrays.segments ?? [])
    .slice(0, LIMITS.maxSegments)
    .map(pickValidSegment)
    .filter((s): s is Segment => s !== null);
  if (segments.length > 0) plot.segments = segments;
  const polygons = (scan.arrays.polygons ?? [])
    .slice(0, LIMITS.maxPolygons)
    .map(pickValidPolygon)
    .filter((p): p is Polygon => p !== null);
  if (polygons.length > 0) plot.polygons = polygons;
  const circles = (scan.arrays.circles ?? [])
    .slice(0, LIMITS.maxCircles)
    .map(pickValidCircle)
    .filter((c): c is CircleGeom => c !== null);
  if (circles.length > 0) plot.circles = circles;
  const labels = (scan.arrays.labels ?? [])
    .slice(0, LIMITS.maxLabels)
    .map(pickValidLabel)
    .filter((l): l is TextLabel => l !== null);
  if (labels.length > 0) plot.labels = labels;

  const hasGeom =
    curves.length > 0 ||
    points.length > 0 ||
    segments.length > 0 ||
    polygons.length > 0 ||
    circles.length > 0 ||
    labels.length > 0;
  if (plot.axes === false && !hasGeom) return null;
  return plot;
}

/**
 * 从未闭合的半截 JSON 流中切出已经可以落画的 SVG 形状快照。
 */
export function peekDiagramProgress(rawJsonPrefix: string): DiagramProgress | null {
  const doc = peekStreamingDiagram(rawJsonPrefix);
  if (!doc) return null;
  try {
    const out = renderDiagram(doc, { tolerant: true });
    if (out.shapes.length === 0) return null;
    return { viewBox: out.viewBox, shapes: out.shapes };
  } catch {
    return null;
  }
}

// ============================================================================
// 4. 确定性几何与函数图像 SVG 渲染器
// ============================================================================

export interface RenderedDiagram {
  width: number;
  height: number;
  viewBox: string;
  shapes: DiagramShape[];
  svg: string;
}

export interface RenderOptions {
  theme?: 'light' | 'dark';
  tolerant?: boolean;
}

interface Palette {
  nodeFill: string;
  nodeStroke: string;
  text: string;
  edge: string;
  grid: string;
  axis: string;
  tick: string;
  point: string;
  geom: string;
  geomFill: string;
  halo: string;
  legendBg: string;
}

const LIGHT_PALETTE: Palette = {
  nodeFill: '#e6f4ff',
  nodeStroke: '#91caff',
  text: '#1f2329',
  edge: '#8c8c8c',
  grid: '#f0f0f0',
  axis: '#8c8c8c',
  tick: '#8c8c8c',
  point: '#f5222d',
  geom: '#1677ff',
  geomFill: 'rgba(22,119,255,0.08)',
  halo: '#ffffff',
  legendBg: '#ffffff',
};

const DARK_PALETTE: Palette = {
  nodeFill: '#112545',
  nodeStroke: '#3c89e8',
  text: '#e5e7eb',
  edge: '#9ca3af',
  grid: '#27272a',
  axis: '#9ca3af',
  tick: '#9ca3af',
  point: '#ff4d4f',
  geom: '#4096ff',
  geomFill: 'rgba(64,150,255,0.14)',
  halo: '#18181b',
  legendBg: '#18181b',
};

const CURVE_COLORS = ['#1677ff', '#f5222d', '#52c41a', '#722ed1'] as const;
const ARROW_ID = 'xmd-ar';
const FONT = 13;
const SMALL = 10;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 100) / 100;
  if (Object.is(r, -0) || r === 0) return '0';
  return String(r);
}

function textWidth(s: string, fontSize = FONT): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch) ? fontSize : fontSize * 0.57;
  }
  return Math.round(w * 10) / 10;
}

function haloAttrs(palette: Palette): string {
  return ` paint-order="stroke" stroke="${palette.halo}" stroke-width="3" stroke-linejoin="round"`;
}

function labelText(
  palette: Palette,
  x: number,
  y: number,
  s: string,
  anchor: string,
  size = SMALL,
  fill: string = palette.text,
): string {
  return `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${size}" text-anchor="${anchor}" fill="${fill}"${haloAttrs(palette)}>${esc(s)}</text>`;
}

class Bounds {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  add(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  size(pad: number): { width: number; height: number } {
    if (!Number.isFinite(this.maxX)) return { width: 0, height: 0 };
    return {
      width: this.maxX - Math.min(this.minX, 0) + pad * 2,
      height: this.maxY - Math.min(this.minY, 0) + pad * 2,
    };
  }
}

interface NodeBox {
  id: string;
  label: string;
  shape: GraphNode['shape'];
  w: number;
  h: number;
  cx: number;
  cy: number;
}

const GAP_X = 56;
const GAP_Y = 34;
const PAD = 16;

function nodeSize(label: string, shape: GraphNode['shape']): { w: number; h: number } {
  const lines = label.split('\n');
  const lw = Math.max(...lines.map((l) => textWidth(l)));
  switch (shape) {
    case 'ellipse':
      return { w: Math.max(60, lw * 1.4 + 28), h: Math.max(38, lines.length * FONT * 1.8 + 16) };
    case 'diamond':
      return { w: Math.max(74, lw * 2 + 26), h: Math.max(46, lines.length * FONT * 2.5 + 16) };
    case 'round':
      return { w: Math.max(58, lw + 28), h: Math.max(34, lines.length * FONT * 1.25 + 16) };
    default:
      return { w: Math.max(56, lw + 22), h: Math.max(34, lines.length * FONT * 1.25 + 16) };
  }
}

function boxBorderPoint(box: NodeBox, targetX: number, targetY: number): Point2 {
  const dx = targetX - box.cx;
  const dy = targetY - box.cy;
  if (dx === 0 && dy === 0) return [box.cx, box.cy];
  const hw = box.w / 2;
  const hh = box.h / 2;
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  return [box.cx + dx * t, box.cy + dy * t];
}

function layoutGraphTopological(nodes: GraphNode[], edges: GraphEdge[], direction: 'TB' | 'LR'): NodeBox[] {
  const boxes: NodeBox[] = nodes.map((n) => {
    const { w, h } = nodeSize(n.label, n.shape);
    return { id: n.id, label: n.label, shape: n.shape, w, h, cx: 0, cy: 0 };
  });
  const byId = new Map<string, NodeBox>();
  boxes.forEach((b) => byId.set(b.id, b));

  // 使用确定性 DFS 识别回边，保证带环图不死循环且层级唯一确定
  const adj = new Map<string, number[]>();
  nodes.forEach((n) => adj.set(n.id, []));
  edges.forEach((e, idx) => {
    if (byId.has(e.from) && byId.has(e.to) && e.from !== e.to) {
      adj.get(e.from)!.push(idx);
    }
  });

  const state = new Map<string, 0 | 1 | 2>();
  const backEdgeIndices = new Set<number>();

  const dfs = (u: string) => {
    state.set(u, 1);
    for (const idx of adj.get(u) ?? []) {
      const v = edges[idx].to;
      const st = state.get(v) ?? 0;
      if (st === 1) {
        backEdgeIndices.add(idx);
      } else if (st === 0) {
        dfs(v);
      }
    }
    state.set(u, 2);
  };

  for (const n of nodes) {
    if ((state.get(n.id) ?? 0) === 0) dfs(n.id);
  }

  // 最长路径分层（忽略回边）
  const layerMap = new Map<string, number>();
  nodes.forEach((n) => layerMap.set(n.id, 0));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    edges.forEach((e, idx) => {
      if (backEdgeIndices.has(idx)) return;
      const lu = layerMap.get(e.from);
      const lv = layerMap.get(e.to);
      if (lu !== undefined && lv !== undefined && lu + 1 > lv) {
        layerMap.set(e.to, lu + 1);
        changed = true;
      }
    });
    if (!changed) break;
  }

  const maxLayer = Math.max(0, ...layerMap.values());
  const layers: NodeBox[][] = [];
  for (let l = 0; l <= maxLayer; l++) layers.push([]);
  for (const b of boxes) {
    layers[layerMap.get(b.id) ?? 0].push(b);
  }
  const nonEmptyLayers = layers.filter((row) => row.length > 0);

  if (direction === 'TB') {
    const rowWidths = nonEmptyLayers.map(
      (row) => row.reduce((sum, b) => sum + b.w, 0) + Math.max(0, row.length - 1) * GAP_X,
    );
    const rowHeights = nonEmptyLayers.map((row) => Math.max(...row.map((b) => b.h)));
    const maxRowWidth = Math.max(0, ...rowWidths);

    let curY = PAD;
    nonEmptyLayers.forEach((row, rIdx) => {
      const rh = rowHeights[rIdx];
      const rw = rowWidths[rIdx];
      let curX = PAD + (maxRowWidth - rw) / 2;
      for (const b of row) {
        b.cx = curX + b.w / 2;
        b.cy = curY + rh / 2;
        curX += b.w + GAP_X;
      }
      curY += rh + GAP_Y;
    });
  } else {
    const colWidths = nonEmptyLayers.map((col) => Math.max(...col.map((b) => b.w)));
    const colHeights = nonEmptyLayers.map(
      (col) => col.reduce((sum, b) => sum + b.h, 0) + Math.max(0, col.length - 1) * GAP_Y,
    );
    const maxColHeight = Math.max(0, ...colHeights);

    let curX = PAD;
    nonEmptyLayers.forEach((col, cIdx) => {
      const cw = colWidths[cIdx];
      const ch = colHeights[cIdx];
      let curY = PAD + (maxColHeight - ch) / 2;
      for (const b of col) {
        b.cx = curX + cw / 2;
        b.cy = curY + b.h / 2;
        curY += b.h + GAP_Y;
      }
      curX += cw + GAP_X;
    });
  }

  return boxes;
}

function renderGraph(doc: GraphDoc, palette: Palette): RenderedDiagram {
  const nodes = doc.nodes ?? [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = (doc.edges ?? []).filter((e) => e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to));

  if (nodes.length === 0) {
    return { width: 0, height: 0, viewBox: '0 0 0 0', shapes: [], svg: '' };
  }

  const direction = doc.direction ?? 'TB';
  const boxes = layoutGraphTopological(nodes, edges, direction);
  const byId = new Map<string, NodeBox>();
  boxes.forEach((b) => byId.set(b.id, b));

  const bounds = new Bounds();
  const shapes: DiagramShape[] = [];
  const parts: string[] = [];

  if (edges.length > 0) {
    const defs = `<defs><marker id="${ARROW_ID}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${palette.edge}"/></marker></defs>`;
    shapes.push({ key: 'defs', svg: defs });
    parts.push(defs);
  }

  for (const b of boxes) {
    const x = b.cx - b.w / 2;
    const y = b.cy - b.h / 2;
    bounds.add(x, y);
    bounds.add(x + b.w, y + b.h);
    let body: string;
    switch (b.shape) {
      case 'ellipse':
        body = `<ellipse cx="${fmt(b.cx)}" cy="${fmt(b.cy)}" rx="${fmt(b.w / 2)}" ry="${fmt(b.h / 2)}" fill="${palette.nodeFill}" stroke="${palette.nodeStroke}" stroke-width="1.5"/>`;
        break;
      case 'diamond': {
        const hw = b.w / 2;
        const hh = b.h / 2;
        body = `<path d="M${fmt(b.cx)} ${fmt(b.cy - hh)} L${fmt(b.cx + hw)} ${fmt(b.cy)} L${fmt(b.cx)} ${fmt(b.cy + hh)} L${fmt(b.cx - hw)} ${fmt(b.cy)} Z" fill="${palette.nodeFill}" stroke="${palette.nodeStroke}" stroke-width="1.5"/>`;
        break;
      }
      case 'round':
        body = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="${fmt(b.h / 2)}" fill="${palette.nodeFill}" stroke="${palette.nodeStroke}" stroke-width="1.5"/>`;
        break;
      default:
        body = `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="6" fill="${palette.nodeFill}" stroke="${palette.nodeStroke}" stroke-width="1.5"/>`;
    }
    const lines = b.label.split('\n');
    const lineH = FONT * 1.25;
    const firstY = b.cy - ((lines.length - 1) * lineH) / 2 + FONT * 0.36;
    const text = lines
      .map((l, i) => `<tspan x="${fmt(b.cx)}" y="${fmt(firstY + i * lineH)}">${esc(l)}</tspan>`)
      .join('');
    const svg = `<g>${body}<text font-size="${FONT}" text-anchor="middle" fill="${palette.text}">${text}</text></g>`;
    shapes.push({ key: `node:${b.id}`, svg });
    parts.push(svg);
  }

  edges.forEach((e, i) => {
    const u = byId.get(e.from);
    const v = byId.get(e.to);
    if (!u || !v) return;
    const [x1, y1] = boxBorderPoint(u, v.cx, v.cy);
    const [x2, y2] = boxBorderPoint(v, u.cx, u.cy);
    bounds.add(x1, y1);
    bounds.add(x2, y2);
    const d = `M${fmt(x1)} ${fmt(y1)} L${fmt(x2)} ${fmt(y2)}`;
    const mid: Point2 = [(x1 + x2) / 2, (y1 + y2) / 2];
    let svg = `<g><path d="${d}" fill="none" stroke="${palette.edge}" stroke-width="1.5" marker-end="url(#${ARROW_ID})"/>`;
    if (e.label) {
      const lw = textWidth(e.label, 9.5);
      bounds.add(mid[0] - lw / 2 - 2, mid[1] - 16);
      bounds.add(mid[0] + lw / 2 + 2, mid[1] - 4);
      svg += labelText(palette, mid[0], mid[1] - 5, e.label, 'middle', 9.5);
    }
    svg += '</g>';
    shapes.push({ key: `edge:${i}`, svg });
    parts.push(svg);
  });

  const { width, height } = bounds.size(PAD);
  return {
    width,
    height,
    viewBox: `0 0 ${fmt(width)} ${fmt(height)}`,
    shapes,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}">${parts.join('')}</svg>`,
  };
}

const PLOT_W = 440;
const PLOT_H = 270;
const M = { left: 38, right: 16, top: 16, bottom: 28 };
const SAMPLES = 240;

function niceStep(span: number, target = 6): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

function ticks(min: number, max: number, step: number): number[] {
  if (!Number.isFinite(step) || step <= 0) return [];
  const out: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

interface SamplePoint {
  x: number;
  y: number;
  gapBefore: boolean;
}

interface RawSampled {
  pts: SamplePoint[];
  ys: number[];
  span: number;
  fn: CompiledExpr;
}

function collectCurveSamples(fn: CompiledExpr, x0: number, x1: number): RawSampled {
  const pts: SamplePoint[] = [];
  const ys: number[] = [];
  const step = (x1 - x0) / SAMPLES;
  let hadInvalid = false;
  for (let i = 0; i <= SAMPLES; i++) {
    const x = x0 + i * step;
    const y = fn(x);
    if (!Number.isFinite(y) || Math.abs(y) > 1e6) {
      hadInvalid = true;
      continue;
    }
    pts.push({ x, y, gapBefore: hadInvalid });
    ys.push(y);
    hadInvalid = false;
  }
  const sorted = [...ys].sort((a, b) => a - b);
  const span = sorted.length > 0 ? percentile(sorted, 0.98) - percentile(sorted, 0.02) : 0;
  return { pts, ys, span, fn };
}

function buildCurvePath(
  sampled: RawSampled,
  px: (x: number) => number,
  py: (y: number) => number,
  y0: number,
  y1: number,
): string {
  const { pts, span, fn } = sampled;
  const ySpan = Math.max(y1 - y0, 1e-6);
  const jumpLimit = span > 0 ? Math.min(span, ySpan * 1.2) : ySpan * 1.2;
  let d = '';
  let pen = false;
  let prevX = NaN;
  let prevY = NaN;

  for (let i = 0; i < pts.length; i++) {
    const { x, y, gapBefore } = pts[i];
    let isDiscontinuous = gapBefore;

    if (!isDiscontinuous && pen) {
      const dy = Math.abs(y - prevY);
      if (dy > jumpLimit) {
        isDiscontinuous = true;
      } else if ((prevY > 0 && y < 0) || (prevY < 0 && y > 0)) {
        // 中点探测：识别 tan(x) / 1/x 等垂直渐近线跨越符号翻转
        const midY = fn((prevX + x) / 2);
        const minY = Math.min(prevY, y);
        const maxY = Math.max(prevY, y);
        const tol = Math.max(dy * 0.25, 1e-4);
        if (!Number.isFinite(midY) || midY < minY - tol || midY > maxY + tol) {
          isDiscontinuous = true;
        }
      }
    }

    const X = px(x);
    const Y = py(y);
    if (!pen || isDiscontinuous) {
      d += `${d ? ' ' : ''}M${fmt(X)} ${fmt(Y)}`;
      pen = true;
    } else {
      d += ` L${fmt(X)} ${fmt(Y)}`;
    }
    prevX = x;
    prevY = y;
  }

  return d;
}

function renderPlot(doc: PlotDoc, opts: RenderOptions, palette: Palette): RenderedDiagram {
  const curves: Curve[] = doc.curves ?? [];
  const points = doc.points ?? [];
  const segments: Segment[] = doc.segments ?? [];
  const polygons: Polygon[] = doc.polygons ?? [];
  const circles: CircleGeom[] = doc.circles ?? [];
  const labels: TextLabel[] = doc.labels ?? [];

  let x0: number;
  let x1: number;
  if (doc.x) {
    [x0, x1] = doc.x;
  } else {
    const gx = [
      ...points.map((p) => p.at[0]),
      ...segments.flatMap((s) => [s.from[0], s.to[0]]),
      ...polygons.flatMap((p) => p.points.map((q) => q[0])),
      ...circles.map((c) => c.center[0]),
      ...labels.map((l) => l.at[0]),
    ];
    if (gx.length > 0) {
      const lo = Math.min(...gx);
      const hi = Math.max(...gx);
      const span = Math.max(hi - lo, 2);
      x0 = lo - span * 0.12;
      x1 = hi + span * 0.12;
    } else {
      [x0, x1] = [-10, 10];
    }
  }

  const compiled = curves.map((c) => {
    try {
      return compileDiagramExpr(c.fn);
    } catch (e) {
      if (opts.tolerant) return null;
      throw e;
    }
  });
  const sampled = curves.map((c, i) => {
    const fn = compiled[i];
    if (!fn) return null;
    const [a, b] = c.domain ?? [x0, x1];
    return collectCurveSamples(fn, a, b);
  });

  let y0: number;
  let y1: number;
  if (doc.y) {
    [y0, y1] = doc.y;
  } else {
    const curveYs: number[] = [];
    for (const s of sampled) {
      if (s) curveYs.push(...s.ys);
    }
    curveYs.sort((a, b) => a - b);
    const gy = [
      ...points.map((p) => p.at[1]),
      ...segments.flatMap((s) => [s.from[1], s.to[1]]),
      ...polygons.flatMap((p) => p.points.map((q) => q[1])),
      ...circles.flatMap((c) => [c.center[1] - c.r, c.center[1] + c.r]),
      ...labels.map((l) => l.at[1]),
    ];
    let lo = curveYs.length > 0 ? percentile(curveYs, 0.02) : Infinity;
    let hi = curveYs.length > 0 ? percentile(curveYs, 0.98) : -Infinity;
    if (gy.length > 0) {
      lo = Math.min(lo, ...gy);
      hi = Math.max(hi, ...gy);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -5;
      hi = 5;
    }
    const span = Math.max(hi - lo, 1);
    y0 = lo - span * 0.08;
    y1 = hi + span * 0.08;
  }

  const px = (x: number) => M.left + ((x - x0) / (x1 - x0)) * PLOT_W;
  const py = (y: number) => M.top + ((y1 - y) / (y1 - y0)) * PLOT_H;
  const width = M.left + PLOT_W + M.right;
  const height = M.top + PLOT_H + M.bottom;

  const shapes: DiagramShape[] = [];
  const parts: string[] = [];
  const push = (key: string, svg: string) => {
    shapes.push({ key, svg });
    parts.push(svg);
  };

  if (doc.axes !== false) {
    const sx = niceStep(x1 - x0);
    const sy = niceStep(y1 - y0);
    const xt = ticks(x0, x1, sx);
    const yt = ticks(y0, y1, sy);
    const axisX = x0 <= 0 && 0 <= x1 ? px(0) : M.left;
    const axisY = y0 <= 0 && 0 <= y1 ? py(0) : M.top + PLOT_H;
    let g = '<g>';
    for (const t of xt) {
      const X = px(t);
      g += `<line x1="${fmt(X)}" y1="${fmt(M.top)}" x2="${fmt(X)}" y2="${fmt(M.top + PLOT_H)}" stroke="${palette.grid}" stroke-width="1"/>`;
    }
    for (const t of yt) {
      const Y = py(t);
      g += `<line x1="${fmt(M.left)}" y1="${fmt(Y)}" x2="${fmt(M.left + PLOT_W)}" y2="${fmt(Y)}" stroke="${palette.grid}" stroke-width="1"/>`;
    }
    g += `<line x1="${fmt(M.left)}" y1="${fmt(axisY)}" x2="${fmt(M.left + PLOT_W)}" y2="${fmt(axisY)}" stroke="${palette.axis}" stroke-width="1.5"/>`;
    g += `<line x1="${fmt(axisX)}" y1="${fmt(M.top)}" x2="${fmt(axisX)}" y2="${fmt(M.top + PLOT_H)}" stroke="${palette.axis}" stroke-width="1.5"/>`;
    for (const t of xt) {
      if (t === 0) continue;
      g += labelText(palette, px(t), Math.min(axisY + 13, M.top + PLOT_H + 13), fmt(t), 'middle', 9, palette.tick);
    }
    for (const t of yt) {
      if (t === 0) continue;
      g += labelText(palette, Math.max(axisX - 5, M.left - 5), py(t) + 3, fmt(t), 'end', 9, palette.tick);
    }
    if (x0 <= 0 && 0 <= x1 && y0 <= 0 && 0 <= y1) {
      g += labelText(palette, axisX - 5, axisY + 11, 'O', 'end', 10, palette.tick);
    }
    g += labelText(palette, M.left + PLOT_W + 2, axisY - 5, 'x', 'end', 10, palette.tick);
    g += labelText(palette, axisX + 7, M.top + 9, 'y', 'start', 10, palette.tick);
    g += '</g>';
    push('axes', g);
  }

  curves.forEach((c, i) => {
    const s = sampled[i];
    if (!s) return;
    const d = buildCurvePath(s, px, py, y0, y1);
    if (!d) return;
    const color = c.color ?? CURVE_COLORS[i % CURVE_COLORS.length];
    push(
      'curve:' + i,
      `<g><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`,
    );
  });

  const legendItems = curves.map((c, i) => ({ c, i })).filter(({ c }) => c.label);
  if (legendItems.length > 0) {
    const rowH = 15;
    const boxH = legendItems.length * rowH + 8;
    const boxW = Math.max(...legendItems.map(({ c }) => textWidth(c.label ?? '', SMALL))) + 34;
    let g = `<g><rect x="${fmt(M.left + 6)}" y="${fmt(M.top + 6)}" width="${fmt(boxW)}" height="${fmt(boxH)}" rx="4" fill="${palette.legendBg}" fill-opacity="0.78"/>`;
    legendItems.forEach(({ c, i }, row) => {
      const y = M.top + 6 + 14 + row * rowH;
      const color = c.color ?? CURVE_COLORS[i % CURVE_COLORS.length];
      g += `<line x1="${fmt(M.left + 13)}" y1="${fmt(y - 3)}" x2="${fmt(M.left + 27)}" y2="${fmt(y - 3)}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
      g += labelText(palette, M.left + 32, y, c.label ?? '', 'start', SMALL);
    });
    g += '</g>';
    push('legend', g);
  }

  points.forEach((p, j) => {
    const X = px(p.at[0]);
    const Y = py(p.at[1]);
    let svg = `<g><circle cx="${fmt(X)}" cy="${fmt(Y)}" r="3.2" fill="${palette.point}" stroke="${palette.halo}" stroke-width="1"/>`;
    if (p.label) svg += labelText(palette, X + 6, Y - 6, p.label, 'start');
    svg += '</g>';
    push('point:' + j, svg);
  });

  segments.forEach((s, k) => {
    const a = px(s.from[0]);
    const b = py(s.from[1]);
    const c2 = px(s.to[0]);
    const d2 = py(s.to[1]);
    const dash = s.dashed ? ' stroke-dasharray="5 4"' : '';
    let svg = `<g><line x1="${fmt(a)}" y1="${fmt(b)}" x2="${fmt(c2)}" y2="${fmt(d2)}" stroke="${palette.geom}" stroke-width="1.5"${dash}/>`;
    if (s.label) svg += labelText(palette, (a + c2) / 2, (b + d2) / 2 - 6, s.label, 'middle');
    svg += '</g>';
    push('segment:' + k, svg);
  });

  polygons.forEach((p, m) => {
    const d = p.points.map((q, i) => `${i === 0 ? 'M' : 'L'}${fmt(px(q[0]))} ${fmt(py(q[1]))}`).join(' ') + ' Z';
    const cx = p.points.reduce((s, q) => s + px(q[0]), 0) / p.points.length;
    const cy = p.points.reduce((s, q) => s + py(q[1]), 0) / p.points.length;
    let svg = `<g><path d="${d}" fill="${palette.geomFill}" stroke="${palette.geom}" stroke-width="1.5"/>`;
    if (p.label) svg += labelText(palette, cx, cy - 8, p.label, 'middle');
    svg += '</g>';
    push('poly:' + m, svg);
  });

  circles.forEach((c2, n) => {
    const X = px(c2.center[0]);
    const Y = py(c2.center[1]);
    const rx = (c2.r / (x1 - x0)) * PLOT_W;
    const ry = (c2.r / (y1 - y0)) * PLOT_H;
    let svg = `<g><ellipse cx="${fmt(X)}" cy="${fmt(Y)}" rx="${fmt(rx)}" ry="${fmt(ry)}" fill="none" stroke="${palette.geom}" stroke-width="1.5"/>`;
    if (c2.label) svg += labelText(palette, X, Y - ry - 5, c2.label, 'middle');
    svg += '</g>';
    push('circle:' + n, svg);
  });

  labels.forEach((l, p2) => {
    push('label:' + p2, `<g>${labelText(palette, px(l.at[0]), py(l.at[1]), l.text, l.anchor ?? 'start')}</g>`);
  });

  return {
    width,
    height,
    viewBox: `0 0 ${fmt(width)} ${fmt(height)}`,
    shapes,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}">${parts.join('')}</svg>`,
  };
}

function renderChart(doc: ChartDoc, palette: Palette): RenderedDiagram {
  const width = doc.kind === 'pie' ? 560 : Math.max(560, doc.data.length * 80 + 80);
  const height = 340;
  const shapes: DiagramShape[] = [];
  const add = (key: string, svg: string) => shapes.push({ key, svg: `<g>${svg}</g>` });

  if (doc.kind === 'pie') {
    const max = Math.max(...doc.data.map((d) => d.value), 1);
    const total = doc.data.reduce((s, d) => s + d.value / max, 0);
    let angle = -Math.PI / 2;
    doc.data.forEach((d, i) => {
      const ratio = total ? d.value / max / total : 0;
      const end = angle + ratio * Math.PI * 2;
      const color = CURVE_COLORS[i % CURVE_COLORS.length];
      const wedge =
        ratio === 1
          ? `<circle cx="150" cy="170" r="115" fill="${color}"/>`
          : ratio > 0
            ? `<path d="M150 170 L${fmt(150 + 115 * Math.cos(angle))} ${fmt(170 + 115 * Math.sin(angle))} A115 115 0 ${ratio > 0.5 ? 1 : 0} 1 ${fmt(150 + 115 * Math.cos(end))} ${fmt(170 + 115 * Math.sin(end))} Z" fill="${color}" stroke="${palette.halo}"/>`
            : '';
      add(
        `datum:${i}`,
        `${wedge}<rect x="290" y="${24 + i * 25}" width="10" height="10" fill="${color}"/>${labelText(palette, 308, 34 + i * 25, `${d.label} · ${fmt(ratio * 100)}%`, 'start', 16)}`,
      );
      angle = end;
    });
  } else {
    const scale = Math.max(1, ...doc.data.map((d) => Math.abs(d.value)), ...(doc.y ?? []).map(Math.abs));
    const lo = doc.y ? doc.y[0] / scale : Math.min(0, ...doc.data.map((d) => d.value / scale));
    const hi = doc.y ? doc.y[1] / scale : Math.max(0, ...doc.data.map((d) => d.value / scale));
    const span = hi - lo || 1;
    const y = (v: number) => 270 - ((v / scale - lo) / span) * 230;
    const baseline = y(Math.max(lo * scale, Math.min(hi * scale, 0)));
    const step = (width - 80) / Math.max(doc.data.length, 1);
    add(
      'axes',
      `<path d="M55 35 V270 H${width - 20} M55 ${fmt(baseline)} H${width - 20}" fill="none" stroke="${palette.axis}"/>${labelText(palette, 50, 44, String(hi * scale), 'end', 16)}${labelText(palette, 50, 270, String(lo * scale), 'end', 16)}`,
    );
    doc.data.forEach((d, i) => {
      const x = 55 + step * (i + 0.5);
      const cy = y(d.value);
      const previous = doc.data[i - 1];
      const mark =
        doc.kind === 'bar'
          ? `<rect x="${fmt(x - step * 0.3)}" y="${fmt(Math.min(cy, baseline))}" width="${fmt(step * 0.6)}" height="${fmt(Math.abs(baseline - cy))}" rx="2" fill="${palette.geom}"/>`
          : `${previous ? `<path d="M${fmt(x - step)} ${fmt(y(previous.value))} L${fmt(x)} ${fmt(cy)}" fill="none" stroke="${palette.geom}" stroke-width="2"/>` : ''}<circle cx="${fmt(x)}" cy="${fmt(cy)}" r="4" fill="${palette.geom}"/>`;
      const chars = [...d.label];
      let label = '';
      for (let j = 0; j < chars.length; j += 4) {
        label += labelText(palette, x, 292 + (j / 4) * 18, chars.slice(j, j + 4).join(''), 'middle', 16);
      }
      add(`datum:${i}`, `${mark}${label}${labelText(palette, x, cy - 8, String(d.value), 'middle', 16)}`);
    });
  }

  const viewBox = `0 0 ${width} ${height}`;
  return {
    width,
    height,
    viewBox,
    shapes,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${shapes.map((s) => s.svg).join('')}</svg>`,
  };
}

/**
 * 渲染 DiagramDoc，返回包含 viewBox、shapes 与完整 svg 的结构。
 */
export function renderDiagram(doc: DiagramDoc, opts: RenderOptions = {}): RenderedDiagram {
  const palette = opts.theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;
  if (doc.type === 'graph') return renderGraph(doc, palette);
  if (doc.type === 'chart') return renderChart(doc, palette);
  return renderPlot(doc, opts, palette);
}

/**
 * 渲染 DiagramDoc 并直接返回完整 SVG 字符串。
 */
export function renderDiagramSvg(doc: DiagramDoc, options?: RenderOptions): string {
  return renderDiagram(doc, options).svg;
}
