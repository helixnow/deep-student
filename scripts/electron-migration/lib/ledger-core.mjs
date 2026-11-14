// ledger 计算（纯函数，输入全部由 ledger.mjs 采集）。等级定义见 README §5.1，只依据可计算的证据，
// 不读取任何 lane 自述的"完成"状态：
//
// 命令（按 lane + 命令名，cfg 变体合并为一条）
//   A 迁移跑通：某插件 meta.commands 声明 ∧ 静态可见的 ctx.commands.register（字面量，或动态注册且命令名
//      出现在同插件的处理函数表键中）∧ 契约中存在 ∧ 声明/注册文件无边界违规 ∧ 未被多个插件重复声明
//      ∧（提供 kernel 覆盖报告时）未列入 declaredNotRegistered / unknown；dead-proven 经批准视同完成。
//   B 拆成两个主指标（旧 B 保留为兼容字段 = A ∧ B-doc，不再作为主指标）：
//   B-test 代码完成：A ∧ 对应测试在 vitest 报告里全过。对应测试 = 同 lane、Rust 源文件与命令定义文件相同的
//      真实 TESTMAP 行（逐行须为测试 B 级）；该文件没有 Rust 测试时退到整个 lane 的真实测试。无报告即不成立。
//   B-doc 文档勾选：SPEC 中该命令一节与"全局语义"一节清单全部勾选 ∧ lane 的 ACCEPTANCE.md 存在且无未勾选项（不看代码）。
//   C 动态验证：录制回放结果为 pass（F6 产出，提供 --golden 时）。
// 测试（TESTMAP 每行）
//   A：`ported:<ts>` 文件存在、是测试文件、含 Rust 测试名、且未被 X6 prod-reachable 判为 unreachable；`merged:<目标>` 目标存在（含用例名时须出现）；
//      `obsolete` 须在 migration/approvals.json 中批准。
//   B：A ∧ vitest JSON 报告中对应用例全部通过（obsolete 批准即 B）。
//   C：不适用（动态验证以命令/场景为单位）。
import { STATUS_RE } from './docs-model.mjs';

function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

function assertionsFor(vitest, file, needle) {
  const list = vitest?.get(file) ?? [];
  return needle ? list.filter((a) => a.title.includes(needle) || a.fullName.includes(needle)) : list;
}

export function evaluateTest(t, status, ctx) {
  const res = { id: t.id, lane: t.lane, status, A: false, B: false, problem: null };
  if (!t.real) {
    res.A = res.B = true;
    res.status = `n/a:${t.kind}`;
    return res;
  }
  if (!STATUS_RE.test(status)) {
    res.problem = `无效去向 "${status}"`;
    return res;
  }
  const [kind, ...restParts] = status.split(':');
  const rest = restParts.join(':').trim();
  if (kind === 'pending') return res;
  if (kind === 'obsolete') {
    const ok = Object.prototype.hasOwnProperty.call(ctx.approvals.obsolete ?? {}, t.id);
    res.A = res.B = ok;
    if (!ok) res.problem = 'obsolete 未在 migration/approvals.json 批准';
    return res;
  }
  let file;
  let needle;
  if (kind === 'ported') {
    file = rest;
    needle = t.name;
  } else {
    const idx = rest.indexOf('::');
    file = idx >= 0 ? rest.slice(0, idx) : rest;
    needle = idx >= 0 ? rest.slice(idx + 2) : null;
  }
  if (!ctx.fileExists(file)) {
    res.problem = `${kind} 目标不存在：${file}`;
    return res;
  }
  if (kind === 'ported' && !ctx.isTestFile(file)) {
    res.problem = `ported 目标不是测试文件：${file}`;
    return res;
  }
  if (needle && !ctx.fileText(file).includes(needle)) {
    res.problem = `${file} 中找不到 "${needle}"`;
    return res;
  }
  if (kind === 'ported' && ctx.unwired?.has(file)) {
    // 测试存在且断言对应，但被测模块没有生产调用方：不计 A，单独统计（不算问题，不阻塞）。
    res.unwired = true;
    return res;
  }
  if (kind === 'ported' && ctx.unreachable?.has(t.id)) {
    // X6 prod-reachable 静态证明该用例所测符号从任何插件 register/provide 都不可达（架构师裁定 2026-11-04）：
    // 否决 A，单独统计。`unknown`（无法证明）不在此集合中，不降级。
    res.unreachable = true;
    return res;
  }
  res.A = true;
  if (ctx.vitest) {
    const as = assertionsFor(ctx.vitest, file, needle);
    res.B = as.length > 0 && as.every((a) => a.status === 'passed');
    if (!as.length) res.problem = `vitest 报告中没有 ${file}${needle ? ` 的 "${needle}"` : ''} 用例`;
    else if (!res.B) res.problem = `${file} 的对应用例未全部通过`;
  }
  return res;
}

const rustFileOf = (t) => t.file ?? t.id.split('::')[0];

/** 命令对应的测试：同 lane 同 Rust 文件的真实 TESTMAP 行；没有时退到整个 lane。 */
function mappedTests(lane, defs, ctx) {
  const byFile = defs.flatMap((d) => ctx.testsByLaneFile?.get(`${lane}\u0000${d.file}`) ?? []);
  if (byFile.length) return { tests: [...new Set(byFile)], scope: 'file' };
  return { tests: ctx.testsByLane?.get(lane) ?? [], scope: 'lane' };
}

export function evaluateCommand(lane, name, defs, ctx) {
  const declared = ctx.declared.get(name) ?? [];
  const registered = ctx.registered.get(name) ?? [];
  const dead = Object.prototype.hasOwnProperty.call(ctx.approvals.deadProven ?? {}, name);
  const files = [...new Set([...declared.map((d) => d.file), ...registered.map((r) => r.file)])];
  const dirtyFiles = files.filter((f) => (ctx.violationsByFile.get(f) ?? 0) > 0);
  const contract = ctx.contracts ? ctx.contracts.has(name) : false;
  const cov = ctx.coverage;
  const covProblem = cov
    ? [...(cov.declaredNotRegistered ?? []).filter((x) => x.command === name).map((x) => `kernel: ${x.plugin} 声明但未注册`),
       ...(cov.unknown ?? []).filter((x) => x.command === name).map((x) => `kernel: ${x.plugin} 声明的命令不在契约中`)]
    : [];
  const problems = [];
  if (declared.length > 1) problems.push(`被多个插件声明：${declared.map((d) => d.plugin).join(', ')}`);
  const misLane = declared.filter((d) => d.lane && d.lane !== lane);
  if (misLane.length) problems.push(`由其他 lane 的插件声明：${misLane.map((d) => `${d.plugin}(${d.lane})`).join(', ')}`);
  if (declared.length && !registered.length) problems.push('已声明但静态未见注册');
  if (registered.length && !declared.length) problems.push('已注册但未在 meta.commands 声明');
  if (dirtyFiles.length) problems.push(`边界违规：${dirtyFiles.join(', ')}`);
  problems.push(...covProblem);
  const evidence = {
    declared: declared.length > 0,
    registered: registered.length > 0 ? (registered.every((r) => r.kind === 'literal') ? 'literal' : 'dynamic') : false,
    contract,
    clean: files.length > 0 && dirtyFiles.length === 0,
    single: declared.length <= 1,
    kernel: cov ? covProblem.length === 0 : null,
  };
  const A = dead || (evidence.declared && evidence.registered !== false && contract && evidence.clean && evidence.single && misLane.length === 0 && evidence.kernel !== false);
  const spec = ctx.spec(lane, `cmd:${name}`);
  const global = ctx.spec(lane, 'spec:global');
  const review = ctx.review(lane);
  const specDone = Boolean(spec && spec.total > 0 && spec.checked === spec.total && global && global.total > 0 && global.checked === global.total);
  const BDoc = dead || (specDone && review.ok);
  const B = dead || (A && BDoc);
  const mapped = mappedTests(lane, defs, ctx);
  const testsPassed = mapped.tests.filter((t) => t.B).length;
  const BTest = dead || Boolean(A && ctx.vitest && mapped.tests.length > 0 && testsPassed === mapped.tests.length);
  const g = ctx.golden?.get(name) ?? null;
  const C = dead || g === 'pass';
  return {
    lane,
    name,
    defs: defs.map((d) => `${d.file}:${d.line}`),
    frontend: defs[0].frontend,
    deadProven: dead,
    A,
    B,
    BTest,
    BDoc,
    C,
    evidence: {
      ...evidence,
      spec: spec ? `${spec.checked}/${spec.total}` : null,
      review: review.state,
      tests: mapped.tests.length ? `${testsPassed}/${mapped.tests.length} ${mapped.scope}` : null,
      golden: g,
    },
    problems,
  };
}

export function computeLedger(input) {
  const ctx = input;
  const groups = new Map();
  for (const c of input.commands) {
    const key = `${c.lane}\u0000${c.name}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(c);
  }
  const tests = input.tests.map((t) => evaluateTest(t, input.statuses.get(t.id) ?? 'pending', ctx));
  const testsByLaneFile = new Map();
  const testsByLane = new Map();
  input.tests.forEach((row, i) => {
    if (!row.real) return;
    const fileKey = `${row.lane}\u0000${rustFileOf(row)}`;
    (testsByLaneFile.get(fileKey) ?? testsByLaneFile.set(fileKey, []).get(fileKey)).push(tests[i]);
    (testsByLane.get(row.lane) ?? testsByLane.set(row.lane, []).get(row.lane)).push(tests[i]);
  });
  const commandCtx = { ...ctx, testsByLaneFile, testsByLane };
  const commands = [...groups.entries()]
    .map(([key, defs]) => evaluateCommand(key.split('\u0000')[0], defs[0].name, defs, commandCtx))
    .sort((a, b) => a.lane.localeCompare(b.lane) || a.name.localeCompare(b.name));

  const lanes = {};
  const empty = () => ({ commands: 0, cmdA: 0, cmdB: 0, cmdBTest: 0, cmdBDoc: 0, cmdC: 0, tests: 0, testA: 0, testB: 0, testUnreachable: 0 });
  const bump = (lane) => (lanes[lane] ??= empty());
  for (const c of commands) {
    const l = bump(c.lane);
    l.commands++;
    l.cmdA += c.A ? 1 : 0;
    l.cmdB += c.B ? 1 : 0;
    l.cmdBTest += c.BTest ? 1 : 0;
    l.cmdBDoc += c.BDoc ? 1 : 0;
    l.cmdC += c.C ? 1 : 0;
  }
  for (const t of tests) {
    const l = bump(t.lane);
    l.tests++;
    l.testA += t.A ? 1 : 0;
    l.testB += t.B ? 1 : 0;
    l.testUnreachable += t.unreachable ? 1 : 0;
  }
  const global = empty();
  for (const l of Object.values(lanes)) for (const k of Object.keys(global)) global[k] += l[k];
  const withPct = (l) => ({ ...l, pctCmdA: pct(l.cmdA, l.commands), pctCmdB: pct(l.cmdB, l.commands), pctCmdBTest: pct(l.cmdBTest, l.commands), pctCmdBDoc: pct(l.cmdBDoc, l.commands), pctCmdC: pct(l.cmdC, l.commands), pctTestA: pct(l.testA, l.tests), pctTestB: pct(l.testB, l.tests) });
  return {
    summary: { global: withPct(global), lanes: Object.fromEntries(Object.entries(lanes).sort().map(([k, v]) => [k, withPct(v)])) },
    commands,
    tests,
    problems: {
      commands: commands.filter((c) => c.problems.length).map((c) => ({ lane: c.lane, name: c.name, problems: c.problems })),
      tests: tests.filter((t) => t.problem).map((t) => ({ id: t.id, lane: t.lane, status: t.status, problem: t.problem })),
      undeclaredRegistrations: input.orphanRegistrations ?? [],
    },
  };
}
