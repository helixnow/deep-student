# Wave2-A R9 #7 —「只写不读」字段最后一扫

基线：`dd300cd3`。本席只做静态 `rg` / 源码对拍；未运行 npm、cargo、安装或测试，未改产品代码。

## 结论表

| 对象 | 写入点 | 读取 / 消费证据 | 结论 |
|---|---|---|---|
| `ToolFacePrefixSnapshot::{generation, order, schema_digest}` / `ToolFaceBaseline` | `multi_variant.rs:1922-1926` 写变体快照；`helpers.rs:1198-1209` 推进会话基线；`repo.rs:3140-3152` 写三键 metadata | `multi_variant.rs:597-602,2863-2868,3016-3017` 三个 join 点读取 `VariantMeta.tool_face_prefix`；`helpers.rs:1167-1187` 读取 `order` 与 `schema_digest` 做收敛；`repo.rs:138-153,3111-3123` 回读并合并 `generation` / digest。`schema_digest` 的 `serde(default, skip_serializing_if)` 仅保证旧数据兼容，不妨碍这些生产读路径 | **仍有读路径** |
| `SkillInjectionAnchors.skill_content_digests` | `tool_loop.rs:732-734,1982-2008` 在 turn/tool 两类锚点写 digest | `types.rs:1180-1182` 的 `content_digest_for` 查 map；`history.rs:913-925` 在重放门禁比较当前正文 digest，漂移时 skip 并发信号 | **仍有读路径** |
| `SkillInjectionAnchors.skill_content_rev` | 生产路径无非 `None` 写点；只有 `types.rs:4455-4469` serde 往返测试构造 `Some(7)` | `types.rs:4426` 验证旧 JSON 缺字段回读为 `None`，`:4468-4469` 验证新字段 serde 回读。当前无生产语义消费，但它是 `default + skip_serializing_if` 的可选兼容保留位，不属于“赋值后丢弃”的热路径字段，本轮不建议删除 | **仍有读路径** |
| metadata `toolFacePrefixGeneration` / `toolSchemaDigest` | `repo.rs:3140-3152` 与 `frozenToolSchemaOrder` 同事务写入 | `repo.rs:138-145` 从 metadata 合成快照，`:3111-3123` 在 advance 前读取旧 generation/digest；随后由 `helpers.rs:1087-1114` 恢复内存基线 | **仍有读路径** |
| metadata `availableSkillsSnapshotGeneration` / `availableSkillsSnapshotPendingGeneration` | `repo.rs:2900-2904` 兑现 pending；`:2962-2966` 声明 pending | 后端 `repo.rs:2873-2904,2946-2952` 读取、门控覆盖并清 pending；前端 `TauriAdapter.ts:3807-3814,5439-5486` 读取 generation/pending、重生成目录并兑现新代 | **仍有读路径** |
| `llm_usage_logs.variant_id` / `run_id`（连同真实 `session_id`） | `model2_pipeline.rs:6113-6125` 拆事件身份；`llm_usage/{collector,repo}.rs` 三条 INSERT 分列写入 | Rust 回读：`llm_usage/repo.rs:449-499`；报告回读：`cache-hit-report.py:125-138` SELECT 两列，`:246-272` 用 variant 构造 stream key，`:395-448` 用 run 做每会话 run 计数。`run_id` 刻意不参与 cold/steady key，不等于未读 | **仍有读路径** |
| `CHAT_V2_CACHE_DEBUG` 四段指纹 / `first_divergent_segment` | `model2_pipeline.rs:4902-4904` 对 post-adapter body 采样；`:3368` 写进程内上一请求指纹 | `model2_pipeline.rs:3359-3363` 在下一请求比较旧指纹，`:3372-3380` 输出四段与首分叉段。它不落 `llm_usage`、`cache-hit-report.py` 也不读，边界就是 opt-in debug 日志而非报表 schema | **只写但有意（观测）** |
| `AvailableSkillsDelta.baseSkillIds` | `progressiveDisclosure.ts:789-802` 先用本地 `Set` 过滤新增技能，再把数组写进返回对象 | 全仓仅定义与该返回写点；消费者 `generateAvailableSkillsDeltaPrompt`（`:816-827`）只读 `delta.added`。注意本地 `baseSkillIds: Set` 在 `:795` 有真实用途，冗余的只是返回对象字段 | **真只写建议下轮删** |

## 扫尾裁决

- 点名的 digest、pending-generation、llm identity 列均不是只写字段。
- `CHAT_V2_CACHE_DEBUG` 的终点有意是 debug log，不应为迎合报表而扩数据库列。
- 唯一建议下轮删除的是非序列化的 `AvailableSkillsDelta.baseSkillIds` 返回属性；保留函数内用于差集计算的 `Set`。
- 未建议删除任何 serde 兼容字段。已知 P8 `ToolAdmission.approval_arguments` 已删除，本轮未重复提出。
