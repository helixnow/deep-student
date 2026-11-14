# L23-sync-providers 独立验收（R4-review-sync，2026-11-04）

结论：不通过

审读基线：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。本文件替换实现者自验；下文“复核确认”仅表示本次亲自核实的有限事实，不继承原文的 A/B、全等价或全绿声明。

路径约定：TS 相对 `host/plugins/sync-providers/`；Rust `cloud/` = `src-tauri/crates/dstu-sync/src/cloud_storage/`，`storage/` = `src-tauri/crates/dstu-storage/src/`。

**2026-11-04 C2 定向复核**：固定被审 L23/main 提交为 `c7c15e5b5bfe139e11d2699bbd98bf9605d8beba`，包含指定的 `5ac7944d5/b5b2b732c/59f0c3fb7/67ba7d207`。P03 另与 L21 候选提交 `46bb99a298b7b3920b51c0b8ad6a163e46414a97` 做真实服务组合探针，**不将候选代码当作已进入 main**。下列编号为最新判定：P01/P02/P05 关闭，P03/P04/P06/P07/P08/P09 六组仍未决；§1–§4 保留首次基线证据，新亲跑结果见 §5。main 中实现者自写的全勾 ACCEPTANCE 和自报 B14 不作为本次证据。

**后续P03/P08候选补审**：固定 L23=`1da6dadc5580a6ff9a6cfe59abf1a3a77aef7e1c`、最新L21提供方=`e4dd1772f1248d8e2a7c706416b2fbe66fc90ad1`，main可见性另固定=`15b23540a97ee19e1391859c3bc140e5c0daa182`。下方P03/P08以本次补审为准，完整作业结果见§7；P04/P07未重跑。候选29例通过，但真实provider忙锁/IO仍报IPC契约错误，未知异常被扁平化；P03/P08均不关闭。其余P组维持已签收/未决状态。

**增量更新（19c023cd6 + cb9d683d0）**：继续B组任务时发现L21新结构化错误与L23新消费者改动，固定两候选作最小检查，见§9。kind/已知错误/未知异常/缺release代码有修复进展，11个选择用例通过；但真实Node组合在 `cb9d683d0:src/sync_manager.ts:171` 因参数属性报ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，exit=1，尚未进入真实provider调用。不能把旧e4dd/1da运行反例说成新组合已复现，也不能把Vitest绿当生产可用。P03仍待真实组合通过，P09新增可擦除语法阻塞；其它新增P组改动未在本轮全面重签。

**P06实际消费更新（da290fd2e + F4 679b53948）**：读取时L23已删除optional method/env/WeakMap桥接，固定 `da290fd2efd1fd11346b08653941d9b70d4bc620` 与F4 `679b5394896df3acde87eb29e04219db1acf9bb8` 安装真实两插件验证，5个身份/日志场景全部通过，作业20261104072250-8b8a5a exit0。**P06在该候选组合签收**，不是仅因平台API存在勾选；main固定679fd3e4d仍无该API，待集成。原cb9参数属性在da290已显式字段化，本次原生导入成功，P09加载子项修复；整体架构/其它P组不因此自动关闭。当前P03/P04/P07/P08/P09五组未决。

**正式许可基线更新（d5cd234aa + L23 624cfe251）**：本轮按协调者指定main `d5cd234aa8a919807b65eeca250e5567cc527f95` 核实L21结构化许可已正式进入；L23候选 `624cfe2515b5c6cb1dd49ba010e58930f01847c3` 包含该提交，直接导入所有者API并删除镜像。**P03消费侧、P07清理次序、P09职责拆分复核通过；当前仅P04/P08两组未决。** 新token/u64解码/UTC反例已修，但未知字段/必填判定、错误文案/位置与内部Number转换仍不同。新子进程和profile/FTP断言已补且亲跑；618 pending和Docker未执行保留。全部作业及复核者错误取消预期导致的exit1见§11。

## 必须修复

**P08 b04原fixture子项main已核实恢复（74252e624）**：c7a197cfc恢复实际F3内存库、原裁剪schema/触发器及本地4MiB x→远端5MiB y；cd20f3370补说明。两个最终原断言和30s框架默认限时未改，仍经公开apply，不是关hook。主线195643-18bfdd中business25/25通过，b04这一真实性/运行子项签收；整作业仍exit1、W69仍失败，不关闭P08或完整迁移schema的额外性能问题。详§15。

**P08新主线运行/测试真实性证据（01c/ccba）**：181546-28458e整门禁仍exit1，providers剩b04框架超时和w69性能断言。一次窄集184816-a399d8仍2fail；发现runner默认fork环境优先于maxWorkers后，显式单fork185552-6b22e9为b04通过、w69 31882ms仍失败（整体exit1）。原阈值/测试未改，不用窄集局部绿覆盖整门禁。另核实b04丢了Rust本地4MB输入，W69内存库/Instant被改成文件库/Date.now，详§14；不与已签backup B04混淆。

**最新源码补核（main9b3c18601，§16）**：首块`numericSize=Number(size)`已由37a441513删除，正式F4三个首块API支持并实际收到bigint；既有主线sync_manager33/33可签该子项。租约已接F4纳秒与Rust trim，新增子项证据见§16。manifest仍消费本地serde_struct，尚未接正式F4 JsonReader；按C2要求不重复四个旧decoder反例，不据旧反例断言新parser现状，P04/P08整体继续未决。

**当前main可见性校正**：eeaf/4c6cd1ba8已含正式F4 `PathsService.dataSpaceDeviceId`；历史§10“main无API”仅描述当时679fd3e4d。R4在eeaf真实F4+L11+notes+sync生产组合已实际消费该API（作业20261104112304-515659），不再将当前P08统称为F4身份接口缺失；该观察不冒充L23 P06五场景重跑。P04新解码修复固定4c6cd1ba8，后续证据另记；P08 Docker/其余pending独立保持。

- [x] **P01 复核确认修复：配置错误映射为 AppError。** `c7c15e5b5:index.ts:68-69` 捕获并调用 `src/config.ts:102-110`，普通配置错误为 Validation/details=null，能力错误为 Configuration/details.code。`tests/commands_errors.test.ts:40-59,91-115` 亲跑通过，包含真实 kernel invoke 的完整错误对象断言。Rust `cloud/mod.rs:232-235,279-291`。此关闭不涵盖 P03 的跨服务锁错误。
- [x] **P02 复核确认修复：合法 unit-enum map 先归一化再校验。** `src/config.ts:41-45,91-97` 与 `index.ts:68-76` 使用同一 providerKey，服务端 map-form 公网 HTTP/空用户名拒绝，loopback 接受；`tests/commands_errors.test.ts:61-103` 亲跑通过。Rust `cloud/mod.rs:228-245`。invoke 测试使用外部 hydrate 替身，不将其冒称真实 SSOT 集成。
- [x] **P03 复核确认：L23正式消费共享许可、结构化错误及显式释放（624cfe251 / main d5cd234aa）。** `index.ts:17-21,124-125` 直接import/call L21 api.ts，镜像已删除；`:239,263,281` 为snake_case。未知获取异常不再拦截转换；`:149-157` 对预期结构化释放失败记warn，成功路径的编程异常继续抛。真实L21持锁/锁目录IO的invoke分别得到Validation/FileSystem完整对象，真实加密上传时账本kind=backup、完成后可取restore许可（作业20261104074838-775a11中已成功的断言；作业末段因复核预期错误exit1，见§11）。Rust `cloud/mod.rs:419-427,560-567,720-727`、`storage/backup_common.rs:149-166`。旧e4dd/1da反例保留§7，不作当前事实。签收仅限消费者接线/传输/生命周期，供方B03跨进程原语及备份排队取消仍单独未决，F4身份API待集成也不被掩盖。
- [ ] **P04 部分修复：正式main 4c6cd1ba8未知字段与部分错误位置已修；-0、Unicode列、错误优先级及内部精度仍未闭合。** 历史624证据保留，下列新子项与§13为最新。
  - [x] **复核确认**：保留原number token，拒绝1.0/1e2作u32/u64、拒绝已知struct重复字段；解码/encode保留2^53+1与u64::MAX，UTC改为AutoSi/Z，Option/必填/UTF-8/BOM断言通过。证据：`src/json_exact.ts:221-240`、`src/sync_manager.ts:57-106,232-291`、`tests/manifest_decode.test.ts:99-141,181-210`；本轮9条解码用例通过，未重跑已闭P05合并用例。
  - [x] **未知字段接受/必填判定main已修**：4c6c `json_exact.ts:38-85,201-239`改为有序entries；`sync_manager.ts:269-274,287-355`只对已知字段拒重复，不再用普通对象继承链补必填。亲跑20261104113403-cfe2f1确认未知extension内部重复可接受、`__proto__`不能补version、已知字段仍拒重复；20261104113432-5aae59还确认顶层未知重复可接受。原20261104075808-88807e反例保留为旧树证据。
  - [x] **ASCII错误值/结束位置两类main已修**：boolean updatedAt带`false`、不再加自造`for updatedAt`，取实际值末尾；嵌套缺checksum取该对象末尾，不是文档终点。对应新增两条用例均亲跑通过（20261104113403-cfe2f1）。仅签这些具体反例，不宣称全部serde Display一致。
  - [ ] **错误位置/优先级仍非serde**：4c6c `json_exact.ts:130-134,164-172`将emoji计6字节，实际错误column59而正确UTF-8列为57；完整预解析先检查语法/trailing，才类型/重复判定（`:148-153`、`sync_manager.ts:375-383`）。亲测`version:false`后带trailing应先类型错误却报trailing；已知重复第二值为`!`应先duplicate却报expected value。详见§13锁定serde源码，不据两条ASCII绿覆盖整项。
  - [ ] **负零raw-token仍不同**：main亲测`version:-0`被接受并变0；Rust serde_json1.0.149将-0读为F64而u32应拒绝。`isIntegerToken`→BigInt当前绕过该区别，观察作业20261104113432-5aae59。
  - [x] **首块u64消费main已修**：旧4c6c提前Number反例保留；37a441513改在`password_proof.ts:110-145`直接传version.size到三个正式F4 API。主线212749-278ab2中sync_manager33/33含真实加密前缀/9007199254740993n用例通过，§16补核签收；不将该子项扩大为所有文件尺寸/decoder正确。
- [x] **P05 复核确认修复：纳秒比较、updatedAt/latest 与同 ID 覆盖。** `src/sync_manager.ts:244-259,565-570` 使用平台 epochNanos 比较；`tests/manifest_decode.test.ts:137-175` 验证首次 .123000001/.123999999 反例以及相等时间 ID 倒序、同 ID incoming 覆盖，亲跑通过。Rust `cloud/sync_manager.rs:416-428`；UTC 文本差异归 P04，不混入本排序结论。
- [x] **P06 复核确认修复（da290fd2e消费 + F4 679b53948候选，main待集成）。**
  - [x] **唯一编排归所有者**：L23 `src/device_identity.ts:17-22` 只调用必需的 `paths.dataSpaceDeviceId()`；无optional检测、env读取、WeakMap或primitive重组，`index.ts:170-172,296` 的manager/命令都走同一调用点。原cb9的WithoutMethod本地桥已删除，不用该测试入口证明生产接入。
  - [x] **原身份优先级**：F4 `paths/api.ts:119-125` 正式声明底层方法，`index.ts:301-309,386-387` 实现env→primary→legacy→生成，旧deviceId包装保持独立（`:366-384`）。真实插件+invoke探针复用首次P06输入，env-id/primary-id/legacy-id三个优先级均正确，旧路径迁移写回primary。Rust `storage/data_space/device_id.rs:122-158,205-230`。
  - [x] **原文件/主机名/日志保证**：同父目录原子写、dirs默认路径、环境主机名顺序继续由F4既有原语提供（`paths/index.ts:73-112,138-218`、`compat.ts:67-85`）；生产paths插件 `index.ts:424-434` 把ctx.log/ctx.logger接入createPaths。本轮安装生产paths插件，仅以log服务契约接收器记录调用，实际迁移失败得到warn，持久化失败得到error且第二次调用身份不变；未直接给createPaths注入测试日志来替代生产接线。
  - **可见性限制**：两候选均非固定main `679fd3e4d3bdaff9d38188aab851704e952b9ac0` 的祖先，其PathsService仍无dataSpaceDeviceId；签收的是已验证候选修复，不是main启动已接通。详见§10。
- [x] **P07 复核确认：清理已移至done之前，原失败清理保留（624cfe251）。**
  - [x] **复核确认**：临时文件创建 FileSystem、加密失败 Unknown、下载打开 FileSystem、短头保留文件与 read_exact 上下文、解密临时文件 FileSystem/错密码 Validation、空密码过滤均对齐（`src/cloud_transfer.ts:27-29,58-109,127-176`）；11 个生产路径测试亲跑通过。Rust `cloud/mod.rs:429,453-460,627-641,663-694`。
  - [x] `src/cloud_commands.ts:111-118` 先disposeTemp、置null再done，finally清理失败路径；与Rust `cloud/mod.rs:522-538` 顺序一致。两条新workflow用例验证上传期间临时文件存在、done时为0、抛上传错误时清理且不done（`tests/cloud_transfer.test.ts:197-260`）；另用真实L21/真实HTTP/真实加密上传在实际事件发射点观察temp=0，见§11。此项不新增Rust不存在的即时取消检查。
- [ ] **P08 部分修复：DNS 和防降级断言通过，测试账本/未执行证据未闭合。**
  - [x] **P36原测试固定main已核**：6d759e81c的5000次单条apply、COUNT5000及严格<60s保留；固定树052304-887d64实测26795.298263ms通过。早前051007运行期间合main，单列混合树证据，不据它签收（§21）；W69不随P36关闭。
  - [x] **P20/W12原测试main已核**：eaa17bc7e保P20万条已同步日志、原内存schema及构造变更前的单调<500ms；W12保u64::MAX-1精确bigint及原Result观察。045657-34fbab两例通过，P20=8.211742ms；不扩签W69/P36或大整数转换策略（§20）。
  - [x] **A33/W55原测试main已核**：92365bc5c的A33保原apply及两次COUNT观察、不强加ID策略；W55用真实F3 readonly重开，断言实际apply的Database只读错误。044538-d2557a两例通过，范围不扩其余pending或W69（§19）。
  - [x] **A13原不崩溃用例main已核**：4b476f44c保留INTEGER列/字符串payload及真实公开apply，不catch吞异常、不自造成功计数；041136-cca61a中adversarial38/38通过。只确认A13这一原测试去向，不扩签A33或其余pending（§18）。
  - [ ] **a968主线规定gate新增压力/收尾红灯**：20261105004819-87e02a原exit1，S108超过180s、同文件afterAll h.dispose超过10s，另有Unhandled RPC onTaskUpdate超时/Errors1；W69仍47523.318129ms。selfgate实际ok=false，不是baseline豁免绿；未改预算或重跑同树求绿，已报C2安排owner最小定位（§17）。
  - [x] **b04原fixture已在main复核恢复**：c7a197cfc/cd20f3370恢复原内存schema/触发器与4MiB→5MiB输入，原断言/超时保留，真实公开apply；74252主线195643-18bfdd中business25/25通过。只签该子项，不关闭W69性能、Docker或整个P08，见§15。
  - [x] **复核确认**：防降级两条原测试补 Validation/details=null（`tests/mod.test.ts:50-103`），真实 invoke 的 marker/记忆拒绝也验证 Validation 和稳定码（`tests/commands_transfer.test.ts:171-218`）；亲跑通过。
  - [x] **复核确认**：S3 virtual-hosted 只替换 DNS lookup，仍跑真实 SDK/HTTP 并断言 Host/path（`tests/s3.test.ts:355-384`）；本次定向用例通过，不再依赖系统解析 test-bucket.localhost。
  - [x] **候选1da6dadc5复核确认**：TESTMAP表头与实际行数同步为 **242 ported / 615 pending / 2 merged / 0 obsolete**。`tests/mod.test.ts:50-66,94-106,124-143,169-173` 增补value.message一致性、分支诊断和opt-in日志；队列最小集亲跑通过。此处只签收增强断言与统计同步，不签收全部映射。
  - [x] **624cfe251的profile/FTP原断言已补回**：`tests/sync_android_platform.test.ts:123-148` 读取真实Cargo.toml，检查mobile-slim/android-release不含S3/独立FTP及default含S3，再检查运行时能力；对照Rust `sync_android_device_switch.rs:657-685`，亲跑通过。该原source-lock对象仍为保留的Rust移动构建配置，不是仅测试TS常量。
  - [x] **新子进程行为已实测**：`tests/device_identity.test.ts:73-102,209-244` 用spawnSync创建新Node进程、移除DEVICE_ID并隔离HOME/XDG、断言status=0；真实F4方法在子进程读盘/轮换/再次重启，原先仅实例重建的反证已修。两条新用例在加入固定F4 owner的组合树亲跑通过，未据批准表判断等价；原merged映射已撤回为pending，不因本次组合试验自动改动TESTMAP。
  - [ ] **账本仍未闭合**：624cfe251逐行240 ported/618 pending/0 merged/1 obsolete，表头一致。唯一obsolete为mobile_profiles_exclude_s3_and_keep_recovery_core，已核d5cd的C2审批分片。20条Docker未执行；新身份集成在无F4 API的裸候选树仍门控跳过，真实组合通过不等于main已集成。原config Android精确错误相等弱化项仍在 `tests/config.test.ts:87-90`。不以18条选择测试或owner全套声明关闭P08。
- [x] **P09 复核确认：职责拆分/共享工具/可擦除语法已对齐（624cfe251）。**
  - [x] **参数属性修复复核确认**：cb9中ManifestDecodeError及json_exact的三个类造成作业20261104070755-b0ffa4 exit1；da290已改为显式字段与构造赋值（`src/sync_manager.ts:170-179`、`src/json_exact.ts:14-25,37-46`及Parser构造）。本次真实P06组合Node v26.5原生导入整个L23入口成功，作业20261104072250-8b8a5a exit0。旧失败原文保留§9，不再标为da290当前加载错误；不因此证明新manifest算法或P03完整组合已通过。
  - [x] **复核确认**：`src/config.ts:2` 使用平台 trim，`src/device_id.ts` 只重导出；加密/文件头/解密/临时文件实现已迁至 `src/cloud_transfer.ts`，未引入生产测试替身。
  - [x] 当前 `index.ts:17-38,124-175,236-283` 保留所有者服务注入、provider/manager构造、命令注册和许可生命周期包装；策略/文件/进度/清理编排位于 `src/cloud_commands.ts:27-55,78-178` 和cloud_transfer.ts，本地守卫镜像已删除。扫描33个生产TS未见console或tests导入；当前真实Node入口可加载。此架构签收不豁免P04新parser的语义缺陷，Rust工作流仍按 `cloud/mod.rs:411-710` 对照。

## 建议

- [ ] 对 `SPEC.md:19` 已登记的 f32→double 进度差异请协调者明确裁定。实装 `index.ts:158-159`，Rust `cloud/mod.rs:492-495,593-596`；本次没有把“进度条只展示”当作严格等价证据。
- [ ] 增加真实插件组装的错误/守卫测试；传输和 manager 的单测不能证明前端命令可用。

## 已核实通过

以下保留首次 `f23c98702` 的核实结果；本轮修复通过项以各 P 编号和 §5 为准。

- [x] **复核确认**：契约确实仅有 14 条命令，全部声明/注册，无第 15 条可抽查。证据：`contracts/ipc/L23-sync-providers.json:1`、`index.ts:38-53,163-362`。下表全查 14 条，另查 createStorage 公共服务，不把它冒充命令。
- [x] **复核确认**：服务 `syncProvider` 的命名、版本描述、meta/provide 接线一致（`api.ts` 中 `syncProviderService`，`index.ts:94-104`）。
- [x] **复核确认**：静态扫描本 lane 29 个生产 TS 文件，未发现 console、跨插件非 api.ts 导入或测试替身导入。跨插件引用见 `index.ts:20`；不代表 P03/P09 已解决。
- [x] **复核确认**：防降级纯函数覆盖 marker/本机记忆/密文/一次性 opt-in 矩阵；补充测试还验证 warn（`tests/mod.test.ts:46-124,126-146`，Rust `cloud/mod.rs:139-172,804-879`）。
- [x] **复核确认**：原生 Node 可导入及 wiring 检查通过，原始摘要见下。

## 1. 命令等价逐项审读

“通过（入口）”仅确认所述入口语义；共享配置、传输和 manifest 问题仍适用。无 SQL 事务的命令不凭空要求 SQL 事务。

| 命令 | 结论、参数/返回/副作用证据 | Rust 对照 |
|---|---|---|
| cloud_storage_check_connection | 问题 P01；hydrate→构造→check→true 顺序本身一致，`index.ts:163-166` | `cloud/mod.rs:298-305` |
| cloud_storage_put | 问题 P01；Vec<u8> 转 Uint8Array，成功 null，`index.ts:169-172` | `cloud/mod.rs:310-318` |
| cloud_storage_get | 问题 P01；缺失 null、成功 number[] 正确，`index.ts:175-178` | `cloud/mod.rs:323-330` |
| cloud_storage_list | 问题 P01；prefix 原样转发、返回列表，`index.ts:181-183` | `cloud/mod.rs:335-342` |
| cloud_storage_delete | 问题 P01；await 删除后 null，`index.ts:186-189` | `cloud/mod.rs:347-354` |
| cloud_storage_stat | 问题 P01；Option<FileInfo> 原样返回，`index.ts:192-194` | `cloud/mod.rs:359-366` |
| cloud_storage_exists | 问题 P01；布尔返回，`index.ts:197-199` | `cloud/mod.rs:371-378` |
| cloud_storage_is_s3_enabled | 通过（桌面包含 S3 的构建范围）；恒 true，`index.ts:362` | `cloud/mod.rs:738-739` |
| cloud_sync_get_status | 问题 P01/P04/P05/P06；hydrate→manager→status，`index.ts:204-206` | `cloud/mod.rs:385-392` |
| cloud_sync_list_versions | 问题 P01/P04/P05/P06；列表顺序受纳秒比较影响，`index.ts:209-211`、`src/sync_manager.ts:132-141` | `cloud/mod.rs:397-404`、`cloud/sync_manager.rs:416-428` |
| cloud_sync_upload | 问题 P03/P07；可选 appVersion/note/recoveryKind 用 null，进度 0/100 与成功后 done 正确，`index.ts:220-262` | `cloud/mod.rs:411-540` |
| cloud_sync_download | 问题 P03/P07；allowPlaintextHistory 缺省 false、versionId 缺省 null 正确，`index.ts:270-345` | `cloud/mod.rs:553-710` |
| cloud_sync_delete_version | 问题 P03，guard 获取顺序颠倒且无释放，`index.ts:349-355` | `cloud/mod.rs:715-727` |
| cloud_sync_get_device_id | 问题 P06；环境优先路径正确，但旧目录、原子写和日志不同，`index.ts:360`、`src/device_id.ts:43-96` | `cloud/mod.rs:732-733`、`storage/data_space/device_id.rs:62-230` |
| 补充：createStorage（服务） | 问题 P01/P02；provider 选择结构一致，校验错误映射/枚举归一化缺失，`index.ts:62-82` | `cloud/mod.rs:228-276` |

## 2. ported 测试抽查（22 条）

TESTMAP 行 39–48、78–89；均亲读两侧断言。下列 `config` / `mod` 分别是 `tests/config.test.ts` / `tests/mod.test.ts`，Rust 同名 `cloud/*.rs`。

| Rust 测试名（模块） | TS:行 / Rust:行 | 结论 |
|---|---|---|
| test_config_validation（config） | config:16 / config.rs:429 | 通过：有效 DAV/S3、空 endpoint/password |
| test_https_enforcement_webdav | config:27 / config.rs:469 | 通过：公网 HTTP、伪造授权、loopback；未覆盖 P02 map-form |
| test_https_enforcement_s3 | config:35 / config.rs:533 | 通过：公网拒绝/本地允许 |
| test_debug_redaction | config:40 / config.rs:565 | 通过：密码遮蔽、AK 前缀 |
| test_default_root | config:50 / config.rs:598 | 通过：空、斜线、空白根路径 |
| test_is_local_endpoint | config:57 / config.rs:622 | 通过：八个同义向量 |
| test_localhost_evil_rejected | config:66 / config.rs:649 | 通过：DAV/S3 假 localhost |
| test_ftp_config_validation | config:71 / config.rs:683 | 通过：必填、TLS、本地例外 |
| test_ftp_rejected_on_android | config:87 / config.rs:735 | 问题：用注入 capability 覆盖拒绝分支，但 `.toThrow(string)` 弱于原完整错误相等；非桌面运行证明 |
| test_ftp_debug_redaction | config:92 / config.rs:758 | 通过：调用生产 debug 函数 |
| test_config_validation（mod） | config:100 / mod.rs:747 | 通过：生产 validator |
| test_provider_display | config:101 / mod.rs:761 | 通过：两个显示名称 |
| sync_e2ee_error_prefixes_stable_codes | mod:18 / mod.rs:767 | 通过：原三项 code 断言 |
| download_rejected_when_marker_present_but_object_not_dsbk | mod:33 / mod.rs:785 | 问题：遗漏 Validation 类型，见 P08 |
| download_allowed_when_marker_present_and_object_is_dsbk | mod:46 / mod.rs:804 | 通过 |
| download_allowed_for_legacy_plaintext_without_marker | mod:55 / mod.rs:812 | 通过 |
| download_allowed_for_dsbk_without_marker | mod:64 / mod.rs:819 | 通过 |
| download_rejected_when_marker_deleted_but_locally_remembered | mod:73 / mod.rs:827 | 问题：遗漏 Validation 类型 |
| download_allowed_for_dsbk_when_locally_remembered | mod:85 / mod.rs:842 | 通过 |
| download_opt_in_allows_plaintext_history_once | mod:94 / mod.rs:850 | 通过：三个象限 |
| download_opt_in_has_no_effect_on_ciphertext_and_default_still_rejects | mod:105 / mod.rs:862 | 通过 |
| download_head_classification_matches_backup_crypto_magic | mod:120 / mod.rs:872 | 通过：真实平台 crypto magic 判定 |

本 lane TESTMAP 实际为 ported 206 / pending 653 / obsolete 0 / merged 0。`migration/approvals.json:3-40` 不提供把上述 pending 自动免除的批准。wiring 是静态可达性，不证明测试完整、命令正常返回或公开 API 有生产消费方。

## 3. 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/sync-providers
CommandError: S3 上传失败: ENOTFOUND: getaddrinfo ENOTFOUND test-bucket.localhost
 ❯ S3Storage.put host/plugins/sync-providers/src/s3.ts:627:13
 ❯ host/plugins/sync-providers/tests/s3.test.ts:364:7
 Test Files  1 failed | 26 passed (27)
      Tests  1 failed | 303 passed (304)
   Duration  26.80s
exit=1
$ node scripts/electron-migration/importable.mjs host/plugins/sync-providers/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane sync-providers
合计 ported 206，其中所测模块未从 index.ts 接入 0（0.0%）
```

日志：`/tmp/opencode/R4-sync-providers-vitest.log`。额外只读代码/临时宿主探针的实际输出：

```text
createStorage missing config: CloudStorageConfigError null 缺少 WebDAV 配置
unit-map HTTP config accepted: WebDavStorage
decodeManifest accepted: {"versions":[]}
decodeManifest accepted: {"version":1,"versions":[{"id":"a","checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":-1,"timestamp":"invalid","deviceId":"d"}],"latest":"a","updatedAt":"bad"}
nanosecond merge latest= z updatedAt= 2026-11-04T00:00:00.123000001Z
```

## 4. 架构与语义差异归类

- **缺陷（应修）**：P01–P09；尤其 API 缺失导致已注册命令不可用、普通错误成为 panic、serde 校验缺失与身份路径变化，均不是平台必然差异。
- **已登记的平台差异**：`SPEC.md:19` 的 f32 进度精度；`docs/dev/electron-migration/decisions.md:24-31` 的 Electron Argon2 实现/待补跨平台 crypto 向量，及 `:52-59` 的平台时间生成精度。上述记录不豁免 P05 对已有时间数据的排序。
- **复核确认**：本 lane 无 SQL 表写入；对外调用仅经 backup/secrets API；生产文件没有导入 tests。架构仍因 P03/P09 不通过。
- **B 级状态**：有未修缺陷、未闭合 TESTMAP 和一个实际测试失败，不成立。

## 5. C2 指定 L23 修复定向复核（c7c15e5b5）

### 独立结论与范围

本轮固定 L23 为 `c7c15e5b5bfe139e11d2699bbd98bf9605d8beba`；不采用其中实现者全勾的 ACCEPTANCE。最小集只覆盖本次修复：commands_errors、manifest_decode、cloud_transfer、device_identity、commands_transfer、mod，以及 S3 原失败的 virtual-hosted lookup 一例。读取所涉 Rust 四个文件与首次基线无差异，仍只读、不编译/运行 Rust。

| 编号 | 本轮结论 |
|---|---|
| P01 | 关闭：真实 invoke 配置错误形状通过 |
| P02 | 关闭：map-form 校验修复 |
| P03 | 未关闭：main 无提供方；optional release/空 ID 仍可成功；候选提供方大小写和 busy 错误不兼容 |
| P04 | 部分修复：形状门有了，但 raw token/重复字段/u64范围/错误文案/chrono serde 格式仍不同 |
| P05 | 关闭：纳秒排序及更新时刻比较修复 |
| P06 | 部分修复：平台复用正确，但选择了 L20 包装语义而非 L23 原身份优先级；生产 logger 未接 |
| P07 | 部分修复：原失败分支通过；加密临时文件成功清理仍在 done 之后 |
| P08 | 部分修复：Validation 断言/S3 lookup 通过；624 pending、20 Docker 未运行、表头未同步 |
| P09 | 部分修复：trim/文件助手抽出；index 仍含业务编排 |

### 最小集亲跑输出

命令从 R4 工作树执行，以 `git archive c7c15e5b5` 创建原样测试副本 `/tmp/opencode/R4-L23-c7c15e5b5-wrMSgc`（host/contracts/测试配置），引用既有 node_modules。未切分支、未写实现/测试、未写其它 lane 工作树。

```sh
node node_modules/vitest/vitest.mjs run \
  --root /tmp/opencode/R4-L23-c7c15e5b5-wrMSgc \
  -c /tmp/opencode/R4-L23-c7c15e5b5-wrMSgc/vitest.host.config.ts \
  --no-cache --maxWorkers=1 \
  host/plugins/sync-providers/tests/commands_errors.test.ts \
  host/plugins/sync-providers/tests/manifest_decode.test.ts \
  host/plugins/sync-providers/tests/cloud_transfer.test.ts \
  host/plugins/sync-providers/tests/device_identity.test.ts \
  host/plugins/sync-providers/tests/commands_transfer.test.ts \
  host/plugins/sync-providers/tests/mod.test.ts
```

```text
 ✓ host/plugins/sync-providers/tests/mod.test.ts (12 tests) 19ms
 ✓ host/plugins/sync-providers/tests/manifest_decode.test.ts (9 tests) 25ms
 ✓ host/plugins/sync-providers/tests/cloud_transfer.test.ts (11 tests) 1643ms
 ✓ host/plugins/sync-providers/tests/commands_errors.test.ts (9 tests) 860ms
 ✓ host/plugins/sync-providers/tests/device_identity.test.ts (6 tests) 2057ms
 ✓ host/plugins/sync-providers/tests/commands_transfer.test.ts (6 tests) 2506ms
 Test Files  6 passed (6)
      Tests  53 passed (53)
   Start at  13:05:03
   Duration  5.25s
exit=0
```

另以同一 root/config、同样 `--no-cache --maxWorkers=1` 运行：

```text
host/plugins/sync-providers/tests/s3.test.ts -t 'keeps the endpoint path prefix for virtual-hosted requests'
 ✓ host/plugins/sync-providers/tests/s3.test.ts (43 tests | 42 skipped) 122ms
 Test Files  1 passed (1)
      Tests  1 passed | 42 skipped (43)
   Start at  13:05:09
   Duration  2.29s
exit=0
```

共亲跑 **54 个用例通过**。这里42 skipped 是 `-t` 主动排除的无关 S3 用例，与20条 Docker 门控测试不同；本轮没有运行 Docker 套件或全套354例。Docker 条件仅作静态核对：`tests/sync_provider_contract.test.ts:24,292` 对 Rust `src-tauri/tests/sync_provider_contract_tests.rs:1998-2455` 的原 ignore。

### 测试真实性边界

- `tests/host_fixture.ts:41-66` 安装真实 L23、真实 F4 Paths/BackupCrypto，L21 hydrate 和 guard 是契约侧替身；因此 commands_transfer 验证真实传输/命令边界，**不证明 L21 共享锁已经接通**。
- S3 lookup 夹具只将 DNS 指向本地服务，未替换 SDK 签名/传输/路径逻辑，Host 和 gateway prefix 断言保留。
- manifest_decode 的正向验证仍有错误预期：`:120,131-132` 期待 +00:00；必须对照 Rust 的 Serialize，而不能把“测试过了”当格式正确。

### 定向反例原始输出

均在固定快照中通过 Node 原生 TS 导入执行，未修改测试。

```text
manifest normal {"version":1,"size":4,"timestamp":"2026-01-01T00:00:00+00:00","updatedAt":"2026-01-01T00:00:00+00:00"}
manifest float integer token {"version":1,"size":4,"timestamp":"2026-01-01T00:00:00+00:00","updatedAt":"2026-01-01T00:00:00+00:00"}
manifest duplicate field {"version":1,"size":4,"timestamp":"2026-01-01T00:00:00+00:00","updatedAt":"2026-01-01T00:00:00+00:00"}
manifest u64 above safe REJECT {
  error_type: 'Unknown',
  message: 'manifest manifest.json 损坏: invalid value: 9007199254740992, expected u64 for `size`',
  details: null
}
manifest missing fields REJECT {
  error_type: 'Unknown',
  message: 'manifest manifest.json 损坏: missing field `version`',
  details: null
}
device priority {"DEVICE_ID":"env-id"} actual= legacy-id
device priority {} actual= legacy-id
guard without operationId/release download= true event operationIds= [""]
```

复现输入：

1. manifest 基础对象 `{version:1,latest:'v1',versions:[{id:'v1',timestamp:'2026-01-01T00:00:00Z',size:4,checksum:'a'.repeat(64),deviceId:'d'}],updatedAt:'2026-01-01T00:00:00Z'}`。分别把原始 JSON 文本 `"version":1` 改为 `"version":1.0` 或 `"version":2,"version":1`；把 `"size":4` 改为 `"size":9007199254740993`。调用生产 decodeManifest('manifest.json', Buffer.from(text))。缺字段输入为 `{"versions":[]}`。
2. 使用 createSyncHost({env})，在其临时 app.dataDir 同时写 `.device_id=primary-id` 与 `device_id=legacy-id`，真实 invoke cloud_sync_get_device_id。Rust `storage/data_space/device_id.rs:205-219,126-158` 分别应返回 env-id / primary-id；当前两者均返回 legacy-id。
3. createSyncHost 的 guard 返回空对象 `{}`；stateful DAV 种入合法 manifest 与四字节 PK ZIP 头对象，checksum 为真实 SHA256，执行真实 cloud_sync_download。得到成功结果且进度 ID 为空，证明缺 release/ID 被默许；不是仅 grep finally。

**chrono 隐式库行为证据**：`src-tauri/Cargo.lock:1842-1845` 锁定 chrono 0.4.41；只读查阅该版本 [src/datetime/serde.rs:32-50](https://github.com/chronotope/chrono/blob/v0.4.41/src/datetime/serde.rs#L32-L50) 的 Serialize：`write_rfc3339(..., SecondsFormat::AutoSi, true)`，其 `test_serde_serialize` 明确期望 UTC 以 Z 结尾。项目 Rust BackupVersion/CloudManifest 在 `cloud/sync_manager.rs:104-143` 派生 Serialize、字段为 DateTime<Utc>，无改写 serializer。故不能将 TS 的 `.to_rfc3339()` 风格 +00:00 认作等价；没有运行 Rust。

### P03 与真实 L21 候选提供方的组合探针

L21 也固定到 `46bb99a298b7b3920b51c0b8ad6a163e46414a97`，原样测试副本 `/tmp/opencode/R4-L21-46bb99a298-vscuuo`。通过其 createBackupHost 安装**真实 backup 插件**，在同一 Host 安装上述 c7 的 L23，使用真实 BackupCrypto/Paths；持锁调用只到配置/守卫边界，不运行备份/恢复数据工作流。平台操作锁使用 L21 快照的真实实现，没有替换 guard。

```text
real L21 guard backup => prune
real L21 guard restore => prune
real L21 guard prune => prune
real L21 guard Backup => backup
real L21 guard Restore => restore
real L21 guard Prune => prune
real L21 held -> real L23 invoke: HandlerPanic command "cloud_sync_upload" panicked (in production the frontend promise would never settle): 已有数据治理操作正在运行（当前 Backup，operation_id=42015ec3-dea1-4055-a264-e67e9cc7e014）
real L21 permit after release: restore
```

探针先逐个调用真实 backup.tryAcquireOperation(kind)，读实际 guard.snapshot.kind 并 release；再持 `Backup` guard，真实 invoke upload(config={},zipPath='/nonexistent/r4.zip')；释放后取得 `Restore` 成功。这个结果证明有实际许可争用/释放，也同时证明大小写与 busy 错误形状尚未对齐；**不证明全局屏障、跨进程所有分支或 B02/B03 已通过**。候选提供方尚未进入被审 c7 main。

最新独立判定：**P01/P02/P05 已修，六组未决，B 不成立。** P07 的清理/完成事件顺序及 P09 的残留工作流由源码直接证实，未为它们重复全套测试。

## 6. 架构裁定与授权合并（main e303957124）

按C2/架构师授权合并 `e303957124ac220f55bee1b04cca5d3937983b92`，冲突仅在本文件。保留独立P组与已核实子项；main的 [BLOCKERS.md](BLOCKERS.md) 保留为后续分派线索，624 pending/20 Docker门控事实已纳入P08，但实现者自评全绿、自有剩余清零或B14不作为签收依据。

`decisions.md` D2要求许可唯一归L21、guard.release必需，进一步确认P03不能靠optional release通过。D3要求Host内部整数/纳秒精确，仅IPC边界可按Tauri JSON number表示，故P04中内部manifest安全整数拒绝不被批准；P05纳秒修复仍有效。D1/D4允许所有者业务API的同事务SqlExecutor接缝，不改变“调用方不得写他表”的约束。`quality.md` §10的生产入口、原断言、业务Err、日志及Errors/退出码要求全部沿用。

`git diff c7c15e5b5 e303957124 -- host/plugins/sync-providers host/plugins/backup/{api,index}.ts host/plugins/backup/src/operations.ts host/plugins/sync-support host/platform/paths` 无差异，本轮没有新的L23修复可重签；L21候选46bb99a298仍不可称作main提供。合并后门禁结果统一记在 `docs/dev/electron-migration/audits/R4-review-sync.md` 的本次合并节。

## 7. 新候选 P03 / P08 补审（全局作业队列）

### 固定对象与 main 可见性

- L23候选：`1da6dadc5580a6ff9a6cfe59abf1a3a77aef7e1c`，含C2指定的前序修复。
- 实际读取到的最新L21候选：`e4dd1772f1248d8e2a7c706416b2fbe66fc90ad1`；已不同于§5的46bb99a298：公开kind现为snake_case，忙锁/IO现为CommandError(string)。不能拿旧提供方的类型证明新组合可用。
- 本轮可见性基线main：`15b23540a97ee19e1391859c3bc140e5c0daa182`。`git merge-base --is-ancestor <候选> <固定main>` 对上述两个候选均exit=1；main的backup/api.ts:91-98仍没有guard方法。本轮不合入候选实现，只更新验收文档。
- 所有测试/探针通过 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- ...` 提交；cwd始终为R4，排队时审读Rust、API和TESTMAP。无直接运行tsc/vitest/build，也未重复未变P04/P07全套。

### 作业一：新增命令/断言最小集

L23完整固定树的原样测试副本：`/tmp/opencode/R4-L23-1da6dadc5-N1Ie5F`。调用既有Vitest，参数：

```text
node /home/dsdev/dev/ds-mig/R4-review-sync/node_modules/vitest/vitest.mjs run
--root /tmp/opencode/R4-L23-1da6dadc5-N1Ie5F
-c /tmp/opencode/R4-L23-1da6dadc5-N1Ie5F/vitest.host.config.ts
--no-cache --maxWorkers=1
host/plugins/sync-providers/tests/commands_transfer.test.ts
host/plugins/sync-providers/tests/mod.test.ts
host/plugins/sync-providers/tests/sync_android_platform.test.ts
```

`job.mjs result 20261104061655-9d17c0 --tail 200` 输出摘要及原退出码：

```text
 RUN  v3.2.7 /tmp/opencode/R4-L23-1da6dadc5-N1Ie5F
 ✓ host/plugins/sync-providers/tests/mod.test.ts (12 tests) 19ms
 ✓ host/plugins/sync-providers/tests/sync_android_platform.test.ts (9 tests) 16ms
 ✓ host/plugins/sync-providers/tests/commands_transfer.test.ts (8 tests) 2286ms
 Test Files  3 passed (3)
      Tests  29 passed (29)
   Start at  14:16:56
   Duration  4.75s
[作业 20261104061655-9d17c0] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104061655-9d17c0.log
```

没有Errors行。29通过不代表与Rust全部等价，尤其新测试只注入自造plain busy Error、raw AppError；它们未模拟实际所有者把业务错误包成CommandError(string)的过程。release-throws用例验证主错误不被覆盖，未验证warn；移动feature用例漏掉原profile/FTP事实。不能据绿关闭P03/P08。

### 作业二：同一 kernel 下的真实 L21 / L23 组合

为避免两个独立快照各自导入CommandError类造成 `instanceof` 假差异，组合副本 `/tmp/opencode/R4-P03-1da6-e4dd-blzsii` 先原样提取e4dd的host/contracts/package，再只覆盖1da的 `host/plugins/sync-providers/`，无修改源文件。两插件在**同一个kernel模块实例**下运行；它是明确的候选组合，不是main。

作业 `20261104062036-519809` 以 `node --input-type=module -e <内联探针> <上述root>` 执行。步骤：

1. 使用e4dd的createBackupHost装真实backup；secrets.backup为真实createBackupCrypto，设置/凭据用测试侧Map固定输入；安装同树真实Paths和1da sync-providers。guard/Operations/文件锁完全不替换。
2. 对大小写kind逐个取真实guard，读取 `<临时appData>/recovery/.data-governance-operation.lock` 的实际kind再release。
3. 持有 `tryAcquireOperation('backup')`，先看提供方再取锁错误的 `.value`，再真实invoke `cloud_sync_upload({config:{},zipPath:'/nonexistent/r4.zip'})`。恢复持有许可后，将临时recovery目录移除并创建同名普通文件，真实触发锁目录创建失败；同样读取provider `.value` 及invoke错误，随后删掉测试文件。
4. 无锁下invoke缺配置upload，检查错误后能否再取restore许可。向本地stateful DAV种入v1合法manifest和4字节PK头，hash真实计算；Map设置持久化云配置，真实L21 hydrate读取它，调用真实L23下载，检查返回字节、非空ID及随后取得backup许可。
5. **单独的异常边界注入**：createSyncHost分别给guard抛TypeError、缺方法、返回空对象/缺release对象。此部分只验证消费者未知异常边界，不冒称真实L21会故意返回这些对象。

`job.mjs result 20261104062036-519809 --tail 240` 的stdout及退出码原文：

```text
provider kind Backup ledger= Backup
provider kind Restore ledger= Restore
provider kind Prune ledger= Prune
provider kind backup ledger= backup
provider kind restore ledger= restore
provider kind prune ledger= prune
provider busy error value= "已有数据治理操作正在运行（当前 Backup，operation_id=0d5b9119-9550-4efb-bf3a-738ad2294038）"
invoke busy= "[dstu-host] command \"cloud_sync_upload\" rejected with a value that violates its contract (L23-sync-providers.json): must be object"
provider IO error value= "创建数据治理跨进程锁目录失败 \"/tmp/dstu-test-host-A4P3bL/recovery\": EEXIST: file already exists, mkdir '/tmp/dstu-test-host-A4P3bL/recovery'"
invoke IO= "[dstu-host] command \"cloud_sync_upload\" rejected with a value that violates its contract (L23-sync-providers.json): must be object"
invoke config failure= {"error_type":"Validation","message":"缺少 WebDAV 配置","details":null}
real permit after command failure= restore
real-provider download= true next permit= backup
download operationIds nonempty= true
unknown TypeError => {"error_type":"Unknown","message":"unexpected provider bug","details":null}
missing provider => {"error_type":"Unknown","message":"ctx.backup.tryAcquireOperation is not a function","details":null}
guard empty => HandlerPanic: command "cloud_sync_upload" panicked (in production the frontend promise would never settle): guard.operationId is not a function
guard lacks release => {"error_type":"Validation","message":"缺少 WebDAV 配置","details":null}
[作业 20261104062036-519809] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062036-519809.log
```

这是观测探针：exit=0表示探针完成且自行捕获并打印结果，**不是缺陷测试通过**。Rust busy应Validation、锁目录IO应FileSystem，均应AppError对象（`storage/backup_common.rs:149-166,236-251`）；新组合已不再走旧的HandlerPanic，但仍是错误wire形状。未知TypeError应按kernel panic而非Unknown业务值；`index.ts:119-130` 同时存在“已识别CommandError盲透传”和“未识别异常过度转换”两种错误。

### 作业三：缺 release 的成功分支

作业 `20261104062334-d22bc2` 使用同一组合树的真实L23、真实本地DAV/manager，只对外部guard注入 `{operationId:()=> 'no-release'}`，真实下载v1；不再注入release spy。

```text
guard missing release successful download= v1 done= true
[作业 20261104062334-d22bc2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062334-d22bc2.log
```

该探针专门区分“去掉optional语法”和“没有release时不再默许成功”：后者仍未满足，因为缺方法抛出的TypeError在释放catch里被吸收。修复不要求新增通用防御层，而是使用所有者真实契约，并区别预期释放IO错误与契约/编程错误。

### P08 新映射核查与范围限制

- 原始行数亲自统计：242 ported、615 pending、2 merged，表头匹配。
- 新增mobile_feature_profiles_exclude_s3_backend从pending改ported；Rust检查mobile-slim/android-release真实Cargo feature数组、禁S3/独立FTP且default启用S3。TS只断言runtime S3布尔及返回它的函数，遗漏原FTP/profile约束。该用例虽在29例中通过，B证据不成立。
- 两条merged ID见TESTMAP:248,263；merged无需单独批准，原以审批缺失判缺陷的理由已撤回。保留对目标用例未覆盖原子进程/环境隔离/退出状态的行为反证。另一个 `mobile_profiles_exclude_s3_and_keep_recovery_core` 的mobile-only obsolete批准不覆盖带桌面控制组的profile测试，profile/FTP断言缺失独立审读。
- 两条device identity目标用例重建同进程Paths实例（`:22-33,125-163`），原Rust拉新进程并断言退出成功；现仅证明实例重建/文件回读，未证明相同进程隔离。未为此追加CPU测试求绿。
- 新增data_space_cutover四条不在本次P03错误边界最小集，未借实现者报告替它们签收。本轮不重跑P04/P07、Docker、S03；也不因L11提供计数API关闭S04，需实际消费写者/同事务证据。
- **P03与P07严格分开**：真实许可在成功/配置失败finally释放已核实；密文临时文件仍在 `index.ts:276` done之后、`:279` dispose，P07该次序问题保留，不用许可释放通过掩盖。

本次独立结论仍“不通过”；P01/P02/P05已关闭不回退，P03/P08等六个未决P组保持。363passed/20skip为实现者声明，不是本次作业输出。

## 8. P08 merged规则纠正（C2，9c13dfc39）

已独立读取 `9c13dfc39:scripts/electron-migration/lib/ledger-core.mjs:40-44,51-78`：只有obsolete读取approvals；merged检查目标文件、目标标题以及Vitest报告中的执行结果，不要求额外审批。因此撤回28c7db303/7d10485eb中的“两个merged缺批准”理由，相关正文已修正，不能再引用此理由派回。

未撤回的事实：目标device_identity用例在同进程重建Paths，不证明原Rust新进程启动、隔离环境及退出成功；mobile_feature_profiles新用例未保留两个实际构建profile/FTP断言。这些是断言与被测对象不等价，和审批规则无关。P08编号组仍未闭合，未决组数不因撤回一个错误理由而改变。本次规则纠正不需要CPU测试，未提交重复作业。

## 9. 继续B组时发现的新候选组合加载阻塞

已固定L21=`19c023cd63ff456e0dadc4d2cfd841924455b935`、L23=`cb9d683d0fd782a04188cc1661dd6598fdbc1771`，main可见性=`f37426009bc33c55093be35a1fa82aa31b271965`（其backup/api.ts仍无tryAcquireOperation/OperationGuardError）。这是新改相关的B03/P03增量，未重复e4dd的B02/B09测试，也未完整重审cb9新manifest/身份/清理代码。

组合副本 `/tmp/opencode/R4-P03-19c0-cb9d-aCHUJq` 使用19c原样host/contracts/配置，加cb9原样sync-providers目录，共享同一kernel。队列作业 **20261104070640-d367ed** 选择两个文件中新guard相关用例：

```text
host/plugins/backup/tests/operation-and-sync-ports.test.ts
host/plugins/sync-providers/tests/commands_transfer.test.ts
-t 'busy and lock IO expose|maps L21|structured provider|primary error|acquires before|releases after|does not report|unknown provider|tolerates an expected'
--no-cache --maxWorkers=1
```

`job.mjs result ... --tail 200` 原始摘要：

```text
 ✓ host/plugins/backup/tests/operation-and-sync-ports.test.ts (11 tests | 10 skipped) 612ms
 ✓ host/plugins/sync-providers/tests/commands_transfer.test.ts (13 tests | 3 skipped) 3040ms
 Test Files  2 passed (2)
      Tests  11 passed | 13 skipped (24)
   Start at  15:06:41
   Duration  7.01s
[作业 20261104070640-d367ed] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070640-d367ed.log
```

13 skipped为名称过滤未选，非失败删除。没有Errors行。提供方新增用例通过真实backup.tryAcquireOperation触发忙锁和锁目录IO，验证reason/code/app_error/value；L23测试走真实invoke，但guard由测试侧提供，仍不能替代新pair真实组合。

随后作业 **20261104070755-b0ffa4** 用Node原生TS加载同树真实L21/L23，计划验证持锁/IO、成功下载、账本kind及释放。实际在导入阶段中止，所有计划的业务调用均**未执行**：

```text
file:///tmp/opencode/R4-P03-19c0-cb9d-aCHUJq/host/plugins/sync-providers/src/sync_manager.ts:171
  constructor(message: string, readonly line?: number, readonly column?: number) {
                                        ^^^^^^^^^^^^^
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
Node.js v26.5.0
[作业 20261104070755-b0ffa4] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104070755-b0ffa4.log
```

没有修改实现、启用转译或删失败以求绿；把该新阻塞记入P09，P03真实组合仍待验证。静态进展：19c提供方结构化错误已通过新测试，cb9 kind改为正式snake_case，获取错误不再按message前缀分类（`src/backup_operation_guard.ts:15-16,50-62`），未知普通Error透传、缺release主动拒绝（`:66-77`）；仍保留对旧CommandError(string)的FileSystem兜底，正式契约集成后应收敛。这些是限范围静态/测试证据，不足以整组关闭。

本轮P08纠正针对1da旧报告；cb9确有新增子进程fixture等修改，但未在本轮执行/全面审读，不能将旧P08反证冒充其当前结果，也不据文件存在签收。main可见性、运行语法与断言等价分开记账。

## 10. P06 owner交付与实际消费组合（da290fd2e / 679b53948）

收到C2平台交付时未直接勾选P06、也未重复其35例。读取发现L23分支已前进到 `da290fd2efd1fd11346b08653941d9b70d4bc620`，确实删除了上一版optional/env/WeakMap/WithoutMethod桥，形成新的实际消费提交，因此按既有计划仅验证这条新消费路径。F4固定 `679b5394896df3acde87eb29e04219db1acf9bb8`（含d85995b4b交付）；C2报告作业20261104063141-9a504c的35/35只记为协调者证据，未冒称R4亲跑。

### 静态核对

- F4 `paths/api.ts:119-125` 发布必需dataSpaceDeviceId；`paths/index.ts:301-309,386-387` 保留Rust底层身份优先级及失败后稳定身份；`:366-384` 保留旧deviceId包装，不混为同一个入口。
- L23 `src/device_identity.ts:17-22` 仅直接调用方法，`index.ts:170-172,296` manager和cloud_sync_get_device_id一致消费。保留的交叉类型断言只为尚未整合的API类型，不再提供运行时fallback或独立身份编排。
- F4生产插件 `paths/index.ts:424-434` 使用已存在的log服务logger或ctx.logger并传给createPaths；不再因生产apply没传log落入工厂console默认路径。
- 固定main `679fd3e4d3bdaff9d38188aab851704e952b9ac0` 的PathsService仍无dataSpaceDeviceId；F4/L23两候选的祖先检查均exit1。生产能力仍需共同集成，不用分支API存在声明main可用。

### 唯一新增作业与真实入口

原样组合副本 `/tmp/opencode/R4-P06-da290-679b-pG5aIx`：da290整套host/contracts，加679b原样platform/paths目录，引用现有依赖。所有命令cwd为R4，只提交一次全局作业 **20261104072250-8b8a5a**，以 `node --input-type=module -e <断言探针> <root>` 原生导入，无Vitest/转译。

每个场景各建临时appData，把该作业进程的HOME/XDG/DEVICE_ID设置到隔离目录，结束恢复环境并清理自身夹具。`createTestHost`安装**真实F4 paths插件和真实L23插件**，通过host.invoke('cloud_sync_get_device_id')进入生产调用。secrets.backup为真实BackupCrypto；backup未用到的hydrate为外部测试输入。log服务提供仅记录info/warn/error的契约接收器，生产paths.apply自己取得logger并连接工厂；没有用createPaths工厂替换生产paths插件、没有覆盖dataSpaceDeviceId。

5个含Node assert的场景：

1. env-id、primary-id、legacy-id共存：返回env-id，primary文件不变。
2. 无DEVICE_ID但主/旧两文件共存：返回primary-id，primary不变。
3. 只有旧根文件：返回legacy-id、primary写回同值、记录迁移info。
4. primary路径为目录且旧根文件可读：返回旧身份，生产logger记录迁移失败warn。
5. primary路径为目录且无legacy：记录持久化失败error，同一host第二次调用返回同一临时身份。

`job.mjs result 20261104072250-8b8a5a --tail 150` 原始stdout及退出码：

```text
native imports: ok
env > primary > legacy PASS env-id []
primary > legacy PASS primary-id []
legacy migrates only when primary absent PASS legacy-id ["info"]
migration failure logs via production log service PASS legacy-readable ["warn"]
persistence failure logs and preserves process identity PASS device-76637d2f ["error","error"]
P06 owner-plugin/consumer-command assertions: 5 scenarios passed
[作业 20261104072250-8b8a5a] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104072250-8b8a5a.log
```

这是有断言的成功探针，断言失败会使作业非零退出；无Errors输出。它证明真实日志接线调用，不声称测试了日志文件落盘或Win/macOS动态行为。实际加载入口也验证da290已修复cb9的不可擦除语法，但未再次运行B组旧测试或完整P03组合。

**结论：P06在这对候选上复核通过，main集成仍待；P03/P04/P07/P08/P09共五组未决。** C2消息本身不产生测试重复，运行的依据是确实新增且已静态确认的L23正式消费改动。

## 11. 正式 L21 API 接入后的增量复核（624cfe251 / d5cd234aa）

### 基线与本轮判定

协调者指定正式main基线 `d5cd234aa8a919807b65eeca250e5567cc527f95` 已包含19c023cd6的结构化许可错误：直接读取 `host/plugins/backup/api.ts:92-123,174-188`，不再要求集成旧e4dd。L23精确候选 `624cfe2515b5c6cb1dd49ba010e58930f01847c3` 是d5cd后代，正式消费api.ts，旧镜像已删除。16a9318e7所称P04/P07主要实现保留在此候选中，本轮以624实际树而非自述签收。

测试副本 `/tmp/opencode/R4-L23-624c-d5cd-dgU4Ql` 原样提取624的host/contracts/原Cargo.toml/配置，并添加F4固定679b53948的paths目录。**L21提供方已在指定main，F4身份方法仍为待集成组合**；不能把后者写成main已可用。测试不修改实现/测试文件，不编译运行Rust。已闭P01/P02/P05不重新全审。

| 编号 | 最新结论 |
|---|---|
| P03 | 消费侧已修：正式API、snake_case、原样结构化错误、显式release，真实L21持锁/IO及成功上传后重取许可有证据；供方B03其余问题单独保留 |
| P04 | 部分修复：旧token/u64解码/UTC Z断言通过；未知字段重复被误拒、原型字段补必填、错误文本/位置、内部Number转换仍未修 |
| P07 | 已修：真实加密上传done时临时文件已清理；helper失败分支和源码finally保留 |
| P08 | 子进程/profile/FTP反证已修并实测；240/618/0/1账本和Docker/owner集成限制仍未闭合 |
| P09 | 已修：文件/策略/进度编排归src，接口镜像删除，原生可导入；parser行为仍归P04 |

### 增量测试作业（中断恢复后只取结果，未重提）

作业 **20261104074106-d92aa8** 选择manifest_decode、cloud_transfer、device_identity、sync_android_platform中变更相关用例：

```text
--no-cache --maxWorkers=1
-t 'rejects|accepts|ignores|treats|removes the encrypted temp file|sync_r07_device_id_probe|r09_device_id_probe_subprocess|mobile_feature_profiles_exclude_s3_backend'
```

result原始摘要：

```text
 ✓ host/plugins/sync-providers/tests/manifest_decode.test.ts (11 tests | 2 skipped) 64ms
 ✓ host/plugins/sync-providers/tests/cloud_transfer.test.ts (13 tests | 11 skipped) 935ms
 ✓ host/plugins/sync-providers/tests/sync_android_platform.test.ts (9 tests | 4 skipped) 28ms
 ✓ host/plugins/sync-providers/tests/device_identity.test.ts (8 tests | 6 skipped) 5080ms
 Test Files  4 passed (4)
      Tests  18 passed | 23 skipped (41)
   Start at  15:41:07
   Duration  10.64s
[作业 20261104074106-d92aa8] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074106-d92aa8.log
```

实际选择9个解码、2个清理工作流、2个真实子进程、5个平台/profile用例（正则同时选到接受/拒绝控制项），不是全套。23 skipped为名称过滤；两条原P05排序用例未重跑。没有Errors行。子进程fixture确实运行新的Node、清DEVICE_ID并隔离HOME/XDG、检查退出状态；加入真实owner后执行，没有用同进程Paths重建代替。profile断言读取真实保留的Cargo.toml，两移动profile/FTP/default控制均有原义。

### 真实许可与清理探针，以及保留的失败归因

作业 **20261104074838-775a11** 在同一kernel安装真实L21、L23，真实F4加密/Paths和本地HTTP DAV；SSOT/凭据为测试输入，guard/manager/上传代码不替换。先持backup许可检查invoke拒绝，再以普通文件recovery触发真实锁IO，最后真实加密上传并在progress emit同步观察磁盘和锁账本。

下列断言成功并已输出：

```text
P03 real busy= {"error_type":"Validation","message":"已有数据治理操作正在运行（当前 Backup，operation_id=4e175dd5-099c-454b-b92c-b65eab8404bc）","details":null}
P03 real IO= {"error_type":"FileSystem","message":"创建数据治理跨进程锁目录失败 \"/tmp/dstu-test-host-8juoWY/recovery\": EEXIST: file already exists, mkdir '/tmp/dstu-test-host-8juoWY/recovery'","details":null}
P03/P07 real encrypted upload done temp= 0 kind= backup next permit=restore
```

随后复核者试图在transferring事件abort全局token，预期此次上传必然reject。实际成功，探针断言失败：

```text
AssertionError [ERR_ASSERTION]: Missing expected rejection.
    at async file:///home/dsdev/dev/ds-mig/R4-review-sync/[eval1]:28:6
Node.js v26.5.0
[作业 20261104074838-775a11] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104074838-775a11.log
```

**归因：复核预期错误，不是已证实现缺陷。** 补读Rust `cloud/webdav.rs:1119-1269` 后确认令牌只在退避/限流等待点参与（`:1178`及acquire_request_slot），成功的首轮流式PUT没有这个即时取消检查；TS `src/webdav.ts:543-569` 同形。本次局部服务没有进入等待，不能要求比Rust更强的取消点。未改实现、未删失败、未重跑先前已成功的断言；该作业不能列“全绿”，也不把它当成P07清理失败。失败后的P04探针没有执行，故另起下一个只包含P04的新作业。

P03签收的是正式消费者传递/释放行为；供方原生文件锁语义及IO底层Display保真由B03/F3继续跟踪，不因消费者保持provider原值就认证整个跨进程实现。P07原先的“done早于清理”在真实成功上传已验证，失败finally另有已过的生产workflow用例。

### P04新反例：只执行前一作业未到达的部分

作业 **20261104075808-88807e** 原生导入生产decodeManifest/encodeManifest，输入公共部分 `"versions":[],"updatedAt":"2026-01-01T00:00:00Z"`：

- 正常version=1 + 未知extension对象，其内部 `"x":1,"x":2`；Rust默认忽略extension，TS全局重复键闸错误拒绝。
- 缺顶层version，增加未知 `"__proto__":{"version":1}`；普通对象赋值改变本次解析对象的prototype，`in`读到继承字段导致错误接受；Rust仍应missing version。
- updatedAt=false及缺version，观察实际错误文案/位置，不仅匹配“有column”。

原文：

```text
P04 unknown extension duplicate REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: duplicate field `x` at line 1 column 82","details":null}
P04 unknown proto supplies required version ACCEPTED {"version":1,"versions":[],"updatedAt":"2026-01-01T00:00:00Z"}
P04 boolean timestamp REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: invalid type: boolean, expected a string for `updatedAt` at line 1 column 46","details":null}
P04 missing version REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: missing field `version` at line 1 column 16","details":null}
[作业 20261104075808-88807e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104075808-88807e.log
```

这是捕获并打印的反例，exit0不表示语义通过。Rust依据为 `cloud/sync_manager.rs:104-143` 的普通derive struct与`:487-491`直接serde_json解码；没有deny_unknown_fields。精度剩余路径另经源码查明：TS内部 `Number(version.size)` 两处尚未移到IPC边界，见P04子项。

### 恢复协议与ledger结果

多次收到服务器恢复通知后，确认HEAD仍8d4cbdf82、工作树干净，执行git log --oneline -20/git status，读取候选TESTMAP并取已有作业结果，不重复提交相同测试。用户要求的ledger以R4当前工作树（实现基于e303，并非本次624组合）经队列运行：

```text
> deep-student@0.11.0 migration:ledger
> node scripts/electron-migration/ledger.mjs --check --no-write
ledger: commands 1058 (A 91.5% B 5.9% C 0%), tests 8036 (A 76.6% B 0.7%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104074530-11f04a] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074530-11f04a.log
```

不把全仓机械ledger绿当作本lane严格等价或本候选真实集成证明。最终 **P01/P02/P03/P05/P06/P07/P09已核实修复，P04/P08未决**；lane仍不通过，Docker/完整F4 main接线未冒称执行。

## 12. 3628c40c5补核：无新实现，不重复作业

固定 `3628c40c5c8fb834a0a76ee227e63ec4a698a83b` 与已审624cfe251对比，sync-providers下只有BLOCKERS/SPEC说明差异，index/实现/测试无差异，因此沿用§11正式API/许可/IO/清理证据，不重复命令集。

中间作业20261104072846-f45908已亲取result原exit1：1failed/11passed，失败在 `readFile(v1.zip)` 实际成功，不是前一行invoke应HandlerPanic失败。删除前人工用例注入没有release的非法guard，还额外要求“不落下载文件”。Rust `storage/backup_common.rs:112-123,195-211` 的真实guard有固定Drop，不存在这种缺方法对象；`cloud/mod.rs:613-619,697-710` 先下载再返回，不要求因释放编程错误回滚下载文件。因此“不落文件”不属于原Rust不变量，不能为该人工预期增加回滚，也不能仅数expect数量判定弱化。

有效保证仍是实际provider完整释放、未知异常不报成功；正式API的release必需，真实成功后可重取许可证据见§11，release编程异常测试仍保留。该删除不关闭供方B03其它未决项；原作业exit1不删。新v2§1.8要求正式签收以main复验为准，历史候选验证与main状态分开记账。

## 13. P04正式main定向复核（4c6cd1ba8）

固定协调者指定main `4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`；`b7e140795878b1720b7e32021bb2494ecf784c56`祖先检查exit0。原样快照 `/tmp/opencode/R4-P04-main-4c6c-HjJFPR`，未消费其余分支WIP。只测本次变动的解码子项，不重跑owner报告的775例或既有P05/P06。

### 源码核对

- `src/json_exact.ts:38-85,201-239` 保存有序entries，不再对普通对象赋值；`sync_manager.ts:269-274,287-315,338-355` 只对已知struct字段做重复检测，未知字段整体忽略。原未知extension重复被拒、`__proto__`补出必填的机制已删除；明确不是“防止全局原型污染”的新增要求。
- `sync_manager.ts:189-208,230-234` boolean错误带实际值并去掉自造字段后缀；必填缺失取当前object结束位置（`:316-320,356-358`），不是顶层终点。ASCII旧反例有实质修复，不能继续用旧624行号描述当前main。
- **仍未完全serde等价**：parser先完整parse并检查trailing（`json_exact.ts:148-153`），才由`decodeManifestValue`校验类型/重复（`sync_manager.ts:375-383`）。Rust `serde_json::from_slice::<CloudManifest>`是流式derive反序列化，已有字段类型错误/重复字段应先于后续非法token或尾随字符；不能用“都拒绝”代替错误优先级相同。
- **UTF-8列仍有缺口**：`json_exact.ts:130-134,164-172`逐UTF-16 code unit累加3字节，原文emoji代理对会计6而非UTF-8的4字节；普通中文3字节正确不能外推全部Unicode。这里检查的是用户备注/未知扩展可含的正常emoji后出现字段错误时的位置，不要求额外Unicode策略。
- **负零类型缺口**：`ExactJsonNumber.isIntegerToken()`把`-0`当整数，`requireUnsignedIntegerEntry`转BigInt后为0。项目Cargo.lock锁定serde_json1.0.149，`de.rs:509-524`明确将`-0`读为F64(-0.0)，对u32/u64应拒绝。原“已覆盖raw-token整数门”不包含该未测分支。
- **内部首块size仍未修**：`sync_manager.ts:928-969`明确`numericSize=Number(size)`再传三个F4首块方法；正式`host/platform/secrets/api.ts:262-264`仍objectLen:number。平台调用不是IPC边界，D3不批准该转换。续传`:1154-1171`已不再把manifest.size整体转number比较，这是进展；但lstatSize`:448-451`仍取number尺寸，不能据BigInt(partial.size)断言全域保真。日志展示及toWireVersion的Number不混入内部计划问题。

### Rust默认行为的只读依据

项目 `src-tauri/crates/dstu-sync/src/cloud_storage/sync_manager.rs:104-143,487-491` 普通serde derive、无deny_unknown_fields、直接from_slice后才validate。仅阅读库源码，未执行Rust：

- `https://raw.githubusercontent.com/serde-rs/json/v1.0.149/src/de.rs`：`:462-527`数字解析保留-0为F64；`:2497-2507,2657-2662`先Deserialize成功才de.end，故trailing不能覆盖前面的类型失败。
- `https://raw.githubusercontent.com/serde-rs/serde/v1.0.228/serde_derive/src/de/struct_.rs`：`:266-272`先检查已存在字段并报duplicate，再调用next_value；`:285-289`未知字段使用IgnoredAny。版本与Cargo.lock一致。
- `https://raw.githubusercontent.com/serde-rs/json/v1.0.149/src/read.rs:421-429`：SliceRead按字节index与最后换行计算column，不按UTF-16单位。

### 全局队列原result

- `20261104113403-cfe2f1`：manifest_decode仅选 `ignores duplicate keys|reports serde-style|reports a missing nested|rejects duplicate struct`；新旧语义接缝4例，不重复整个文件。
- `20261104113432-5aae59`：同固定main的公开decodeManifest观察：顶层未知重复、emoji列、-0、类型错误优先于trailing、已知重复优先于非法第二值。观察脚本捕获并打印，exit0也不等于所有语义正确。

```text
20261104113403-cfe2f1:
 ✓ host/plugins/sync-providers/tests/manifest_decode.test.ts (14 tests | 10 skipped)
 Test Files 1 passed (1)
 Tests 4 passed | 10 skipped (14)
 退出码 0

20261104113432-5aae59:
top unknown duplicate ACCEPT {"version":1,"versions":[],"updatedAt":"2026-01-01T00:00:00Z"}
unicode column REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: invalid type: boolean `false`, expected a string at line 1 column 59","details":null}
expected serde byte column 57
negative zero ACCEPT {"version":0,"versions":[],"updatedAt":"2026-01-01T00:00:00Z"}
wrong type before trailing REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: trailing characters at line 1 column 66","details":null}
known duplicate invalid second value REJECT {"error_type":"Unknown","message":"manifest manifest.json 损坏: expected value at line 1 column 23","details":null}
退出码 0
```

两作业无Failed/Unhandled Errors段；10skip仅标题过滤。观察输出中第一项符合Rust，后四项是未闭合证据，不能以exit0覆盖。完整命令/stdout在 `/home/dsdev/.oc-jobs/done/<job-id>.log`。本次正式签收未知字段/必填及上述ASCII位置子项，P04总框不勾选。

P04整组及P08保持未决；f32进度差异仍无批准。本轮不审新近大量补测试的整批真实性，owner的775passed/20skip不能代替独立B签收。

## 14. 两条耗时失败的原语义与执行配置（ccba04837）

主线门禁**20261104181546-28458e**原exit1，1772passed/3failed/20Docker skip；providers的两失败是`b04_resources_large_inline_data`达到Vitest默认30000ms超时、`w69_ten_thousand_tiny_records`测得43180ms违反原30秒断言。第三项属于L20第二Host Slot冲突，未混归L23算法。

### 单次窄集诊断及worker配置纠偏

固定main **ccba0483745be0bb95cdb1f03c14f6d0994fa41d**，原样快照`/tmp/opencode/R4-main-ccba-timing-nXl5kv`含项目tsconfig三文件。只选择这两条失败，未改实现、测试、时间限值，也不重跑整个目录。

- **20261104184816-a399d8**：命令请求`--maxWorkers=1`，但实际作业runner注入`VITEST_MAX_FORKS`（默认3）；Vitest先用poolOptions.maxForks再用maxWorkers，两个文件时间有重叠，不能称为单worker隔离。原结果**2failed/39过滤skip、exit1**；b04框架超时，w69=36152ms。
- 源码依据：`scripts/electron-migration/jobs/runner.mjs:80-82`、安装版Vitest的`coverage.DfSpMS-b.js:2612,3741-3749`。不改变全局runner，下一条仅显式设置该作业进程环境。
- **20261104185552-6b22e9**：`env VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 npx vitest run --root <snapshot> -c <snapshot>/vitest.host.config.ts --no-cache --maxWorkers=1 <两个原文件> -t 'b04_resources_large_inline_data|w69_ten_thousand_tiny_records'`。

```text
✓ b04_resources_large_inline_data 28554ms
× w69_ten_thousand_tiny_records
  expected 31882 to be less than 30000
Test Files 1 failed | 1 passed (2)
Tests 1 failed | 1 passed | 39 skipped (41)
退出码 1
```

两诊断无额外Unhandled Errors。显式单fork只控制本作业内并发，不声称整台机器没有其它负载。W69在该条件仍失败，停止重复求绿；b04此次数据长度/前缀断言通过也不覆盖原门禁超时。完整命令与输出在`/home/dsdev/.oc-jobs/done/<id>.log`。

### 两条Rust要求不同，不能一起放宽或一起当算法错误

1. Rust `src-tauri/tests/sync_real_business_tables_tests.rs:417-460`要求本地先有4MB的`x`，远端5MB的`y`覆盖，最后长度5MB且以y开头；**没有30秒断言**。TS `business_tables_sync.test.ts:89-93,223-237`用通用resource helper将本地初值设成`{}`，丢了4MB前置输入；后两条最终断言保留。这里30秒来自`vitest.host.config.ts:10`，不能误称Rust原性能不变量；同时小型本地初值不能代替原大字段覆盖场景的真实性。只报告差异，未改原8回归测试。
2. Rust `sync_weird_tests.rs:2114-2142`四条功能断言之后**确有elapsed.as_secs()<30**，且用Instant。TS四条功能断言及30秒阈值都保留；但`:380-382`改用Date.now，测时未保持单调时钟；`newDb():44-88`统一使用文件句柄，Rust`:16-17`为内存库。环境/测量差异应先核清，不能直接删除或放宽真实30秒不变量，也不能仅凭观察推定31.882秒必然来自某一个因素。

P08继续未决；相关证据已送C2按原移植真实性/性能责任处理，R4未向parked L20加任务，未修改fixture或阈值。

### P04旧ASCII子项的准确边界

§13的ASCII子项只确认boolean实际值与字节结束位置，不应理解为旧`expected a string`整条Display完全等价。只读核对项目锁定chrono0.4.41的`datetime/serde.rs:55-66,93-98`：DateTime<Utc>走DateTimeVisitor，expecting是`an RFC 3339 formatted date and time string`（源：`https://raw.githubusercontent.com/chronotope/chrono/v0.4.41/src/datetime/serde.rs`）。当前流式`serde_struct.ts:671-672`已采用该标签，这是源码进展；仍按C2要求等正式F4 JsonReader消费后再执行已保存反例，不重复旧main失败，不签整个P04。

## 15. b04原fixture恢复与W69诊断边界（main74252e624）

固定main **74252e62407fe2a607693d9195d4068b6cd64bbd**。实际b04代码恢复在`c7a197cfcf`，`cd20f33707d701718298b253c525d46624e8cea9`记录修复及说明；不能只凭fix标题把全部实现归到说明提交。

对照Rust `sync_real_business_tables_tests.rs:26-64,417-460`，当前`tests/business_tables_sync.test.ts:226-265`：

- 用正式`storage.openFile(':memory:', { profile:'plain' })`，原resources/change_log字段、约束、两trigger保留；不再因完整迁移schema额外进入note-history格式检测。实际默认hook仍安装，原无history表的生产特性门负责返回。
- 本地4MiB x重新入库，远端5MiB y、1000→2000时间戳及原Update输入保留。
- 原长度5MiB和startsWith(y)两断言完整；未改默认30s配置，没有skip、没有自写apply/绕开owner。
- finally调用正式storage.close，fixture只提供原数据库环境，不替换被测逻辑。

复用官方主线作业**20261104195643-18bfdd**：`business_tables_sync.test.ts (25 tests)`全过；整作业1812passed/2failed/20Docker skip、**原exit1**。193444-8c771e的同模块也已通过；810149749→74252e624该测试仅说明文字变化，未再排b04重复测试。当前不再把旧`{}`本地初值或b04超时描述为这棵main现状。

**只签原b04场景**：完整迁移schema下5MiB正文格式检测的额外性能问题未因恢复原fixture消失，也未在本次签收；owner已单列，不把legacy schema快速路径当完整现代组合性能通过。

W69主线也已恢复内存newDb和performance.now，原10000条/四项数据断言/严格30s界限仍在。因此§14的文件库/Date.now差异属于旧树，当前W69依然有真实超时证据，不能靠旧fixture偏差继续解释全部失败。

另亲取owner现成诊断**20261104194043-6655ea**（未重复执行，不是R4生产修复）：真实F3内存连接、10000条INSERT日志、2000次无旧DELETE查询，table-first7103.67ms、record-first4383.61ms、operation-first10210.89ms，均SCAN；混合DELETE大小写、其它表/记录、最后UPDATE共存时三者都返回latest，exit0。

该诊断建议只交换`apply-record.ts:137-140`中两个等值谓词，保留?1/?2绑定、upper(operation)、id倒序/LIMIT1。对原声明schema和纯谓词，静态结果语义无变化，可交owner进入最小实现验证；**尚未应用生产，不能签W69性能已修**，更不能用微基准替代全批测试。R4未改SQL/阈值、未向parked L20加任务，已将判断送C2沿架构接管处理。

## 16. 首块u64补签与租约纳秒/holder增量（main9b3c18601）

固定main **9b3c18601f674826479ed0e7f6ac7d13edca2b70**，合并HEAD **c242be19a6b4c00ab26ddafbf5735e71b47f222d**。官方主线作业 **20261104220300-b694ec** 已实际执行lease_time14/14、lease_holder14/14，无这两文件skip；据源码与主线原结果，签收P04租约纳秒/holder子项，不扩签整个P04。不另排重复窄集。

**首块u64旧描述订正并签收**：实际生产修复 **37a441513ad8377a75d19da5cf9045038ac84bce**、补充测试 **b927fe087d115aca06cef6bd768bdecd216cc7d7**早已在main。`password_proof.ts:110-145`的speculative、plan、trial三次均直接传`version.size`；F4 `secrets/api.ts:266-268`接受number|bigint，`backup-crypto.ts:317-364`长度减法/末块判定保持bigint，只将已限制上界的分块分配长度转number，对齐Rust sync_manager.rs:1349/1370/1399-1401。

`sync_manager.test.ts:179-202`先用真实F4创建多块密文并经生产manager上传，把manifest size改为9007199254740993n，再从真实manager读回并做首块证明；保留不全量下载/有前缀读取/marker升级断言。内存云端只提供字节存取，不替换crypto或被测方法；不声称实建了9PB对象。旧Number路径会被F4安全整数校验拒绝，因此此例能抓住原缺陷。既有main官方 **20261104212749-278ab2** 文件33/33通过；90538→9b3这些文件无差异，复用此结果签收，整作业仍exit1。原§13首块缺口只属旧树。

**租约增量源码审读**：实现承载45843cf78/f5a6768bd及dedc94240，holder修复承载28f5173c4。`lease.ts`的创建/续租/三次选主扫描、created_at比较、损坏对象lastModified+TTL fallback均使用正式F4 epochNanos，两个协议held错误用toRfc3339；holder新建/结构校验/本机判定统一用正式rustTrim。对应Rust sync_lease.rs:63-105,124-138,173-183,265-287及backup_lease.rs相同分支。

`lease_time.test.ts`14例覆盖同毫秒不同纳秒的反向UUID排序、expiry=now与now+1ns、不同offset同瞬间tie-break、TTL完整相加、损坏对象fallback及held标签保留9位小数；`lease_holder.test.ts`14例覆盖NEL/BOM新建、持久化结构有效性和本机判定，均调用真实公开acquire或同一生产scan/create函数，没有测试自写选主算法。原sync_lease/backup_lease用例只把固定时刻参数等值换算为纳秒，断言未弱化。

备份租约实际由delta_upload/delta_restore/delta_gc消费；sync-target租约本轮只核公开API，不能凭导出推断整个sync生产链已安装消费者。原owner纳秒修前 **20261104202337-f23627**、修后 **20261104203016-212292** 属owner历史证据，最终main运行以本轮gate为准。此增量不代表正式F4 JsonReader消费完成，也不改变P08/W69未决。

**原门禁结果**：220300-b694ec仍exit1，1842passed/2failed/20Docker skip，154passed/2failed/1skipped files，无额外Unhandled Errors；失败为旧关系第二Host SlotOccupied及W69 **38593.657126ms > 30000**。typecheck **-7fc4a5**、boundaries **-9c02bf**、importable **-164155**均exit0。selfgate政策ok=true与原测试非零分开记录；不得以这28条通过关闭W69。

## 17. 最终规定gate新增S108/收尾超时（a9683a43b）

按C2澄清提交1db54de0c并合main后，仅运行一次官方gate：tip **d8967449780aec6e23fb3586c194c8a050f14317** / base **a9683a43b8b9001e5c73fea04cc1263fb35401b6**。原作业 **20261105004819-87e02a** **exit1**；1916passed/2failed/20Docker skipped、156passed/2failed/1skipped files，**Failed Suites1、Errors1**。selfgate at2026-11-05T01:09:16.167Z为**ok=false / failed=[tests]**；政策指出两个新增失败条目（suite+S108），另有既有W69不计，不能写成政策绿。

| 原日志位置 | 故障 | 证据边界 |
|---|---|---|
| stress_sync.test.ts:468，日志:813-824 | s108_10_devices_each_creating_10_records 184280ms，Test timed out in 180000ms | 原10设备各10记录、最终100条断言及180s预算未改；日志未定位停在建库还是apply |
| 同文件:311，日志:797-808 | afterAll `await h.dispose()`，Hook timed out in 10000ms | 独立suite失败，不与用例超时合并计成普通断言失败 |
| 日志:838-855 | Unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"` | **Errors1**真实存在，不能因多数用例passed忽略；日志未确定由哪条具体同步调用阻塞 |
| weird_batch_sync.test.ts:390 | W69 47523.31812900001ms不小于30000 | 保留原阈值与原失败，未用gate baseline豁免将它写成修复 |

只读核实：9b3→a968压力测试及realistic_sync_harness均未变；h.device在真实storage.migrations.runAll后才缓存设备，h.dispose依次卸载host、dispose各storage、删除临时根。上述位置是待owner定位的调用边界，不据源码猜定耗时根因；没有CPU归因、没有为绿增加timeout/skip，也没有改清理或减少设备数。

typecheck **20261105004819-f9aee7**、boundaries **-2c3eac**、importable **-09fd22**均exit0。同作业L20 note-history15/15含relation20685ms通过，原第二Host Slot不再出现在此次失败列表；该局部事实详总审计，不能覆盖本次Unhandled Error或其它测试真实性问题。已将完整SHA/作业/exit/Errors及最小定位请求queue C2，由其协调L23/F3和parked供方接管；R4不改实现/原断言、不另排专项全集。

## 18. WebDAV单调限流与A13原不崩溃用例main限定签收（cf92ce1eb）

固定main **cf92ce1ebb41de93af216755d896a2c5076a62a7**，受测tip **040d49ddad9fc4c389e007b6878c436b22a07a92**；复用规定gate **20261105041136-cca61a**，没有新增手工专项。

**L23-V2-1.7 WebDAV**：d476cf29e仅将`webdav.ts:193`的窗口计时换成performance.now，对齐Rust `webdav.rs:132-155`的Instant；实际四条请求路径均调用同一acquireRequestSlot。共享key/window、等待/取消及HTTP-date Retry-After未变。四个补充用例分别控制墙钟/单调时钟，验证回拨后实际已到期可授予、快进但未到期仍等待、等边界及界内控制；调用真实gate和cancellableSleep，使用已取消signal观察等待分支，没有重写限流逻辑。原取消fixture只将填窗值等时换单位，原断言保留。

亲取owner有效修前 **20261105032931-233f31**：2failed/2passed/37标题过滤skip、exit1；修后 **20261105033052-311154**：41passed/exit0。main本次webdav **41/41通过**（16952ms，无该文件skip），签该单调窗口修复，不泛签所有WebDAV行为。

**L23-A13 / P08子项**：4b476f44c新增`adv_13_payload_type_mismatch`。Rust `sync_adversarial_tests.rs:570-587`原本丢弃apply的Result，只要求不panic，不要求success_count或INTEGER列最终值。TS保持counter INTEGER、payload `counter:'not_a_number'`及原timestamp，`void apply(...)`实际委托已安装`host.ctx.sync.applyDownloadedChanges`，没有预转换、替身apply或catch-all。0个显式expect不等于没有被测不变量；本输入实际正常返回，若将来抛业务错误仍须按公开分类审查，不能无差别吞错。

owner **20261105033816-193e72**为1passed/37标题过滤skip、exit0；main本次adversarial **38/38通过**（6602ms，无该文件skip），确认仅A13映射恢复。TESTMAP对应一行由pending→ported，其余原断言未改；A33与其它无显式assert用例不能据此自动签收或obsolete。上述owner作业无额外Errors，修前初版Error.name假设错误的作业不混成有效业务反例。

**整门禁仍非全绿**：041136-cca61a原exit1，1935passed/1failed/22skip、158passed/1failed/1skipped files，无额外Errors/Unhandled Errors；W69 **41280.440107ms > 30000**仍失败，22skip为20Docker＋2未授权审计Value skip。S10850476ms本次通过，不据此关闭旧超时根因。typecheck **-231286**、boundaries **-023413**、importable **-982a1f**均exit0，selfgate政策ok=true；P04/P08父组继续开放。

## 19. A33观察不变量与W55只读连接main限定签收（92365bc5c）

固定main **92365bc5c85d947c12d442a2b02fbf1ab0675b7c**，受测tip **1279d32aa35da81f9844cd1b6a039e6fb521e585**，复用规定gate **20261105044538-d2557a**，未另排专项。

- **A33**：Rust `sync_adversarial_tests.rs:1224-1263`丢弃apply Result，随后两次COUNT query_row.unwrap并打印，未断言写入哪个ID。TS `adversarial_sync.test.ts`保持record_id=n1/payload.id=n2、原title/time/deleted_at，经已安装sync公开apply，真实F3 db.one完成两次COUNT，无预转换、catch-all或自造成功/计数条件。main文件39/39通过，实际打印n1=0/n2=0仅为观察，不据此签生产ID策略正确。owner旧 **20261105040401-7d0bcb** 原exit0、1passed/38标题过滤skip另保留。
- **W55**：Rust `sync_weird_tests.rs:1531-1561`建库→关闭→READ_ONLY重开→真实apply返回Err。TS保原schema/输入，以公开`storage.openFile(...,{profile:{readonly:true}})`重开；F3 connection.ts:91-94实际传驱动readonly/fileMustExist，不用query_only或假句柄。断言针对apply的`Database error: ...readonly database`，不是fixture建库异常或任意throw。main此例92ms通过；同文件17例中16passed，唯一失败为W69。owner旧 **20261105035916-111d65** 原exit0、1passed/16标题过滤skip另保留。

两个owner作业均无Errors/Unhandled Errors；main原整作业**exit1、1937passed/1failed/22skip**，158passed/1failed/1skipped files，无额外Errors/Unhandled。W69 **41079.445253ms > 30000**仍失败，四项计数和30秒断言未改；22skip＝20Docker＋2未授权审计Value。S10835995ms本次通过不解释旧根因。typecheck **044538-4cd246**、boundaries **-3c7826**、importable **-d55e3b**均exit0，政策ok=true不等于原全绿。仅签这两个原测试的映射/执行，P04/P08及其它未决保持。

## 20. P20原性能断言与W12精确输入观察（eaa17bc7e）

固定main **eaa17bc7e27ea6e522d3b51e093a7d2e05b2c290** / tip **8ca5571da1da4e36cd26d7b35f1cd5fae4abf2fb**。复用规定gate **20261105045657-34fbab**，pathological33/33、weird40/40通过，无这两文件skip；P08仅签以下原测试子项。

- **P20**对照Rust `sync_pathological_tests.rs:15-48,852-884`：真实F3内存库、原schema/trigger/refinery行；deferred事务插入10000条sync_version=1日志后提交；构造fresh变更前performance.now开始计时，真实公开apply后断言严格<500ms。无新增索引、减量、扩大阈值或挪动计时。main打印 **8.211741999999504ms**；owner旧 **20261105042830-151b20** 原exit0、1passed/32标题过滤skip、73.875603ms已亲取。只确认此原场景，不推断W69/P36或重复负载性能已修。
- **W12**对照Rust `sync_weird_tests.rs:16-48,367-384`：真实内存schema含INTEGER counter与refinery行，payload精确`18446744073709551614n`经公开DbJson交实际apply，无Number预转换、catch-all或自造必须成功/截断值断言。原Rust只打印Result，TS同样观察Result；main打印原精确整数、文件40/40通过，不据此签引擎对所有u64写入策略等价。owner旧 **20261105043559-8d4b33** 原exit0、1passed/39标题过滤skip，success0/failure1仅为该次观察。

上述owner作业无额外Errors；main原整体**exit1、1939passed/1failed/22skip**，158passed/1failed/1skipped files，无额外Errors/Unhandled。唯一失败仍W69 **31510.610106ms > 30000**；22skip＝20Docker＋2未授权审计Value。typecheck **045657-36c6b7**、boundaries **-719a95**、importable **-3c7929**均exit0，政策ok=true不关闭P04/P08父组。无新增手工专项或生产/测试改动。

## 21. P36固定树签收及运行中合并的回执边界（6d759e81c）

固定main **6d759e81c0bf474cb4d3367d4fc2158886da0e02** / tip **b9db66007d693423a3b51671109bdfd746cfd255**，规定gate **20261105052304-887d64**。运行期间未再合并/编辑，结束后HEAD仍b9db66007且工作区干净。pathological **34/34通过**，P36打印 **26795.298263000004ms**、用例26799ms；据此限定签收原P36测试。

Rust `sync_pathological_tests.rs:1475-1504`与TS均用原内存schema/refinery历史，5000个r00000…ID、逐条ts、5000次独立公开apply；计时包括变更构造和调用，在COUNT前停止，之后严格COUNT=5000与elapsed<60000ms。新case runner120s是让原60s业务断言执行的框架预算，不替代或放宽该断言；未并批/增索引/减少输入。owner旧 **20261105045404-bcaeff** 原exit0、1passed/33标题过滤skip、23890.568476ms已亲取，无Errors，未另跑专项。

**混合树证据更正**：此前 **20261105051007-ead04a** 启动记录tipbc0bb941a/baseeaa17，自动续派在其运行中按先merge要求合入b9db66007。日志实际执行新P36（25691.316571ms、34例），证明受测源码不再固定于起始tip。保留其原exit1/1940passed/1failed/22skip、W69=39477.812446ms、无Errors，但不拿该次作固定bc0或新main签收；selfgate原记录未伪造/修改。已报C2，后续gate活跃时先保护受测树，收尾后再合入新业务。

固定树052304-887d64整作业仍**原exit1、1940passed/1failed/22skip**，158passed/1failed/1skipped files，无额外Errors/Unhandled；W69 **35630.57872ms > 30000**仍失败，22skip＝20Docker＋2未授权审计Value。typecheck **-0a8c4e**、boundaries **-f3eb65**、importable **-0cb2e6**均exit0，政策ok=true不等于原全绿。P36通过不证明W69或旧S108/RPC超时根因已修；P04/P08整体保持未决。
