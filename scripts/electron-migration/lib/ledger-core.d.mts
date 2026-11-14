export interface TestRow { id: string; lane: string; real: boolean; kind: string; name: string | null; file?: string; line?: number }
export interface InventoryCommand { name: string; file: string; line: number; lane: string; frontend: string }
export interface LedgerContext {
  approvals: { obsolete?: Record<string, string>; deadProven?: Record<string, string> };
  fileExists(p: string): boolean;
  fileText(p: string): string;
  isTestFile(p: string): boolean;
  vitest: Map<string, { title: string; fullName: string; status: string }[]> | null;
  declared: Map<string, { plugin: string; file: string; lane: string | null }[]>;
  registered: Map<string, { file: string; kind: 'literal' | 'dynamic' }[]>;
  contracts: Set<string> | null;
  violationsByFile: Map<string, number>;
  coverage: { declaredNotRegistered?: { plugin: string; command: string }[]; unknown?: { plugin: string; command: string }[] } | null;
  spec(lane: string, key: string): { checked: number; total: number } | null;
  review(lane: string): { ok: boolean; state: string };
  golden: Map<string, string> | null;
  /** 被测文件无生产调用方（wiring.mjs）的 ported 测试文件。 */
  unwired?: Set<string>;
  /** X6 prod-reachable 判为 unreachable 的 TESTMAP 行 id（unknown 不在内）。 */
  unreachable?: Set<string>;
  /** computeLedger 内部填充：`lane\u0000rustFile` / lane → 测试结果。 */
  testsByLaneFile?: Map<string, TestResult[]>;
  testsByLane?: Map<string, TestResult[]>;
}
export interface TestResult { id: string; lane: string; status: string; A: boolean; B: boolean; problem: string | null; unwired?: boolean; unreachable?: boolean }
export interface CommandResult {
  lane: string; name: string; defs: string[]; frontend: string; deadProven: boolean; A: boolean;
  /** 兼容字段：A ∧ BDoc。主指标为 BTest / BDoc。 */
  B: boolean;
  /** 代码完成：A ∧ 对应测试（同文件，否则同 lane）在 vitest 报告里全过。 */
  BTest: boolean;
  /** 文档勾选：SPEC 两节全勾 ∧ ACCEPTANCE 无未勾选项。 */
  BDoc: boolean;
  C: boolean; evidence: Record<string, unknown>; problems: string[];
}
export function evaluateTest(t: TestRow, status: string, ctx: LedgerContext): TestResult;
export function evaluateCommand(lane: string, name: string, defs: InventoryCommand[], ctx: LedgerContext): CommandResult;
export function computeLedger(input: LedgerContext & { commands: InventoryCommand[]; tests: TestRow[]; statuses: Map<string, string>; orphanRegistrations?: string[] }): {
  summary: { global: Record<string, number>; lanes: Record<string, Record<string, number>> };
  commands: CommandResult[];
  tests: TestResult[];
  problems: { commands: { lane: string; name: string; problems: string[] }[]; tests: { id: string; problem: string | null }[]; undeclaredRegistrations: string[] };
};
