# 统一文件管理 / 附件 / 文件流：0824 改造质量评审

对照 `v0.9.44` → `origin/cursor/0824-cde6` @ `2d41ea8b`。范围：`unified_file_manager.rs`（+325 行）、`file_stream_protocol.rs`（+136 行）、`file_manager.rs`、`src/utils/fileManager.ts`，以及附件上限的配套增量（`attachment_repo.rs`、chat 常量与设置钩子）。SAF persist 队列的消费端 `MainActivity.kt`（+99 行）与锁定测 `tests/sync_r10_android.rs`（+514 行）虽不在点名文件里，但与本块是同一条链路，一并纳入判断。

## 总判断

这一块改造是**实质性变好**的：四条主线（双重编码 fail-closed、SAF 导出回读校验、persistable URI 队列、filestream 白名单归一化）都是在修真实缺陷而非装饰性重构，错误处理姿态从旧版的"猜测放行/静默吞错"整体转向"可读拒绝/诚实报错"。缺陷层面没有发现会造成数据错误或越权的问题；主要的代价是**物化路径上的 I/O 放大**（虚拟 URI 导入最多三次全量读），以及两处收尾没有做完：附件上限的"唯一权威来源"承诺在 `dstu/handlers.rs` 处断掉，SAF persist 的系统级配额没有回收机制。

## 双重编码 URI：从"猜测放行"反转为 fail-closed，是正确的方向

v0.9.44 的 `classify_path` 对 `content%3A%2F%2F...` 这类输入做的是"解码一次后若命中 special scheme 就当虚拟路径放行"（旧注释自称"双重编码兜底"）。这个兜底本身是错的：它只在"整段 URI 被均匀再编码一次"时碰巧正确；若输入是"scheme 被编码但 document ID 未再编码"的混合形态（有 bug 的调用方最容易产生这种），解码一次会把 document ID 里的 `%3A/%2F` 拆成 `:` 和 `/`，交给 ContentResolver 就是 SecurityException——而这两种形态从字符串上无法区分。新版直接放弃猜测：

```86:91:src-tauri/src/unified_file_manager.rs
    // 整段再编码的 content:// 不能当虚拟路径：一次解码会拆掉 document ID
    // 的 %3A/%2F，ContentResolver 可能 SecurityException。公开 is_virtual_uri
    // 也不认这类输入。拒绝并给可读错误，命令层不得误路由到本地半包。
    reject_double_encoded_virtual_uri(trimmed)?;

    let decoded_for_check = decode_path(trimmed).unwrap_or_else(|_| trimmed.to_string());
```

两点做得好：其一，拒绝点放在 `classify_path` 内部，所有走 `unified_file_manager` 的读/写/复制/物化入口自动覆盖，ZIP/同步命令入口（`commands_zip.rs:209`、`commands_sync.rs:2380/2498`）又显式再拒一次以给出早期可读错误——纵深而非散点。其二，拒绝文案做成公开常量 `DOUBLE_ENCODED_VIRTUAL_URI_REJECTED`，命令层与锁定测共用，避免文案漂移导致测试与产品各说各话。行为上这是对旧版的收紧（旧版均匀再编码的输入能碰巧成功，新版一律报错），但生产前端始终传原始 `content://`，收紧只影响本就不该出现的输入，取舍正确。

## copy_file 回读校验与空间预检：正确性收益真实，代价是 I/O 放大

新版 `copy_file` 在 copy+flush 后重新打开目标，核对长度与 SHA-256，不一致即报错：

```268:277:src-tauri/src/unified_file_manager.rs
    // [R12-saf-verify] 不能只凭 copy+flush 报成功：部分 DocumentsProvider 延迟提交，
    // 必须重新打开目标核对长度与 SHA-256。回读失败或内容不一致一律 fail-closed。
    let mut verify_reader = open_reader(window, &target_path).map_err(|e| {
        AppError::file_system(format!(
            "目标回读失败，已停止并不得报成功: {} ({})",
            target_path.display(),
            e
        ))
    })?;
    let (verified, target_digest) = digest_read(&mut verify_reader, &target_path.display())?;
```

针对的是真实缺陷：备份 ZIP 导出到 SAF 目标时，旧版 `std::io::copy` + `flush` 成功就报成功，延迟提交或写半截的 DocumentsProvider 会让用户拿着一个损坏的"成功备份"。对备份/换机链路，"宁可报错也不报假成功"是对的，且实现干净——`digest_copy`/`digest_read`/`ensure_identical_copy` 拆成可单测的纯函数，边写边算源哈希避免了对源的第四次读。

但要指出代价与几个边角：

- **I/O 放大集中在虚拟 URI 物化路径**。`ensure_local_path` 新增的空间预检（`:927-931`）先调 `get_file_size`，而该函数对 content:// 的实现是**全量流式读一遍数字节**（`:530-545`，旧代码原样保留，`read_all_bytes_bounded` 的注释也明说虚拟 URI"无法预检大小"）；随后 `copy_file` 再读一遍源、写一遍、回读一遍目标。一次大文件导入（如 500MB 备份包）从旧版的"读一写一"变成"读三写一"，其中两次读走 ContentResolver——对云端 provider（Google Drive 等）意味着双倍网络拉取。有明确的优化空间：物化目标是本地临时文件，先尝试对打开的句柄 `seek(SeekFrom::End(0))` 取长度、失败再退化全量读，可在常见 provider 上省掉一次整读；回读校验对"目标是本地临时文件"的场景也可降级为长度核对（本地 close 后长度不符即异常，SHA 对本地盘意义有限），把全价 SHA 回读留给"目标是虚拟 URI"的导出方向。
- **2 倍空间系数是钝的**。`required_temp_copy_bytes` 一律按源大小 ×2 预检（`:347-349`），注释未说明 2 倍从何而来（推测是给下游解包留余量）。对纯物化而言 1 倍加固定余量即可；现在 150MB 的文件在剩 250MB 的设备上会被拒，属于过度保守。fail-closed 方向没错，只是系数缺依据。
- **失败路径的残留**。物化 copy 失败时 `MaterializedPath` 尚未构造，半截临时文件不会被 Drop 清理——这是 v0.9.44 就有的旧账，本轮新增的校验失败分支同样落入，顺手修的机会错过了。导出方向上校验失败会在用户选的 SAF 目标处留下坏文件且不尝试删除（content:// 无统一删除能力），可接受，但错误文案没有提示用户手动清理。
- **回读也没法防一切**：某些 provider 回读的是本地待同步副本，校验通过不等于云端最终一致。注释把承诺限定在"不得只凭 copy+flush 报成功"，没有夸大，这个分寸是对的。

另外注意 `copy_file` 是前端通用命令（`commands.rs:3144`），本地→本地的普通复制也一并背上了回读成本。桌面本地盘上这只是顺序 I/O 翻倍，尚可接受，但如果未来有热路径调用，值得给"本地→本地"留一个跳过全价校验的口子。

## SAF persist 队列：v0.9.44 完全没有的能力，链路两端都做得诚实

旧版异步 ZIP 导出到 content:// 依赖当前进程的 URI grant，进程被杀后重启续作必然失败——这是真机上真实存在的坑。本轮补的方案是 Rust 侧把 URI 原子写入应用私有队列目录（哈希文件名 + tmp/rename，`:449-485`），Android 侧 `MainActivity` 前台轮询消费并调 `takePersistableUriPermission`。设计上有几处明显用了心：

- 队列从分支中期的单文件（提交 `aeafb9f0`）改为每 URI 一个文件（`aeb98c61`），修掉并发导入/导出互相覆盖的问题；文件名取 URI 的 SHA-256 前 8 字节，同 URI 重复入队天然幂等。`.uri.tmp` 中间态被 MainActivity 的 `endsWith(".uri")` 过滤器自然排除，rename 原子性保证消费端只见完整内容。
- 消费端对 `ACTION_GET_CONTENT` 场景的 SecurityException 做了两级降级（先试读写、再试只读、最后删队列 + warn，`MainActivity.kt:148-172`），注释明说"不得假装已授权"——比常见的"catch 后静默"实现诚实得多。
- 入队前复用双重编码拒绝，且对非 content:// 输入静默跳过而非报错，调用方可以无脑把 output_path 传进来，五个调用点（ZIP×3、同步×2）都保持了同一形状。

两处小瑕疵，不阻塞但值得记下：其一，**没有 persist 配额的回收**。Android 对 persisted URI permission 有系统级上限（API 29 前 128、之后 512），队列文件消费后删除，但系统侧的 grant 从不 `releasePersistableUriPermission`；重度用户长期向不同文档导出会逼近上限，届时 take 抛 SecurityException 走 warn 分支——行为仍诚实，但异步续作能力会静默退化。其二，进程在 write 与 rename 之间被杀会留下永远无人清理的 `.uri.tmp` 孤儿（消费端只删 `.uri`）。另外"双读旧单文件"的兼容只服务于本轮分支内部的升级窗口（v0.9.44 从未有过单文件队列），保留无害，属于极小的死重。

## filestream 白名单归一化：修的是真 bug，共享例外的取舍正确

`file_stream_protocol.rs` 头部原有"不修改 pdf_protocol.rs、辅助函数按约定在本文件复制"的约定，本轮为 `path_is_within` 开了显式例外（#59）。这个例外开得对：Windows 上 `canonicalize` 返回 `\\?\C:\...` verbatim 形式，与普通盘符形式做 `Path::starts_with` 因 Prefix 组件不同恒为 false，白名单内的文件被误判 403——安全关键比较若在两个协议里各自复制一份，迟早对同一路径给出不同判定。归一化实现（`pdf_protocol.rs:111-161`）只统一书写形式（verbatim 前缀、斜杠方向、尾分隔符、大小写折叠），组件边界仍严格（`D:\Docs2` 不属于 `D:\Docs` 有测试钉住），非法 Unicode 路径保守拒绝，非 Windows 平台语义零变化——收敛面控制得很好。大小写折叠在 Windows 上是放宽，但与 NTFS 默认大小写不敏感一致，属于修正而非漏洞（per-directory case-sensitive 的 WSL 目录是理论边角，可接受）。

顺带修掉了一个更实际的问题：旧版 `resolve_blob_dirs` 在 `canonicalize` 失败时**静默丢弃 blobs 目录**——blobs 目录尚未创建或不可 canonicalize 时，所有 blob URL 直接 403 且无迹可查。新版回退保留原始路径（`:199-203`），与 `resolve_allowed_dirs` 行为对齐；blobs 目录不存在时其下不可能有真实文件，回退不构成放宽。隐藏段检查的 Windows 文本回退（`hidden_component_after`，`:249` 起）在无法确定相对关系时返回 true（视为隐藏），fail-closed 的默认值选对了。新增测试覆盖了中文路径百分号编码的端到端 200/403 与 verbatim 混合形态（后者 `#[cfg(windows)]` 门控，CI 在 Linux 上不跑，依赖真机核对单——诚实标注了而非冒充绿灯）。

## 附件上限与占位文件名：对齐做得细，但"唯一权威来源"没有贯彻到底

`file_manager.rs` 的图片校验从硬编码 50MB 改为引用 `attachment_repo::MAX_IMAGE_BYTES` 且提示文案由常量派生（`:1180-1187`），配合 `attachment_repo.rs:141-143` 把常量升格为 `pub(crate)` 并写明"唯一权威来源，禁止再散落硬编码"。前端侧的对齐同样扎实：`resources/types.ts` 的 `IMAGE_SIZE_LIMIT` 10MB→50MB、`blobApi` 单项缓存上限跟进（否则 10–50MB 的图每次跳缓存重走 IPC，注释点明了动机）、`constants.ts` 删掉无人引用的 50MB 残留副本并新增 `getAttachmentSizeLimit(ForFile)` 供输入栏/拖拽/上传器三个入口统一取值。最见功力的是 `useAttachmentSettings.ts:73-77`：旧默认 10MB 曾被持久化到用户设置，直接改默认值救不了存量用户，这里把"恰好等于旧默认值"的持久化项识别为旧默认并升级，同时不动用户显式改过的其他值——这种迁移细节最容易被漏。

但宣称"禁止再散落硬编码"的同一轮里，`dstu/handlers.rs:1117-1118` 仍是手写的 `50 * 1024 * 1024` / `200 * 1024 * 1024`，只靠注释声明与权威来源一致。数值今天没错，可这正是该约定要消灭的形态——权威常量已经 `pub(crate)` 了，引用它没有任何技术障碍。这是本块最典型的"差一步"。

`fileManager.ts` 的占位名 i18n 化本身简单，值得肯定的是没有只改产出端：`isGenericPlaceholderFileName`（`:40-43`）同时认硬编码的 `'文件'`/`'File'`（历史落库数据）与当前语言的 `common:file`，下游 `notesDstuAdapter`/`textbookDstuAdapter` 据此剥除占位名——考虑到了"中文环境写库、英文环境读取"的交叉场景，对当前仅有的 zh-CN/en-US 两语言是完备的。小的架构味道：底层路径工具从此依赖 i18next 初始化时序（初始化前 `t()` 返回 key），当前调用点都在 UI 流程内没有实际风险，但这个耦合方向不太干净。

## 测试与可验证性

单测部分是行为测试而非摆拍：`digest_copy` 往返、长度/哈希失配双拒、双重编码拒绝保持已有队列不被改写、并发入队不互盖，断言都落在可观察行为上。`tests/sync_r10_android.rs` 值得单独一说：`ensure_local_path` 虚拟分支要 `Window<Wry>`，mock runtime 类型不兼容、宿主上真的测不了，该文件把这个缺口写成显式的"真机缺口声明"（连"双重编码的真机对抗性表现仍见手册"都注明），只锁宿主可测的纯函数半边，命令层编排退化为源码文本锚定。文本锚定（断言源码包含 `"queue_persistable_saf_uri(&app_data_dir, &output_path)"` 之类字面量)是脆的——改个变量名就断，且通过也不证明调用顺序——但在类型系统封死 mock 的前提下，这是"诚实地锁次优面"而非"冒充覆盖"，配套的真机核对单也如实列了待办。可以接受，只是后续维护者要有心理准备：这类测试断在重构上时，修断言而非误以为破坏了行为。

## 结论

相对 v0.9.44，这一块的改造质量在本轮各模块中属于上游水平：修的都是真机上会发生的真问题（拆坏 document ID、假成功的备份、进程死后丢 grant、Windows 中文路径 403），fail-closed 的姿态贯彻得一致，测试对自身覆盖边界的陈述诚实。遗留的优化空间按优先级：(1) 虚拟 URI 物化的三次全量读，应尝试 seek 取长度并按目标类型分级校验；(2) `dstu/handlers.rs` 的上限硬编码应改引权威常量，兑现自己立下的约定；(3) persisted grant 无回收与 `.uri.tmp` 孤儿两处小的 housekeeping。均不构成回退发布的理由。
