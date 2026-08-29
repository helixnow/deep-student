# Anki AI-Native 最终交付就绪度

> 复审日期：2026-08-24
> 分支：`cursor/anki-ai-native-research-bfca`
> PR：[#215](https://github.com/helixnow/deep-student/pull/215)

## 结论

**代码层有条件可交付；PR 尚不可按可发布状态合并。AI-Native 评分 8.5/10，
但未达到完整 SOTA。**

以 PR #215 收尾续作后的现码为审计基线，未发现仍未修复的确定性 Anki 发布阻断
代码缺陷。公开生成参数、transform、analyze 路由、Structured Output、QA、FSRS、
偏好记忆写入/检索和 Sidekick Planner/Generator/Vlm 已进入 ChatAnki 生产路径；
`_original_generation` 已落到首次入库点，遮挡层也已进入折叠/展开生产预览。
critic 的 run/start `enableCriticPass` 也已接通，但缺省 `false`，默认用户路径仍关闭。

需要严格区分三层事实：

1. **模块已实现**不等于运行时已调用；
2. **内核有调用点**不等于 ChatAnki 用户可触达；
3. **公开 opt-in 开关**不等于默认执行；critic 只有显式 `true` 才运行。

建议 **PR 继续保持 Draft**，直到 Backend、Rust Tests、Frontend/Vitest、
Migration Gate、Security Audit 和 Windows Shell Sandbox 等必需检查全部成功。
CI 全绿且没有新增 review blocker 后，可转 Ready for review。

## 现码接线表

| 能力 | 模块实现 | 运行时接线 | ChatAnki 用户可达 | 结论 |
|---|---|---|---|---|
| 29 个专用工具与闭环 | skill manifest、executor | run/wait/get_cards/修改/export/sync、复习管理、APKG 导入 | 是 | **已接线** |
| `plan_route` | LLM 路由规划 + 启发式回退 | `run` 与 `analyze` 共用 `resolve_route_decision`；带资源引用时消费 Planner，失败回退 model2/启发式 | 是 | **已接线** |
| Structured Output | delimiter/json_object/json_schema、provider 转换、失败回退 | 流式请求注入 `response_format`，拒绝时回退 delimiter | 是，`outputProtocol` | **已接线** |
| 确定性 QA | `anki_qa_lint::codes::ALL` 共 **26** 个稳定 code + 文档级重复检测 | 默认执行并把 `_qa_flags` 落卡、预览块展示 | 是，`enableQaPass` | **已接线** |
| FSRS 生成回流 | 用户复习画像、语义干扰与拆卡提示 | `EnhancedAnkiService` 默认注入 | 是，`enableFsrsFeedback` | **已接线** |
| transform ops/script | Rust ops；python/node 硬沙箱、I/O 合同、结构化错误 | dry-run → High 审批 → 逐卡 CAS apply | 是 | **已接线** |
| APKG 媒体往返 | 导入/导出及 `mediaReport` | executor 与预览块均有消费者 | 是 | **已接线** |
| LLM critic | 裁决、CAS、摘要事件、失败降级 | run/start `enableCriticPass` 透传到流式成功收尾条件调用点 | 是；缺省 `false`，仅显式 `true` | **opt-in 已接，默认关闭** |
| grounded critic 参照 | 同文档修正对挖掘、独立预算、lint 门槛 | 新卡首次入库写 `_original_generation`；后续编辑可形成修正对 | 可由 opt-in critic 消费；默认不运行 | **数据链与评审入口已接** |
| 偏好记忆 | extract/consolidate/retrieve ADD-only 逻辑 | extraRequirements、成功编辑/批量编辑、删卡观察 best-effort 写 settings；run/start 检索 | 是；`enablePreferenceMemory` 目前只控制检索 | **读写已接线** |
| Image Occlusion | spec 校验、网格建议、字段协议、overlay | VlmFull 直接图片把文字描述转成 `_occlusion` + tag；折叠/展开预览解析图片并挂载揭罩交互 | 预览可达；无生成参数和编辑入口 | **草稿与预览已接；grounding/编辑未接** |
| Occlusion 图片解析 | URL/asset 直用，VFS 经 `vfs_resolve_resource_refs` 转 data URL | 加载或不可用时在中性占位上保留遮罩，坏 spec 降级普通卡 | 是 | **已接线** |
| Sidekick 角色路由 | Planner/Generator/Critic/Vlm 四角色计划 | Planner、Generator、Vlm 已有生产消费者；Critic 在显式开关后消费 | 自动模式可用；Critic 默认关，路由模式未作为 ChatAnki 参数暴露 | **四角色调用点已接；Critic opt-in** |
| `_original_generation` | 有界幂等写入、读取、分类和修正对构建 | `parse_and_save_card` 首次入库写清理后的 front/back/text，16 KiB 超限降级跳过 | 自动生效 | **已接线** |
| CardForge 清理 | 旧 executor/桥/adapter 与结果回调命令已删除 | headless 只隔离历史工具名；`CardAgent.startGeneration` 仍服务划词制卡 | 现行聊天制卡不经过旧桥 | **死回调已清；共享前端能力保留** |

“critic 已接线”现在包括流式内核调用点、安全写回和 ChatAnki 公开 opt-in 入口；
不代表默认制卡会执行它。普通 run/start 省略 `enableCriticPass` 时仍保持关闭。

## 本轮确定性修复

1. critic 从无版本 UPDATE 改为基于送审快照 `updated_at` 的 CAS，关闭覆盖用户编辑的数据丢失窗口。
2. transform script job 目录和输入/脚本快照在 Unix 上显式限制为 `0700` / `0600`。
3. transform 严格沙箱不再只限制“可写”，同时限制 job 外宿主业务文件读取；正则替换在分配前做增长预算检查。
4. 删除分支重新带入的 5.9 MB 本机 x86-64 `libpdfium.so`；该产物由构建脚本按目标下载，并加入 `.gitignore` 防止再次误提交。
5. 修复新增函数签名后的 Rust 测试调用和 integration fixtures，恢复 test target 编译。
6. 偏好观察从 extraRequirements、成功编辑和删除路径写入本地 settings，并与下次生成检索闭环。
7. `plan_route` 和三条 VLM 图片提取路径分别消费 Planner / Vlm 角色，保留原 model2 降级。
8. 新卡首次入库写入 `_original_generation`，16 KiB 上限或序列化失败不阻断制卡。
9. 无消费者的旧 CardAgent 结果回调已从 handler、重导出、Tauri 注册和权限成组删除。
10. `_occlusion` 已接入折叠和展开的生产卡片预览，VFS/本地/URL 图片均有防御性解析。
11. run/start 已接 `enableCriticPass` 到既有 grounded critic；缺省 `false`，只在用户明确要求时开启。

## 发布阻断项

- **CI 仍是发布门禁。** 本次复核时 PR
  [#215](https://github.com/helixnow/deep-student/pull/215) 的 12 项检查均为
  queued/pending；最终状态以 GitHub required checks 为准，未全绿前不应转为
  可发布/可合并状态。
- 若任一 Backend、Rust test、Migration、Security 或 Windows sandbox 检查失败，应将该失败视为新的发布阻断并先修复。

当前没有已知且未修复的 Anki 代码 blocker。

## 非阻断项

- Image Occlusion 已有启发式草稿和生产预览；PDF 页图、真实视觉 grounding、
  遮挡编辑器及 APKG/AnkiConnect 可复习遮挡转换仍未闭环。
- ChatAnki run/start 已有 `enableCriticPass`，但缺省 `false`；因此 grounded critic
  虽可由用户明确要求触发，默认产品入口仍不会运行。
- 历史卡和原文快照超过 16 KiB 的卡仍可能没有 grounded 参照，critic 启用时会按设计回退规则 rubric。
- transform script 缺少跨平台统一的进程树内存配额；现有 CPU/进程/文件/输出/超时限制和高风险审批仍保留。
- 旧 CardAgent 结果回调命令已在收尾续作 #6 成组删除（handler、导出、注册、权限），
  并由源码守卫防止重新注册；headless 仍显式隔离历史工具名，避免旧会话挂起。

这些项目限制完整 SOTA 闭环，但不破坏当前默认制卡、验收、导出或复习路径。

## AI-Native 最终评分

**8.5 / 10。**

| 维度 | 评分 | 依据 |
|---|---:|---|
| Agent 编排 | 9/10 | 29 个 ChatAnki 工具、版本化修改、wait/get_cards 验收和 export/sync 闭环 |
| 内容理解 | 8/10 | 文本 + VLM 路由已生产化；真实图像 grounding 仍缺 |
| 流程决策 | 9/10 | LLM `plan_route` 与 analyze 同源并消费 Planner，启发式/model2 为降级 |
| Script-native | 9/10 | ops + python/node 硬沙箱、dry-run、结构化错误和 CAS |
| 质量保障 | 8/10 | Structured Output、26 个稳定 lint code、跨段查重、eval、grounded 数据链与 opt-in critic；critic 默认不运行 |
| 个性化 | 8/10 | FSRS 默认回流；偏好观察已持久化并在后续生成检索注入 |

六个维度等权平均为 8.5。相较 Round 5 的 8.0，流程决策因 Planner/Vlm 消费提升，
个性化因偏好读写闭环提升；公开但默认关闭的 critic 开关不单独上调质量保障。
完整图像遮挡仍是实质缺口。

## 验证快照

- `cargo check --lib`：通过。
- `npm run typecheck`：通过。
- 聚焦 Vitest（skill 参数/schema、analyze、QA/media、occlusion）：6 files / 58 tests 通过。
- `git diff --check origin/main...HEAD`：通过。
- PR required checks：本文生成时仍为 pending，最终以 GitHub CI 为准。
