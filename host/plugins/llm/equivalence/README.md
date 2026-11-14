# WP-239 L02 命令语料（WAVE0 §3 v0）

覆盖清单 `board/corpus/WP-239-L02-llm-manager.md` 的 16 条命令，另按 brief 给 `save_model_assignments` 补错误场景。
本目录语料**未运行 A/B、未计 C**；`normalize` 全部为 `[]`，没有手写 expected，`expect:"error"` 只是注释，以 A 实际结果为准。
翻译命令（`translate_text_stream`、`stream_chat_translation_*`、`ocr_extract_text`）归 `host/plugins/translation/`，按 brief 范围一并放在本目录。

| 文件 | 命令（`commands` 字段） | 场景数 |
|---|---|---|
| config-store.json | get_api_configurations、get_model_assignments、get_model_profiles、get_vendor_configs、save_model_profiles、save_vendor_configs、save_model_assignments | 7 |
| llm-calls.json | call_llm_for_boundary、cancel_stream、test_api_connection、ocr_extract_text | 8 |
| translation-stream.json | translate_text_stream | 5 |
| extended.json（981 外延，“在768=否”） | estimate_tokens、fetch_vendor_models、opencode_go_get_usage、stream_chat_translation_aligned、stream_chat_translation_plain | 7 |

全部 `seed:"empty"`，写操作场景 `capture.events=true`、`db=["*"]`。静态检查（JSON 可解析、v0 键严格、id 唯一、`${n}` 无前向引用、命令在 contracts 中存在、每条清单命令有非 error 步骤）见交付报告中的 job。

## 参数化离线 LLM（X5）

- 所有 baseUrl 写成字面量 `http://127.0.0.1:18461/s/<scriptId>/v1`，只用 X5 内建脚本 `success.answer`、`success.thinking`、`error.http-500`、`error.eof-after-partial`。runner 只把 origin `http://127.0.0.1:18461` 换成 X5 实际地址，两端同一端点，无 API key（`authMode:"none"`），不连互联网。
- `http://127.0.0.1:18462`、`http://localhost:18461`、`https://127.0.0.1:18461` 是**故意的异源地址**，只出现在 Rust 于发网络请求前就返回 Err 的步骤（同源校验），runner 不得替换。
- 非流式请求（call_llm_for_boundary、OCR、测试连接）由 X5 折叠为单个 `chat.completion`。`error.eof-after-partial` 在非流式下的表现以 A 为准，因此相应步骤不标 error。
- `test_api_connection` 的 `isEmbedding/isReranker/isImageGeneration` 会访问 `/embeddings`、`/rerank`、`/models`，X5 对这些路径返回 404（`not-found`），Rust 把探测失败返回为 `Ok({ok:false,...})`，属业务失败分支，不是 Err。

## 跨域前置命令（owner）

| 命令 | owner | 用途 |
|---|---|---|
| save_api_configurations | L02（本 lane，非本包清单） | 写入模拟 ApiConfig |
| save_setting | L19（`src-tauri/src/cmd/web_search.rs:541`） | 把 `model_assignments` / `model_profiles` / `vendor_configs` 写成非法 JSON，触达读取命令的解析 Err；这三个键不在 `internal.oauth.` 前缀内、也不是 SecureStore 敏感键，Rust 直接写 settings 表 |
| save_available_ocr_models | L18（`src-tauri/src/cmd/ocr.rs:357`） | 配置 OCR 引擎（generic_vlm → 模拟多模态配置） |

## 逐命令覆盖表

Rust 路径相对 `src-tauri/`。`mod.rs` 指 `crates/dstu-llm/src/llm_manager/mod.rs`。

| 命令 | 前端 | Rust | 成功场景 | 错误场景 | 未覆盖的 Err 及理由 |
|---|---|---|---|---|---|
| get_api_configurations | src/components/NoTagTreeShadPanel.tsx:90 | src/commands.rs:2127；mod.rs:6417 | config.empty_reads_bootstrap、vendor_profile_roundtrip_masking、builtin_vendor_secret_lifecycle、model_profiles_builtin_hiding | config.corrupted_settings_read_errors（model_profiles / vendor_configs 解析失败经 bootstrap repair 返回 Configuration） | 数据库读失败（`检测供应商配置失败`等 database Err）：empty seed 无法制造 sqlite 故障，需 X3 故障 seed |
| get_model_assignments | NoTagTreeShadPanel.tsx:91 | src/commands.rs:2175；mod.rs:7881 | config.empty_reads_bootstrap（无记录时默认 4 键 JSON）、model_assignments_roundtrip | config.corrupted_settings_read_errors（非法 JSON、类型不符 `model2_config_id:42`） | `获取模型分配配置失败` database Err：同上 |
| get_model_profiles | src/features/chat/components/input-bar/InputBarV2.tsx:783 | src/commands.rs:2206；mod.rs:6220 | empty_reads_bootstrap、vendor_profile_roundtrip_masking、model_profiles_builtin_hiding | corrupted_settings_read_errors（缺 vendorId 的条目） | database Err：同上 |
| get_vendor_configs | src/features/chat/components/input-bar/ModelPicker.tsx:182 | src/commands.rs:2193；mod.rs:5756 | empty_reads_bootstrap、vendor_profile_roundtrip_masking（主/备用 key 与敏感头掩码）、builtin_vendor_secret_lifecycle（内置 key 存安全存储、SiliconFlow 兼容键） | corrupted_settings_read_errors（`vendor_configs` 为对象） | database Err：同上 |
| save_vendor_configs | src/utils/configApi.ts:126 | src/commands.rs:2198；mod.rs:6005–6217 | vendor_profile_roundtrip_masking（新增、`***` 保留、空行删除、清空、`authMode:none` 改源）、builtin_vendor_secret_lifecycle（保存/保留/清空内置 key，`builtin-` 前缀兼容）、validation_errors 末尾的改源重输 | save_vendor_configs.validation_errors：无效头名、无效头值、改源保留主 key（列表后部失败，前部不落盘）、改源保留备用 key、改源保留敏感头、`authMode:none` 仍校验敏感头、内置供应商改端口；缺 `configs` 参数 | `encrypt_api_key` 加密失败、`序列化供应商配置失败`、`保存供应商配置失败`、安全存储读写失败：empty seed 不可达，需 F4/X3 故障注入 |
| save_model_profiles | src/features/chat/hooks/useFavoriteChatModels.ts:130 | src/commands.rs:2211；mod.rs:6329 | vendor_profile_roundtrip_masking（全字段、最少字段、`context_window` 别名、孤儿 vendor）、model_profiles_builtin_hiding（内置收藏、空列表隐藏全部已知内置）、corrupted_settings_read_errors 恢复 | model_profiles_builtin_hiding：缺 `vendorId`、缺 `profiles`（框架 serde 拒绝） | 处理函数自身 Err 只有 `save_hidden_builtin_model_profile_ids` 写库失败、`序列化模型条目失败`、`保存模型条目失败`，empty seed 不可达；上列两条是参数反序列化边界，不冒充处理函数分支 |
| save_model_assignments | src/features/chat/components/input-bar/ModelPicker.tsx:363 | src/commands.rs:2182；mod.rs:7893 | model_assignments_roundtrip（17 键全量、单键、空对象） | model_assignments_roundtrip：`model2_config_id:42`、缺 `assignments`（框架 serde 拒绝） | 处理函数 Err 只有 `序列化模型分配配置失败`（ModelAssignments 全是 Option<String>，serde_json 不可能失败）与 `保存模型分配配置失败`（sqlite 写失败，需故障 seed）；均不可达 |
| call_llm_for_boundary | src/components/anki/cardforge/engines/CardAgent.ts:907 | src/commands.rs:4051；model2_pipeline.rs:8570；mod.rs:6941 | boundary.success（普通、空 prompt、思考模型） | boundary.errors：无配置、未分配 model2、分配不存在 id、嵌入模型、已禁用、HTTP 500；缺 `prompt` | Codex OAuth 发送路径与网络 DNS/连接错误：需真实账号/网络，不连互联网 |
| cancel_stream | src/essay-grading/useEssayGradingStream.ts:288 | src/commands.rs:341；mod.rs:5459 | cancel_stream.registry_without_active_stream（无活跃流写入备用标记、重复、空串、含空格名）；translation.stream.pre_cancelled 与 chat_*.success 中作为取消入口（标记被下一次流消费） | 缺 `streamEventName`（框架 serde） | 处理函数无 Err 分支，恒 `Ok(true)` |
| test_api_connection | src/features/settings/components/ShadApiEditModal.tsx:853 | src/commands.rs:3321–3733 | chat_probe_success（none 认证、明文 key + 默认模型、思考参数与自定义头、尾斜杠）、saved_vendor_and_errors 中已保存供应商 `***` 取存储 key；probe_failures_ok_false（HTTP 500、EOF、embedding/rerank/image-gen 404 → `ok:false`） | saved_vendor_and_errors：未输入 key、`***` 无供应商、供应商不存在、已保存供应商异源、已保存供应商无 key、名含 siliconflow 时旧格式回退仍无 key、内置 deepseek / siliconflow 无 key；缺必填参数 | Codex OAuth（`:3573`）、OpenCode Go 用量探测（`:3616`）需真实账号与外网；`创建HTTP客户端失败` 不可达；`prepare_provider_request` 构建失败需非法配置，未找到 empty seed 下可达输入 |
| ocr_extract_text | src/utils/testApi.ts:142 | src/cmd/translation.rs:90；crates/dstu-llm/src/llm_manager/exam_engine.rs:856 | ocr_extract_text.vlm_success（data URL、裸 base64、仅 mime 可推断、path+base64 同时给优先 base64、首尾空白） | ocr_extract_text.errors：两者皆缺（显式 null / 缺省）、data URL 无逗号、Base64 非法、无引擎（无设置 / 仅禁用与非多模态）、图片路径不存在、全部引擎 HTTP 500 | `图片过大（上限 20MB）` 两个分支需 >27MB 参数，未写入语料（场景文件体积）；熔断 Err（`OCR_CIRCUIT_BREAKER` 进程级静态，需连续失败，跨场景共享进程时会互相影响，A/B 每场景须独立进程）；`create_dir_all`/`write` IO 失败需故障 seed |
| translate_text_stream | src/translation/useTranslationStream.ts:399 | src/translation/mod.rs:35；crates/dstu-tutor/src/translation/pipeline.rs:137；crates/dstu-translation-core/src/engine.rs:63 | translation.stream.success（基本、auto+formality/domain/glossary/prompt_override、回退 model2）、segmented_long_text（≥4000 字分段）、pre_cancelled（预取消返回 null + cancelled 事件，随后同 session 正常完成） | validation_and_config_errors：无翻译模型、空文本、空白文本、100001 字符、分配不存在 id、缺 `request`；provider_failures：HTTP 500（可重试一次后失败）、EOF 已有部分输出不重试 | `VFS 数据库未初始化`（`mod.rs:66`）：正常启动 vfs_db 必存在；`timeout_total`/idle 超时需 90s–600s 挂起，v0 无时序控制；`empty_result` 需返回空正文的脚本，X5 无此内建脚本 |
| estimate_tokens（外延） | src/utils/shared.ts:191 | src/commands.rs:316 | estimate_tokens.success（多语种/emoji/空串、指定模型、空列表、长文本） | 缺 `texts`、缺 `request`（框架 serde） | 处理函数无 Err 分支 |
| fetch_vendor_models（外延） | src/features/settings/components/vendorModelService.ts:202 | src/commands.rs:3106 | 内置 OpenCode Go 目录（含首尾空格 id）、`providerType:opencode_go` 的自定义供应商 | 供应商不存在、内置供应商无 key、Base URL 无效、非 HTTP(S)、none 认证与备用 key 访问 X5 `/models` 得 404 | 真实目录分页成功路径需 X5 提供 `GET /s/<id>/v1/models` 脚本（owner X5），未提供前该类步骤只能录到 HTTP 错误 |
| opencode_go_get_usage（外延） | src/utils/opencodeGo.ts:67 | src/commands.rs:3311；mod.rs:5954 | **无**（成功需访问 `https://opencode.ai/zen/go/v1/usage`，常量地址不可参数化，不连外网） | 缺省 vendorId 时内置 Go 无 key、显式 null、供应商不存在、非 Go 供应商、保存 `***` 后仍无 key | 成功与 Network/LLM 错误分支需外网 |
| stream_chat_translation_aligned（外延） | src/features/chat/components/TranslationPopover.tsx:541 | src/translation/chat_popover.rs:16；crates/dstu-tutor/src/translation/chat_popover.rs:177–345 | chat_aligned.success（基本、上下文、回退 model2、预取消返回 Ok + cancelled 事件） | chat_aligned.errors：无模型、空 request_id、空白 source、8001 字符、分配不存在 id、HTTP 500、EOF 中断、缺 `request` | `API 密钥解密失败` 需损坏的加密 key；`empty result` 需空正文脚本（X5 无） |
| stream_chat_translation_plain（外延） | TranslationPopover.tsx:542 | src/translation/chat_popover.rs:26；同上 | chat_plain.success（同上） | chat_plain.errors（同上） | 同上 |

## 已知非确定字段（只标候选，未加规则）

- `save_vendor_configs` 落库的 apiKey/apiKeys/敏感头是 `EncryptedData` JSON，nonce 每次不同；A1/A2 双录后由 C2 定 JSONPath。
- `test_api_connection` 返回 `latencyMs`；`translate_text_stream` 返回 `id`、`created_at`。
- `get_api_configurations` 的 `resolvedAdapterId` 等派生字段两端应一致，不在候选内。
