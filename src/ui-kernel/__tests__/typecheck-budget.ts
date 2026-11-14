/**
 * 仅用于 TypeScript 编译契约，不是 UI 或业务性能预算。
 * Linux 原生 Node 单 worker 实测一次完整 clean 约 234s（建图 28.002s + 诊断 205.500s）：
 * 根工作区 .reports/takeover/linux-typecheck-direct.json。保留完整检查并以 600s 限制异常长跑。
 */
export const TYPE_CONTRACT_TIMEOUT_MS = 600_000;

/**
 * typecheck-helper 自身回归用例：每例在独立 Node 子进程里加载 TypeScript 并编译小夹具。
 * Linux 单 worker 实测每例约 2.9–5.0s（H-prep，a3e57abd），超过 Vitest 默认 5s。
 */
export const TYPE_HELPER_TIMEOUT_MS = 60_000;
