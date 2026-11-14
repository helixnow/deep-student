# 派发：P4-mobile-proto（移动端原型“学习伴侣”，第二阶段草稿）

你是 **P4-mobile-proto** 的负责代理。定位与路线已在 2026-11-07 决定（`ASSAULT-PLAN.md` §6）：学习伴侣（对话、笔记、刷题、Anki/FSRS 复习、与桌面同步）；
Capacitor 外壳加载同一套 React 前端；移动端桥实现与桌面 preload 相同的 `invoke` / `listen`；host 跑在 Web Worker 里，用 `messagePortTransport`；
`host/profiles/mobile.json` 只装配可移植插件。协议见 `WORKER.md`，计划见 `../RESUME-PLAN.md` §2.8。

## 本 lane

| 项 | 内容 |
|---|---|
| 负责路径 | `mobile/`、`docs/dev/mobile/`（以处置表为准） |
| 工作包 | WP2-080、WP2-081（与 F7）、WP2-082、WP2-083 |
| 依赖 | WP2-080/081 无前置，可先做；WP2-082 依赖 FE-A5、FE-C1 a–d 子包、WP2-040 |

## 目标（按顺序）

1. SQLite 接入方式：原生插件与 Worker 内 SQLite WASM + OPFS 各跑同一组 storage 一致性测试，给出通过数与性能数据，结论写入 DECISIONS（C1 裁定）。
2. WASM 模块（Argon2、FSRS、分词器）在 WebView / Worker 内可用（无头 Chromium Worker 测试）。
3. 外壳与桥：启动到首个 App 的冒烟；与桌面同步往返一次。
4. 低端安卓启动时间与内存：先模拟器出数，真机由用户安排。

## 验收（只认机器结果）

- 测试与基准的 job id、passed/failed、数值；冒烟脚本 exit 0。
- 不以截图或文字描述作为完成证据。

## 不做

- 不改 `host/plugins/**`、`src/**`（缺什么写进报告，由 C1 转派 P2 / P6 / U1）；不为移动端改变桌面行为。
- 不引入 npm 依赖（Capacitor 等依赖的引入由主 agent 统一批准）。

## 首次启动

本 lane 第一次由 `oc-dispatch launch` 启动时，只确认起点：`git merge --no-edit main`，经作业队列跑本 lane 路径下的类型检查与测试，
回复一行起点结果（main sha、job id、passed/failed）后结束本轮。不要自选工作；工作包由 C1 用 `coord.mjs assign` 派发（新会话），按 `WORKER.md` 执行与交付。
