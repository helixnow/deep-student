# 收尾续作 #8：Anki AI-Native SOTA 状态

> 日期：2026-08-24
> 分支：`cursor/anki-ai-native-research-bfca`
> PR：[#215](https://github.com/helixnow/deep-student/pull/215)

## 结论

**当前评分 8.5/10，属于成熟的 AI-Native 生产内核，但尚未达到完整 SOTA。**

这里的“SOTA”是本调研定义的工程目标，不是未经外部盲测证明的行业绝对排名。
本轮只按仓库现码判断模块、运行时调用和用户入口，不把设计文档、纯函数、测试
fixture 或默认不可达的条件分支算成完整产品能力。

## 状态口径

- **已接线**：真实生产入口可到达，且数据能流到最终消费者。
- **条件接线**：运行时调用点存在，但默认开关、数据或入口条件使主路径不可达。
- **部分接线**：只完成闭环中的一段，不能独立交付所宣称的完整能力。
- **未接线**：只有模块/组件/协议，没有生产调用者。

## SOTA 能力矩阵

| 维度 | 现码事实 | 状态 | 分数 |
|---|---|---|---:|
| Agent 编排 | 29 个 ChatAnki 工具覆盖生成、等待、验收、版本化修改、transform/retemplate、导出/同步、APKG 与复习管理 | **已接线** | 9/10 |
| 内容理解 | 文本与 VLM 路由、直接图片提取、Structured Output 和遮挡预览已生产化；遮挡坐标仍由文字描述生成网格框，不是真实视觉定位 | **主链已接，grounding 部分接线** | 8/10 |
| 流程决策 | `plan_route` 与 analyze 同源；Planner、Generator、Vlm 都有生产消费者，失败回退 model2/启发式 | **已接线** | 9/10 |
| Script-native | transform ops + python/node 硬沙箱，支持 dry-run、High 审批、结构化错误、逐卡 CAS | **已接线** | 9/10 |
| 质量保障 | 26 个稳定 QA code、跨段重复检测、eval、首次生成快照和 grounded critic 数据链已实现；ChatAnki 无 critic 开关 | **确定性链已接；critic 条件接线** | 8/10 |
| 个性化 | FSRS 画像默认回流；extraRequirements、成功编辑/批量编辑和删卡观察写入偏好 store，后续 run/start 检索注入 | **已接线** | 8/10 |

六维等权平均：`(9 + 8 + 9 + 9 + 8 + 8) / 6 = 8.5`。

## 已接线

1. **结构化生成**：delimiter / json_object / json_schema 自适应，供应商拒绝结构化
   输出时在解析前回退 delimiter。
2. **确定性质检**：`anki_qa_lint::codes::ALL` 为 26 个稳定 code；`_qa_flags`
   随卡落库并在预览块展示，FingerprintTracker 做文档级重复/近重复检查。
3. **模型角色路由**：
   - Planner → `plan_route`；
   - Generator → `StreamingAnkiService::get_configurations`；
   - Vlm → vlm_light、vlm_full 和纯图片升级的三条图片提取路径；
   - Critic → `run_critic_pass` 的条件调用路径。
4. **偏好记忆读写**：观察经过 extract/consolidate 后 best-effort 写入
   `chatanki_preference_memory_store`；损坏 store 不会被空值覆盖，失败不回滚主操作。
5. **grounded 数据生产**：新卡首次入库时幂等写
   `_original_generation={front,back,text?}`，UTF-8 JSON 上限 16 KiB；后续编辑可形成
   同文档修正对。
6. **Script-native 变换**：脚本看见无截断 DB 快照，网络恒禁，输出白名单校验，
   apply 只认 Rust 快照版本并逐卡 CAS。
7. **兼容面收口**：无消费者的 `chat_v2_anki_cards_result` 已从 handler、导出、
   Tauri 注册和权限删除；仍有真实消费者的 `CardAgent.startGeneration` 与导出校验保留。
8. **遮挡预览**：折叠和展开的 `anki_cards` 块会解析 `_occlusion`，解析
   URL/本地/VFS 图片并挂载 `ImageOcclusionOverlay`；坏 spec 或图片不可用安全降级。

## 条件接线或部分接线

### LLM critic

流式收尾、Critic 角色选择、prompt 数据边界、失败降级、card-id 白名单和
`updated_at` CAS 都已接；新卡也能生产 grounded 快照。

但 `chatanki_run` / `chatanki_start` schema 没有 critic 参数，
`build_generation_options` 把 `enable_critic_pass` / `enable_llm_critic` 都写为
`None`。因此当前 ChatAnki 用户路径不会运行 critic，不能写成用户可选终审。

### Image Occlusion

VlmFull 直接图片路径会把 `[IMAGE_DESC]` 文字标签转换为启发式网格 spec，并把
`_occlusion` 与 `image-occlusion` tag 附到分段首张成功卡。该路径：

- 不读取真实图像实体坐标；
- 不支持 PDF 页图引用；
- 不改写 front/back/text；
- 已接生产预览，但没有遮挡框编辑器；
- 不把候选 Cloze 字段或图片媒体接入 APKG/AnkiConnect 导出。

所以它是可持久化、可预览的草稿协议，不是完整遮挡制卡。

## 未接线或仍缺

- ChatAnki critic 公开开关、预算和用户可见结果入口。
- Image Occlusion 的视觉 grounding、PDF 页图、遮挡编辑器和可复习 Anki 导出闭环。
- `sidekick_model_routing=single|auto` 的 ChatAnki 公开参数；当前自动模式已工作。
- transform script 跨平台统一的进程树内存配额。
- 基于线上学习结果自动回归/提升策略；当前 FSRS 与偏好回流是确定性提示注入，
  不是在线训练。

## 发布判断

上述缺口阻止“完整 SOTA”结论，但不阻断默认制卡、验收、修改、导出或复习路径。
PR 是否可合并仍以 required CI 全绿和无新增 review blocker 为前提；能力评分不能
替代发布门禁。
