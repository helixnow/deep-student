# Android 云同步 / 换机验证手册（R11）

> 适用基线：`cursor/cloud-sync-sota-b343`（2026-08-24）
> 目标：在 Android 真机或带 Google APIs 的模拟器上，核对 WebDAV、SAF ZIP
> 导入/导出、恢复后重启，以及平台能力错误码。本文是 QA / 发布核对单，不替代用户指南。

## 0. 先说结论

- Android 发行档（`mobile-slim` / `android-release`）当前只有 **WebDAV** 云后端；
  FTP/FTPS 与 S3 必须分别返回 `E_FTP_UNSUPPORTED_ON_ANDROID` /
  `E_S3_UNSUPPORTED_IN_BUILD`，前端只按 code 本地化，不再匹配中英文 message。
- `content://` 不是“完全未实现”：ZIP 导入会先物化到应用私有临时目录，ZIP 导出会先
  在私有目录生成，再复制到 SAF 目标。宿主测试已锁定分类和编排；真正的
  ContentResolver 授权、不同 DocumentsProvider 行为和进程死亡恢复仍缺真机证据。
- 「立即备份到云端」按是否配置了云端端到端加密密码分两种，**不要再写成永远是便携包**：
  - **未配置**密码：产物仍是便携归档，整槽校验必须拒绝，当前数据不被覆盖；
  - **已配置**密码：标准 UI 会导出加密全保真 ZIP（外层 DSBK 与内层备份密码用同一已存密码），
    解包后应能通过 `validate_for_slot_restore`。已配置却读不到已存密码时 **fail-closed 拒绝导出**，
    不会偷偷打成便携包。此接线前上传的云端包仍可能是便携归档，恢复时不会套用已存密码。
- 真机尚未签字。发布说明仍不得写“Android WebDAV 可全保真一键换机”，直到本节 3.3
  在真机转绿。在那之前，**最稳妥、可独立核验的全保真换机主路径仍是 SAF 加密 ZIP**
  （第 4 节）。WebDAV 同时承担记录级同步、版本化云备份，以及已配置 E2EE 后的整槽恢复验证。

## 1. 测试准备

### 1.1 设备与账号

- 设备 A：有可识别的测试数据；设备 B：空白测试账号或可清空的测试安装。
- 两台设备安装同一 APK、保持充电和前台运行，关闭系统“自动清理应用数据”。
- 独立 WebDAV 测试账号，支持 MKCOL / PROPFIND / PUT / GET / DELETE。
- 两个不同密码：
  - WebDAV 应用专用密码；
  - 端到端加密密码（离线记录，不能依赖应用找回）。
- 先在设备 A 另存一份本地备份；测试目录不要与生产云目录共用。

### 1.2 建议构建命令

CI 的 lean recovery 发行档实际使用：

```bash
npx tauri android build --target aarch64 --apk --ci -- \
  --locked --no-default-features --features android-release
```

最小移动档可用：

```bash
npx tauri android build --target aarch64 --apk --ci -- \
  --locked --no-default-features --features mobile-slim
```

安装后记录 APK SHA256、应用版本、Android 版本、设备型号、WebView 版本和网络类型。
不要用默认 feature 构建冒充 mobile-slim；默认 feature 包含 `cloud_storage_s3`。

## 2. 平台能力冒烟

| 操作 | 预期 |
|---|---|
| 云存储选择 WebDAV | 可填写、保存并测试连接 |
| 尝试加载/保存 FTP 配置 | 拒绝；UI 显示 Android 不支持提示；后端 code 为 `E_FTP_UNSUPPORTED_ON_ANDROID` |
| 尝试加载/保存 S3 配置 | 拒绝；UI 提示改用 WebDAV/桌面 ZIP；后端 code 为 `E_S3_UNSUPPORTED_IN_BUILD` |
| 改变后端 message 的语言或措辞 | UI 映射不变；只有 code 决定本地化键 |
| 未知 code | 原样显示诊断，不误映射为 FTP/S3 |

用调试日志/IPC 观察器检查失败载荷时，SSOT 命令应是
`{ code, message }` CommandError envelope；`create_storage` 旧 AppError 形态应在
`details.code` 携带同一 code。message 只用于诊断，不能作为验收分派条件。

## 3. WebDAV 配置与跨设备核对单

### 3.1 设备 A：配置与上传

1. 打开“设置 → 数据治理 → 同步 → 配置云存储”。
2. 选择 WebDAV，填写 HTTPS endpoint、用户名、应用专用密码。
3. root 使用本次唯一目录，例如 `deep-student-r11-android-<日期>`。
4. 填写端到端加密密码并离线记录；两台设备必须完全一致。
5. 点“测试连接”，应成功；再点“保存配置”。
6. 创建一条可识别数据，例如标题 `R11-A-<时间>`；完成一次记录级上传同步。
7. 点“立即备份到云端”，等待四阶段完成；切后台/锁屏不是本轮成功路径，首轮保持前台。
8. 打开“历史版本”，记录 version id、大小、时间；运行一次只读仓库巡检，结果不得因
   列表截断或对象读取失败而假报全绿。

### 3.2 设备 B：读取与记录级同步

1. 全新启动设备 B，确认尚未出现设备 A 的识别数据。
2. 配置相同 endpoint / 用户名 / root / 端到端加密密码。
3. 测试连接，历史版本应能看到设备 A 的 version id。
4. 先运行记录级“下载/双向同步”，确认 `R11-A-*` 到达且无重复；设备 B 新建
   `R11-B-*` 后上传，设备 A 再下载，确认双向各一份。
5. 密码错一位重试上传：应在云端写入前失败；改回正确密码后恢复。

### 3.3 云端整包恢复（分配置核对）

1. 在设备 B 选择设备 A 的云端版本并执行恢复。两端必须使用同一 WebDAV root 与同一
   端到端加密密码（第 3.1 / 3.2 已配）。
2. **已配置 E2EE、且该版本是接线后由「立即备份到云端」写出的**：预期解包后清单可通过
   `validate_for_slot_restore`，然后进入第 4.2 同款的非活动槽 + 重启切槽核对。
   若仍被标成部分归档并拒绝整槽恢复，记为**回归**（不要改清单绕过），并核对该版本
   是否其实是接线前上传的便携包。
3. **未配置 E2EE，或明确是接线前便携包**：预期**在切槽前明确拒绝完整恢复**——活动槽不变、
   无半切换、重启后仍是原数据。这是诚实限制，不是失败。
4. 只有当待恢复包通过 `validate_for_slot_restore` 时，才把该次云端恢复记进重启验收。
5. 发布说明不得写“Android WebDAV 可全保真一键换机”，直到本小节在真机转绿。

## 4. SAF 加密全保真 ZIP 换机（当前主路径）

### 4.1 设备 A：导出

1. “设置 → 数据治理 → 备份”创建完整备份并先执行验证。
2. 选择“导出 ZIP”，设置独立备份密码（不是 WebDAV 密码）。
3. 在系统 `ACTION_CREATE_DOCUMENT` 界面依次验证至少两个 provider：
   本机 Downloads，以及一个真实 DocumentsProvider（例如 Google Drive/厂商文件管理器）。
4. 导出期间保持应用前台。完成后在 provider 中确认文件可见、大小非 0。
5. 将 ZIP 复制到校验机或设备 B，记录 SHA256；不得只以“任务显示完成”判成功。

### 4.2 设备 B：导入、恢复、重启

1. 在系统文件选择器选中该 ZIP；输入错误密码一次：应早失败，不能出现可恢复半成品。
2. 输入正确密码导入；清单必须显示为可完整恢复。
3. 恢复前写入设备 B 本地识别数据 `R11-B-before-restore`，并再做一份本地保护备份。
4. 执行恢复：数据先写非活动 A/B 槽，只登记 pending cutover；当前进程仍应使用旧槽。
5. 点“立即重启”。重启后核对：
   - 设备 A 的识别数据存在；
   - `R11-B-before-restore` 不在活动槽；
   - 应用可以连续冷启动两次，无重复切槽或维护租约卡死；
   - device id 已轮换，随后上传不会被当作设备 A 的回声。
6. 若自动重启未生效，执行 `adb shell am force-stop com.deepstudent.app` 后手动打开；
   切槽必须只发生在下一次启动，不能出现“一半旧数据、一半新数据”。

### 4.3 中断矩阵

| 注入点 | 操作 | 预期 |
|---|---|---|
| SAF 导入复制 30% | 断网/撤销 provider | 失败可见；临时文件最终清理；活动槽不变 |
| SAF 导出最终复制 | 撤销授权/空间耗尽 | 任务失败，不报 Completed；本地临时导出清理 |
| persistable 授权后强杀/重开 | 导出完成后 `force-stop` 再打开，尝试续写同一 URI | 已 persist 则可续写；`ACTION_GET_CONTENT` 拒绝 persist 时失败必须可见，不得报成功 |
| ZIP 导入解封 | 错密码 | 触碰目标槽前失败 |
| 写非活动槽后、重启前 | 强杀进程 | 下一次启动按 pending cutover 幂等完成或安全拒启 |
| 首次切槽启动中 | 再次强杀 | 不重复轮换、不提前解除恢复租约 |
| WebDAV 下载中 | 断网后重试同版本 | WebDAV Range 续传；最终整文件 SHA256 校验 |

## 5. SAF 现状审计

### 5.1 已实现

- 移动 capability 允许 dialog open/save 与 app/document/download/temp 文件读写。
- `unified_file_manager` 把 `content://`、`primary:`、`secondary:`、`raw:` 识别为虚拟
  路径；原始 `%3A` / `%2F` 编码不被解码后再交给 ContentResolver。
- 虚拟 URI 经 `tauri-plugin-fs` 的 `SafeFilePath` + `Window::fs().open` 流式读写。
- ZIP 导入先复制到 `temp_zip_import`，解决 ZIP 随机访问要求；导出先写
  `temp_zip_export`，任务提交阶段再复制到目标 URI。
- 正常与已覆盖的失败路径会清理临时文件；宿主测试锁定 URI 分类、文件名/扩展名、
  编码保留和命令编排。
- ZIP 三入口与同步导入/导出把合法 `content://` 原子写入应用私有
  `pending_saf_persist/<hash>.uri`（路径对齐 Tauri `app_data_dir` / Android `filesDir`）。
  并发导入/导出不得互相覆盖；MainActivity 同时双读旧单文件
  `pending_saf_persist.uri`。受控 `MainActivity` 在 `onResume` 立刻 persist，
  前台每 400ms 轮询 `takePersistableUriPermission`。`ACTION_GET_CONTENT` 常常不可 persist：
  `SecurityException` 必须删队列并 log warn，不得假装已授权。宿主测不能冒充真机绿灯。
- 数据治理 ZIP **导出**走 Tauri `save()` → `tauri-plugin-dialog` 2.6.0
  `ACTION_CREATE_DOCUMENT`，persistable grant 有机会成功。**导入**走 `open()` →
  同一插件的 `ACTION_GET_CONTENT`（源码 TODO `ACTION_OPEN_DOCUMENT`），persist
  通常被拒；当次物化仍靠当前进程 grant。本枝未 vendor 对话框插件、未改 lockfile。

### 5.2 仍开缺口

| 级别 | 缺口 | 发布前证据 |
|---|---|---|
| P1 | 没有真机 ContentResolver 读写自动化；`Window<Wry>` 不能由当前 mock runtime 驱动 | 本手册 4.1–4.3 全矩阵，至少 Android 13/14 各一台 |
| P1 | persistable URI grant 真机闭环 | **代码已合**：Rust 原子多文件队列 + MainActivity 双读旧单文件。导出 `save()` / `ACTION_CREATE_DOCUMENT` 才有机会 persist；导入 `open()` / `ACTION_GET_CONTENT` 通常被拒，当次物化靠进程 grant。强杀/重开仍要按 4.1–4.3 签字 |
| P1 | 导出复制目标回读 | **代码已合**：`copy_file` 写完后重新打开目标核对长度与 SHA-256，失败不得报成功。真机 DocumentsProvider 延迟提交 / 进程死亡仍要按 4.1–4.3 签字 |
| P2 | 临时物化前空间预检 | **代码已合**：虚拟 URI 物化前按源大小 2 倍核对临时卷可用空间，不足 fail-closed。真机 ENOSPC / 配额虚报 / SAF 目标卷仍要按 4.1–4.3 签字 |
| P2 | 不透明 document id 未查询 `OpenableColumns.DISPLAY_NAME/SIZE`；通用导入靠 magic bytes，日志/文件名可读性退化 | Downloads/Drive/厂商 provider 各取一例 |
| P2 | `content%3A%2F%2F...` 双重编码输入 | **代码已合**：`is_virtual_uri` 仍为 false；ZIP/同步入口与 `classify_path` 可读拒绝，不解码后当虚拟路径。真机对抗性输入仍要按 4.1–4.3 签字 |
| P2 | Android `app.restart()` 壳只能由真机验证；宿主仅等价测试下一次初始化切槽 | 4.2 的冷启动两次 + 强杀矩阵 |
| P2 | 受控 `mobile/android/MainActivity.kt` 与 Tauri 生成工程的同步没有仓库门禁 | 每次 `tauri android init` 后人工 diff，后续加 CI 同步检查 |

## 6. mobile-slim 启用 S3 的依赖 / 体积评估

### 6.1 可复现量化

在 `src-tauri/Cargo.lock` 当前锁定版本上，对
`aarch64-linux-android` 执行 `cargo metadata --locked --filter-platform ...`：

| feature 集 | resolve package 节点 |
|---|---:|
| `--no-default-features --features mobile-slim` | 705 |
| `--no-default-features --features mobile-slim,cloud_storage_s3` | 732 |
| 增量 | **+27（+3.8%）** |

27 个增量中 20 个为 AWS / Smithy 包。关键新增为
`aws-sdk-s3 1.111.0`、`aws-config 1.5.16`、`aws-sdk-sts 1.94.0`、
SigV4、checksum/eventstream/XML/HTTP runtime，以及
`rustls-native-certs`、`openssl-probe` 等证书发现链。版本来自 lockfile 的实际解析，
不是 Cargo.toml 最低版本。

复现：

```bash
cargo metadata --locked --format-version 1 \
  --filter-platform aarch64-linux-android \
  --no-default-features --features mobile-slim

cargo metadata --locked --format-version 1 \
  --filter-platform aarch64-linux-android \
  --no-default-features --features mobile-slim,cloud_storage_s3
```

### 6.2 不能从依赖数推导 APK 字节数

本轮没有可比的两份同工具链、同符号/压缩/ABI APK，因此不伪造“增加 N MB”的结论。
Rust 泛型单态化、LTO、strip、APK 压缩会让源码/包数量与最终体积非线性。启用前必须做
同一提交的 paired build，并记录：

- unsigned 与 signed APK 总字节；
- `lib/arm64-v8a/libdeep_student_lib.so` 解压后字节；
- clean build 峰值磁盘/内存与耗时；
- 冷启动 P50/P95 RSS；
- 一个 AWS S3 和一个 MinIO path-style 的上传、列表、下载、删除契约。

### 6.3 决策

当前保持 mobile-slim 不启用 S3。理由不是“27 个包一定过大”，而是：

1. Android 已有 WebDAV + SAF ZIP 可用路径；
2. AWS SDK 增量引入 20 个 AWS/Smithy 组件和 STS/证书/HTTP runtime，测试面明显扩大；
3. 尚无 paired APK / RSS 数据，也无 Android 真机 S3 provider 契约；
4. 错误码与 i18n 已把“不支持”状态做成可维护的显式能力，不需要靠编入 S3 消除乱码。

达到 paired build 与 provider 契约门槛后，可重新评估单独的
`android-s3` profile；不要直接修改 `mobile-slim` 的既有语义。

## 7. 自动化证据与签字模板

代码侧定向门：

```bash
cargo test --locked --features data_governance \
  --test sync_android_device_switch

npx vitest run tests/vitest/data-governance/r10-ux-cloud-error-mapping.test.tsx \
  tests/vitest/data-governance/r11-android-platform-error-codes.test.ts
```

真机报告至少包含：

```text
APK SHA256:
设备/Android/WebView:
WebDAV provider/root:
平台错误码: FTP [ ]  S3 [ ]
记录级 A→B→A: [ ]
云端未配置 E2EE / 接线前便携包：整槽恢复诚实拒绝: [ ]
云端已配置 E2EE（接线后版本）：整槽恢复 + 重启切槽: [ ]
SAF Downloads 导出/导入 SHA256: [ ]
SAF 第三方 provider 导出/导入 SHA256: [ ]
错密码早失败: [ ]
恢复后自动重启/手动 force-stop: [ ] / [ ]
冷启动两次、无重复切槽: [ ]
中断矩阵: [ ]
SAF persistable 强杀/重开: [ ]
未关闭缺口与日志链接:
```

没有真机报告时，只能声明“宿主契约测试通过”，不能声明“Android 换机闭环已实测”。
