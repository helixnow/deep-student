model=gpt-5.6-sol-xhigh-fast
# 01 / 02 / 03 源码互审

- 互审对象：`01-chat-composer.md`、`02-cloud-sync.md`、`03-vfs-governance.md`。
- 方法：只读当前源码，复核三份报告的关键产品断言；未用 Git/gh，未修改三份原文，未运行测试。
- 标记含义：
  - **过强**：源码不能支撑原文口径，或源码直接存在反例。
  - **过弱**：结论方向正确，但证据漏掉了更直接或更强的实现。
  - **漏项**：原报告范围内存在值得影响结论或风险等级的源码事实，却未记录。

## 对 01-chat-composer.md 的互审

### 已由源码确认

1. Pipeline hook 接线成立。`pipeline/hooks.rs:99-143` 定义四个切点并按
   `ApprovalGateHook → TaskAuditHook` 注册；`pipeline/tool_loop.rs:346,468,3191,3272`
   分别调用 `before_turn`、`before_compaction`、`before_tool`、`after_tool`。
2. tools 顺序冻结不是死代码。`tool_loop.rs:975-995` 在生产请求前冻结 schema，
   `pipeline/helpers.rs:1017-1080` 负责跨调用、跨进程加载和 append-only 持久化。
   原文也正确区分了“名字顺序持久化”和“schema 字节仅稳定窗口内冻结”。
3. `availableSkillsSnapshot` 的 first-write-wins 链成立：
   `repo.rs:2762-2813` 事务写入，`manage_session.rs:378-406` 暴露命令，
   `TauriAdapter.ts:3712-3721,5290-5340` 负责加载回灌、首次异步持久化及竞争结果回灌。
4. UTF-8 增量解码链成立。`utils/sse_buffer.rs:116-213` 内嵌
   `Utf8StreamDecoder`，多个 LLM 流式调用方实际使用 `SseEventBuffer`。
5. Composer 拆分和所列主要 `data-testid` 均在对应拆分文件中，原文关于
   `ComposerToolbar`、`ComposerTextarea`、`AttachmentPanelBody` 的现状判断可信。

### 过强

1. **“新会话调用方均走同一入口，无旁路”不成立。**
   - `src/quick-assistant/service.ts:150-155` 直接 invoke
     `chat_v2_create_session`，这是实际功能路径。
   - `src/features/chat/adapters/TauriAdapter.ts:4010-4031` 也保留直接创建方法；
     当前源码搜索不到该方法的产品调用方，但它仍是旁路实现。
   - 只有主聊天页面、Workbench Chat 和五个 debug 插件走
     `createSessionWithDefaults`。因此默认权限、默认技能、组 pinned 资源及组快照的
     “统一入口”口径只能限定为主聊天 UI，不能扩大到全仓。

2. **“流式链路”的后端证据归因过强。**
   `model2_pipeline.rs:2807-2869` 主要发送脱敏后的
   `chat_v2_llm_request_body` 调试事件，`2972-2986` 只解析 session scope；
   真正的块级产品事件通道由 `chat_v2/events.rs:982-1044`
   的 `ChatV2EventEmitter` 构造并发送。链路本身存在，但原文把调试请求体路由
   当成了主要块事件路由证据。

3. 静态源码和测试文件存在，只能证明接线与回归意图；在本轮未运行测试的前提下，
   结论中的“全部一致、未发现回退”应收窄为“本次抽查项未见源码冲突”。

### 漏项

1. **OpenAI 24h prompt-cache retention 逻辑是无调用实现。**
   `model2_pipeline.rs:3193-3196` 的 `provider_accepts_prompt_cache_retention`
   与 `3205-3213` 的 `apply_openai_prompt_cache_retention` 在全仓均只有定义，
   没有生产调用点。实际请求准备路径 `3276-3286` 只注入
   `prompt_cache_key`。原文把 retention gate 列入“cache 全链”却没有指出它尚未接线；
   如果 24h 保留是目标语义，这不是完整落地。

2. `SseEventBuffer::process_bytes` 在缓冲超过上限时会清空并返回空事件
   （`utils/sse_buffer.rs:155-177`），不会向调用方返回显式错误。原文证明了跨 chunk
   UTF-8 正确性，但没有记录超限时的静默丢流边界。

### 对 01 的判定

核心 hooks、工具冻结、skills 快照、UTF-8 与 Composer 拆分均有源码支撑；但“全仓新会话
无旁路”是明确反例，24h retention 也未接线。原文的总 `PASS` 应改为**有条件通过**。

## 对 02-cloud-sync.md 的互审

### 已由源码确认

1. 每设备 tombstone 清单的 PUT 后复读成立：
   `tombstone.rs:594-616,1400-1504` 对 blob、asset、workspace 三类清单复读并逐字节比较。
2. asset 删除在过滤前读取物理 `object_key`，并保护仍有活跃引用的内容寻址对象：
   `sync/mod.rs:11453-11465,12126-12202` 与原文一致。
3. WebDAV endpoint 单次编码、href/base 同编码空间比较成立：
   `webdav.rs:176-209,596-639`。
4. S3 endpoint 仅对已知 provider host 剥离重复 bucket，multipart 清理严格限定同 key、
   有 `Initiated` 且达到宽限期：`s3.rs:67-140,260-333,450-466`。
5. FTP 普通对象 not-found 使用“状态码 + 明确缺失语义”双门：
   `ftp.rs:239-287`；CWD 的 550 歧义错误也默认上抛（`289-313`）。
6. E2EE marker 复读、旧仓试解、未知/损坏 verifier 拒绝、记录及文件 payload 防明文降级
   均有生产接线：`sync_manager.rs:566-735`、
   `data_governance/sync/mod.rs:760-984`。
7. ZIP 导入在写目标目录前校验归档和密码，逐路径拒绝 symlink，最终还会按 manifest
   校验哈希并拒绝未声明文件：`zip_export.rs:287-387,665-740,1735-1928`。
   原文只写到“同大小非 DB 文件可跳过”，遗漏了后置哈希校验，实际防线比报告更强。

### 过强

1. **“短写不能推进删除状态”不准确。**
   `upload_*_tombstones` 的顺序是先 `publish_events(...).await?`，再写兼容清单
   （`tombstone.rs:1407-1434,1444-1470,1480-1503`）。不可变事件本身又在
   `put_event_verified` 中完成 PUT 后复读（`302-350`）。因此兼容清单复读失败时，
   调用会失败且不得报成功，但已经验证成功的 v4 不可变事件可能已对其他设备可见，
   删除传播并非“没有推进”。这属于安全的部分提交/幂等重试语义，不应描述为零推进。

2. WebDAV/S3 的“90 秒超时”仅是**单次读停滞超时**，不是总时长或总大小边界。
   `webdav.rs:1233-1254` 与 `s3.rs:797-832` 只要持续收到小块数据就可无限延长，
   并持续向无上限 `Vec` 追加。故“响应体半挂死不会无限等待”成立，但不能扩成
   “内存对象 GET 已完整 fail-closed”。

3. “没有可见的静默明文降级路径”应限定在本次抽查到的 marker、payload 和 ZIP 路径；
   静态源码不能代替真实供应商、多设备竞态及灾难恢复演练。原报告后文已有此边界，
   总结段却用了更绝对的口径。

### 过弱

1. Tombstone 的当前主协议不只是三份每设备清单。`tombstone.rs:281-525`
   还有按设备/序号发布的不可变事件流：上传前查云端最大序号、事件 PUT 后复读、
   消费时校验 payload hash、路径与设备一致性、序号断层，并在 list 截断时拒绝推进水位。
   原文只审了兼容 manifest，低估了当前删除传播防线，也导致前述“零推进”误判。
2. S3 已知 host 还覆盖 AWS global/regional endpoint
   （`s3.rs:133-138`），原文只列 COS/OSS/S4，范围描述不完整但不影响安全结论。
3. ZIP 恢复的关键强证据还包括 `validate_imported_backup_dir` 最终调用
   `verify_internal`、资产校验和未声明文件检查（`zip_export.rs:287-387`）；
   这比单述 `enclosed_name`/symlink 更能支撑 fail-closed。

### 漏项

1. **WebDAV/S3 内存对象 GET 没有总字节上限。** 对不可信或错误配置的服务端，
   有进展但无限长的响应可造成内存持续增长；声明了巨大 `Content-Length` 时也没有
   下载前拒绝。该风险与报告审计的 manifest/change shard 内存读取直接相关。
2. v4 tombstone 不可变事件与兼容 manifest 的双写顺序、失败后的可见性和重试语义
   应作为发布边界明确记录。

### 对 02 的判定

WebDAV/S3/FTP、E2EE、ZIP 与删除传播的主要安全机制均在；但 tombstone 协议描述遗漏主事件流，
且内存 GET 只有停滞超时、没有总量上限。原文总体方向可信，绝对 `PASS` 应收窄为
**主要不变量通过，保留内存资源上限风险**。

## 对 03-vfs-governance.md 的互审

### 已由源码确认

1. `pre_repair_vfs_schema` 的顺序确为“补常规表 → 修 change_log → 修 notes.props”：
   `coordinator.rs:2275-2331`。
2. `notes.props` 的两种中间态收敛成立：
   `coordinator.rs:2345-2376`；重建 notes 时按已记录版本补回 props 也在
   `2383-2431`。
3. `V20260824__note_props.sql` 是可空、无回填的单列迁移，danger ack 与 lock 条目均在。
4. `notes.props` 写入端确有数量、键、标量值、长度、保留字和重复键校验，
   空对象落 SQL NULL：`note_repo.rs:398-482,1884-1905,1908-2008`。
5. migration gate 会锁文件哈希/路径/版本并要求新增危险 SQL 使用文件内 ack；
   三个 workflow 均有接线。当前迁移目录静态枚举为 111 个 SQL 文件。
6. DataGovernanceDashboard 的清库确认、恢复前端预检和后端 A/B 槽/磁盘预算门均在；
   02 对 ZIP/restore 后端的复核也与本报告相互印证。

### 过强

1. **VFS 稀疏旧库 backfill 的 `PASS` 目前不能成立。**
   - `apply_vfs_init_missing_tables` 只从 init SQL 提取并执行
     `CREATE TABLE IF NOT EXISTS`（`coordinator.rs:2378-2469`），明确不重放索引；
     测试还明确排除了 FTS 虚表（`5777-5791`）。
   - 但迁移后验证会检查所有已记录迁移（`coordinator.rs:4057-4074`）。
     V20260130 要求关键索引及 smoke query（`migration/vfs.rs:56-64,171-223`），
     包括刚补表对应的 `idx_folders_parent`、`idx_questions_exam_id`、
     `idx_review_plans_exam_id`，以及 `questions_fts`、`trash_view`。
   - 当前回归 `test_pre_repair_vfs_backfills_questions_before_change_log`
     只直接调用 `pre_repair_vfs_schema` 并检查普通表与 `__change_log`
     （`coordinator.rs:5794-5853`），没有执行完整
     `run_refinery_migrations` 和最终 verifier。
   - 因而在“V20260130 已记账、但旧库确实只剩 resources/notes”这一原报告描述的场景，
     正常 init 会被跳过，补出的常规表没有 init 索引，FTS/视图也不会由该 helper 补齐，
     最终很可能 fail-close 于验证阶段。防止 `no such table: questions` 只解决了
     change_log 回放的第一关，不等于升级闭环通过。

2. **“前后端 props 校验一致”只能部分成立。**
   后端长度使用 Rust `chars().count()`（Unicode 标量），前端
   `NoteCustomPropsEditor.tsx:43-47` 使用 JavaScript `.length`（UTF-16 code unit）；
   含 astral 字符/emoji 时边界不同。数量、保留字和常见文本长度一致，但不能称逐项一致。

3. **“读写路径硬化”忽略了畸形存量值。**
   `note_repo.rs:2175-2182` 对缺列、无效 JSON、非对象和空对象统一静默回退为 `None`，
   不记录解析错误。写入端严格，但同步、旧库或外部损坏产生的非法 props 在读取时会被
   隐藏，不能与规范 NULL 等同描述。

4. `b2a85a69`/`5f324e1f` 超集、`2bfe7c31` 未合入、111 基线曾执行 exit 0 等属于
   Git 谱系或历史运行证据，不是当前产品源码可以独立证明的事实。本次源码互审不否定它们，
   但它们不应被计入“源码再次确认”。

### 过弱

1. `notes.props` 的 row-level LWW 不只写在迁移注释里：
   `sync/field_merge.rs:569-577` 有测试明确保证 props 不进入字段级深合并，
   `sync/classification.rs:71` 也登记了同一策略。原报告可用这些直接证据加强同步语义。
2. DGD 契约测试数量已漂移。当前 `tests/vitest/data-governance/` 下以
   `DataGovernanceDashboard.*` 命名的文件是 13 个，不是原文所称 10 个。
   这是证据清单过时，不是产品缺陷。

### 漏项

1. 稀疏 VFS 库需要一条端到端回归：构造“V20260130 已记录、仅 resources/notes 在位”
   的数据库，执行完整 migration coordinator，并断言 init 关键索引、`questions_fts`、
   `trash_view` 与最终 verifier 全部通过。现有测试只覆盖预修复局部。
2. 畸形 `notes.props` 的读取政策未被报告：应明确是容错隐藏、告警后隐藏，还是 fail-closed；
   当前源码选择无日志容错。
3. props 前后端字符计数口径存在 Unicode 边界差异，原报告没有覆盖。

### 对 03 的判定

`notes.props` 迁移与双向中间态修复基本成立，migration-lock 和危险恢复面也有支撑；但
“稀疏旧库 backfill 完整通过”缺少索引/FTS/视图闭环，且现有测试没有进入最终 verifier。
这是会影响升级成功与否的高价值漏项，因此原文总 `PASS` **暂不能维持**。

## 三份报告的交叉结论

1. 02 与 03 对 ZIP/整槽恢复的后端 fail-closed 判断相互一致；02 提供的 manifest、
   解压和 A/B 切槽证据比 03 的前端危险面登记更接近真正安全边界。
2. 01 的“全仓会话统一入口”没有得到其他报告支撑，源码反而有 quick-assistant 直连反例。
3. 02 的云同步数据可能最终进入 03 所审 VFS；因此 VFS 稀疏库迁移闭环不能因
   change_log 表已补出就判定完成，最终 schema verifier 才是升级是否可用的裁决点。
4. 三份报告均把“源码存在 + 测试文件存在”部分写成了完成态结论。静态审计应分别表述
   接线事实、测试覆盖意图和已执行结果，避免三者互相替代。

## 结论

- `01`：核心链成立，但“新会话无旁路”错误，24h prompt-cache retention 未接线；
  应由 `PASS` 调整为有条件通过。
- `02`：主要安全不变量成立，但 tombstone 主事件流漏审，WebDAV/S3 内存 GET 无总量上限；
  应保留资源耗尽风险。
- `03`：`notes.props` 主链成立，但稀疏 VFS backfill 未覆盖最终验证所需的关键索引、
  FTS 与视图，现有测试也未跑完整迁移闭环；总 `PASS` 暂不能维持。

本轮不改代码。
