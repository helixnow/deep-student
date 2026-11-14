/**
 * ESLint 自定义规则：命令处理函数里禁止直接 `throw new Error(...)`（以及 `throw Error(...)`、抛字符串）。
 *
 * 背景（host/kernel/API.md §2.3）：处理函数抛出 `CommandError` / 裸 `AppError` 以外的值时，kernel 回复
 * 统一内部错误（`error_type: 'Unknown'` / `INTERNAL_ERROR` / `Internal` / 原文字符串），它只是兜底：
 * Rust 原来以 `Err(AppError::validation(…))`、`Err(AppError::not_found(…))` 等返回的分类在前端就丢了。
 * 新代码应当 `throw new CommandError(<与 Rust 相同的 serde 值>)` 或裸抛 `AppError.xxx(…)`。
 *
 * 处理函数 = `<任意>.commands.register(name, handler)` 的第二个参数：内联函数，或同文件内声明的函数
 * （`function f` / `const f = () => …`）的引用。只统计会原样冒到 kernel 的 throw：
 * - 带 catch 的 try 块内的 throw 不算（catch / finally 里的算）；
 * - 回调里的 throw 只在回调交给数组/Promise 方法、或交给“同文件内且自身没有 try/catch”的透传包装时才算；
 *   交给同文件内带 try/catch 的包装（`commandResult` / `guard` / `serviceCall` 一类）或跨文件函数的不追踪。
 * 不跨文件追踪服务实现：服务内部抛出的裸 Error 不在本规则范围。
 *
 * 棘轮：现存违规按文件计数冻结在 `no-untyped-command-throw.baseline.json`（路径相对仓库根）。某文件的违规数
 * 不超过基线时不报告；超过时报告该文件的全部违规点。基线只减不增，由
 * `node eslint-rules/no-untyped-command-throw.baseline.mjs --update` 收紧（拒绝调高）。
 * 选项 `{ baseline: false }` 关闭基线、报告全部违规（统计用）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(RULE_DIR, '..');
export const BASELINE_PATH = path.join(RULE_DIR, 'no-untyped-command-throw.baseline.json');

let baselineCache = null;
function loadBaseline() {
  if (baselineCache === null) {
    try {
      baselineCache = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? {};
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      baselineCache = {};
    }
  }
  return baselineCache;
}

/** `x.commands.register` / `x.commands.register<T>`（类型参数不改变 callee）。 */
function isCommandRegister(node) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'register') return false;
  const owner = callee.object;
  return owner.type === 'MemberExpression' && !owner.computed && owner.property.name === 'commands';
}

function isFunction(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression' || node?.type === 'FunctionDeclaration';
}

/** 被抛出的是未分类的值：`new Error(…)`、`Error(…)`、字符串或模板字符串。 */
function untypedThrow(argument) {
  if (!argument) return null;
  if ((argument.type === 'NewExpression' || argument.type === 'CallExpression')
    && argument.callee.type === 'Identifier' && argument.callee.name === 'Error') return 'Error';
  if (argument.type === 'Literal' && typeof argument.value === 'string') return 'string';
  if (argument.type === 'TemplateLiteral') return 'string';
  return null;
}

/**
 * 统计用（不进 lint 配置）：给每个 `commands.register` 报一条 `handler`，`data.guard` 为
 * `classified`（同文件内带 try/catch 的包装或整体 try/catch）、`imported`（跨文件包装，未追踪）或 `bare`
 * （服务抛出的值原样到达 kernel）；另给文件内每个未分类 throw 报一条 `bareThrow`。
 */
export const inventoryRule = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { handler: '{{guard}}', bareThrow: '{{kind}}' },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const resolve = (identifier) => {
      for (let scope = sourceCode.getScope(identifier); scope; scope = scope.upper) {
        const variable = scope.set.get(identifier.name);
        if (!variable) continue;
        for (const def of variable.defs) {
          if (def.node.type === 'FunctionDeclaration') return { fn: def.node };
          if (def.node.type === 'VariableDeclarator' && isFunction(def.node.init)) return { fn: def.node.init };
          if (def.type === 'ImportBinding') return { imported: true };
        }
        return {};
      }
      return {};
    };
    const hasCatch = (fn) => {
      const stack = [fn.body];
      while (stack.length) {
        const node = stack.pop();
        if (node.type === 'TryStatement' && node.handler) return true;
        if (isFunction(node)) continue;
        for (const key of sourceCode.visitorKeys[node.type] ?? []) {
          const child = node[key];
          if (Array.isArray(child)) stack.push(...child.filter(item => item && typeof item.type === 'string'));
          else if (child && typeof child.type === 'string') stack.push(child);
        }
      }
      return false;
    };
    const unwrap = (node) => {
      let body = node;
      if (body?.type === 'BlockStatement' && body.body.length === 1 && body.body[0].type === 'ReturnStatement') body = body.body[0].argument;
      while (body?.type === 'AwaitExpression' || body?.type === 'TSAsExpression' || body?.type === 'TSNonNullExpression') body = body.expression ?? body.argument;
      return body;
    };
    const wrapperGuard = (call) => {
      if (call.callee.type !== 'Identifier') return null;
      const target = resolve(call.callee);
      if (target.imported) return 'imported';
      if (target.fn) return hasCatch(target.fn) ? 'classified' : null;
      return null;
    };
    const guardOf = (handler) => {
      if (handler?.type === 'Identifier') {
        const target = resolve(handler);
        return target.fn ? guardOf(target.fn) : target.imported ? 'imported' : 'bare';
      }
      if (handler?.type === 'CallExpression') return wrapperGuard(handler) ?? 'bare';
      if (!isFunction(handler)) return 'bare';
      if (handler.body.type === 'BlockStatement' && handler.body.body.length === 1 && handler.body.body[0].type === 'TryStatement'
        && handler.body.body[0].handler) return 'classified';
      const body = unwrap(handler.body);
      if (body?.type === 'CallExpression' && body.arguments.some(isFunction)) return wrapperGuard(body) ?? 'bare';
      return 'bare';
    };
    return {
      CallExpression(node) {
        if (isCommandRegister(node)) context.report({ node, messageId: 'handler', data: { guard: guardOf(node.arguments[1]) } });
      },
      ThrowStatement(node) {
        const kind = untypedThrow(node.argument);
        if (kind) context.report({ node, messageId: 'bareThrow', data: { kind } });
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Command handlers must throw classified errors (CommandError / AppError), not bare Error' },
    schema: [{ type: 'object', properties: { baseline: { type: 'boolean' } }, additionalProperties: false }],
    messages: {
      untyped:
        '命令处理函数里直接抛 {{kind}} 会被 kernel 当作统一内部错误（Unknown），丢掉 Rust 的错误分类；'
        + '请 throw new CommandError(<Rust serde 值>) 或 throw AppError.xxx(...)（host/kernel/API.md §2.3）。'
        + '本文件基线 {{baseline}} 处，现在 {{count}} 处。',
    },
  },
  create(context) {
    const useBaseline = context.options[0]?.baseline !== false;
    const sourceCode = context.sourceCode;
    const scanned = new Set();
    const violations = [];

    const children = (node) => {
      const out = [];
      for (const key of sourceCode.visitorKeys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) { for (const item of child) if (item && typeof item.type === 'string') out.push(item); }
        else if (child && typeof child.type === 'string') out.push(child);
      }
      return out;
    };

    /** 函数体里是否有带 catch 的 try：同文件包装函数据此视为“会把错误分类”（commandResult / guard / serviceCall 一类）。 */
    const catches = (fn) => {
      const stack = [fn.body];
      while (stack.length) {
        const node = stack.pop();
        if (node.type === 'TryStatement' && node.handler) return true;
        if (!isFunction(node)) stack.push(...children(node));
      }
      return false;
    };

    /** 回调参数里的 throw 是否会冒到处理函数外：数组/Promise 方法与同文件透传包装会，其他（含跨文件包装）不追踪。 */
    const PROPAGATING_METHODS = new Set(['map', 'forEach', 'filter', 'flatMap', 'reduce', 'some', 'every', 'find', 'findIndex', 'sort', 'then', 'catch', 'finally']);
    const propagates = (call) => {
      const callee = call.callee;
      if (callee.type === 'MemberExpression' && !callee.computed) return PROPAGATING_METHODS.has(callee.property.name);
      if (callee.type !== 'Identifier') return false;
      const wrapper = resolveIdentifier(callee);
      return wrapper !== null && !catches(wrapper);
    };

    /** 只统计会以原值到达 kernel 的 throw：不在带 catch 的 try 块里，也不在会被包装函数接住的回调里。 */
    const scan = (fn) => {
      if (!isFunction(fn) || scanned.has(fn)) return;
      scanned.add(fn);
      const visit = (node, parent) => {
        if (isFunction(node)) {
          if (parent?.type === 'CallExpression' && parent.arguments.includes(node) && propagates(parent)) scan(node);
          return;
        }
        if (node.type === 'ThrowStatement') {
          const kind = untypedThrow(node.argument);
          if (kind) violations.push({ node, kind });
        }
        if (node.type === 'TryStatement' && node.handler) {
          visit(node.handler, node);
          if (node.finalizer) visit(node.finalizer, node);
          return;
        }
        for (const child of children(node)) visit(child, node);
      };
      visit(fn.body, fn);
    };

    /** 同文件内的函数声明 / `const f = () => …`。 */
    const resolveIdentifier = (identifier) => {
      let scope = sourceCode.getScope(identifier);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) {
          for (const def of variable.defs) {
            if (def.node.type === 'FunctionDeclaration') return def.node;
            if (def.node.type === 'VariableDeclarator' && isFunction(def.node.init)) return def.node.init;
          }
          return null;
        }
        scope = scope.upper;
      }
      return null;
    };

    const collect = (handler) => {
      if (!handler) return;
      if (isFunction(handler)) scan(handler);
      else if (handler.type === 'Identifier') scan(resolveIdentifier(handler));
      else if (handler.type === 'CallExpression') {
        if (propagates(handler)) for (const argument of handler.arguments) collect(argument);
      } else if (handler.type === 'TSAsExpression' || handler.type === 'TSSatisfiesExpression' || handler.type === 'TSNonNullExpression') {
        collect(handler.expression);
      }
    };

    return {
      CallExpression(node) {
        if (isCommandRegister(node)) collect(node.arguments[1]);
      },
      'Program:exit'() {
        if (violations.length === 0) return;
        const file = path.relative(REPO_ROOT, context.physicalFilename ?? context.filename).split(path.sep).join('/');
        const baseline = useBaseline ? loadBaseline()[file] ?? 0 : 0;
        if (violations.length <= baseline) return;
        for (const { node, kind } of violations) {
          context.report({ node, messageId: 'untyped', data: { kind: kind === 'Error' ? 'new Error(...)' : '字符串', baseline: String(baseline), count: String(violations.length) } });
        }
      },
    };
  },
};
