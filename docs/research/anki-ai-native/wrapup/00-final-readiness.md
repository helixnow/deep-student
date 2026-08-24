# Anki AI-Native 最终交付就绪度

> 复审日期：2026-08-24
> 分支：`cursor/anki-ai-native-research-bfca`
> PR：[#215](https://github.com/helixnow/deep-student/pull/215)

## 结论

**有条件可交付，但尚不应按可发布状态合并。**

独立复审未发现仍未修复的确定性 Anki 发布阻断代码缺陷。生成参数、transform
脚本错误路径、analyze 路由和 critic 开关/写回均已进入预期生产路径；本轮发现的
误提交 PDFium 二进制也已移除。当前唯一发布门禁是 PR 必需 CI 尚未全部完成。

建议 **PR 继续保持 Draft**，直到 Backend、Rust Tests、Frontend/Vitest、
Migration Gate、Security Audit 和 Windows Shell Sandbox 等必需检查全部成功。
CI 全绿且没有新增 review blocker 后，可转 Ready for review。

## 指定路径抽查

| 检查项 | 代码事实 | 结论 |
|---|---|---|
| `chatanki_run` / `start` 新参数 | skill schema 与 Rust args 字段集合一致；参数经 `ChatAnkiGenerationTuning` → `BackgroundParams` → `build_generation_options` 传递。`visualHint` / `maxImages` 只用于 run 的 VLM 路径；start 明确置空 | 通过 |
| 输出协议 / QA / FSRS / 偏好 | `outputProtocol` 启动前校验；`enableQaPass`、`enableFsrsFeedback` 写入任务 options；`enablePreferenceMemory` 控制 settings 检索；`contentFormat` 同时控制段落归一和生成参数 | 通过 |
| transform script 错误路径 | 无窗口、无沙箱、无解释器、setup、超时、非零退出、缺输出、超大/非法输出均返回结构化结果；失败路径不写库。apply 仍逐卡 CAS | 通过 |
| `chatanki_analyze` 同源 | analyze 与实际管线共同调用 `resolve_route_decision`，优先级均为 forced > 高置信度 LLM > 启发式；生成旋钮常量也复用同一辅助函数 | 通过 |
| critic 默认关闭 | options 缺失或解析失败均为 false；ChatAnki 构造显式写 `None`；流式收尾仅在 `critic_enabled()` 时运行 | 通过 |
| critic 数据保护 | 模型调用前快照的 `updated_at` 用于 library CAS；用户中途编辑、删除或版本变化时跳过写回，不覆盖新内容 | 通过 |

## 本轮确定性修复

1. critic 从无版本 UPDATE 改为基于送审快照 `updated_at` 的 CAS，关闭覆盖用户编辑的数据丢失窗口。
2. transform script job 目录和输入/脚本快照在 Unix 上显式限制为 `0700` / `0600`。
3. transform 严格沙箱不再只限制“可写”，同时限制 job 外宿主业务文件读取；正则替换在分配前做增长预算检查。
4. 删除分支重新带入的 5.9 MB 本机 x86-64 `libpdfium.so`；该产物由构建脚本按目标下载，并加入 `.gitignore` 防止再次误提交。
5. 修复新增函数签名后的 Rust 测试调用和 integration fixtures，恢复 test target 编译。

## 发布阻断项

- **PR 必需 CI 仍在运行。** 本文生成时 12 项检查均为 pending；在完整平台矩阵给出结果前，不应转为可发布/可合并状态。
- 若任一 Backend、Rust test、Migration、Security 或 Windows sandbox 检查失败，应将该失败视为新的发布阻断并先修复。

当前没有已知且未修复的 Anki 代码 blocker。

## 非阻断项

- 偏好记忆只有 retrieve 注入，生产写入侧尚未接；全新安装通常是 no-op。
- Image Occlusion 目前是 VlmFull 直接图片的启发式草稿；PDF 页图、真实视觉 grounding、预览/编辑和原生 note type 仍未闭环。
- Sidekick 已消费 Generator / Critic；Planner / Vlm 角色仍没有生产消费者。
- grounded critic 依赖可用的 `_original_generation` 修正历史；数据不足时按设计回退规则 rubric，且 critic 默认关闭。
- transform script 缺少跨平台统一的进程树内存配额；现有 CPU/进程/文件/输出/超时限制和高风险审批仍保留。
- 旧 CardAgent 结果回调命令已在收尾续作 #6 成组删除（handler、导出、注册、权限），
  并由源码守卫防止重新注册；headless 仍显式隔离历史工具名，避免旧会话挂起。

这些项目限制完整 SOTA 闭环，但不破坏当前默认制卡、验收、导出或复习路径。

## AI-Native 最终评分

**8.0 / 10。**

| 维度 | 评分 | 依据 |
|---|---:|---|
| Agent 编排 | 9/10 | 29 个 ChatAnki 工具、版本化修改、wait/get_cards 验收和 export/sync 闭环 |
| 内容理解 | 8/10 | 文本 + VLM 路由已生产化；真实图像 grounding 仍缺 |
| 流程决策 | 8/10 | LLM `plan_route` 与 analyze 同源，启发式仅作回退 |
| Script-native | 9/10 | ops + python/node 硬沙箱、dry-run、结构化错误和 CAS |
| 质量保障 | 8/10 | Structured Output、25 规则 lint、跨段查重、eval、opt-in grounded critic |
| 个性化 | 6/10 | FSRS 回流默认开启，但偏好记忆写入闭环缺失 |

评分保持 8.0 而不继续上调：本分支已把 script-native、结构化输出、质检、
路由和 FSRS 回流从设计变成生产能力；但偏好写入、完整图像遮挡、Planner/Vlm
分槽和 grounded 数据可用性仍是实质缺口。

## 验证快照

- `cargo check --lib`：通过。
- `npm run typecheck`：通过。
- 聚焦 Vitest（skill 参数/schema、analyze、QA/media、occlusion）：6 files / 58 tests 通过。
- `git diff --check origin/main...HEAD`：通过。
- PR required checks：本文生成时仍为 pending，最终以 GitHub CI 为准。
