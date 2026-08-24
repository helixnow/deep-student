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
- 标准“立即备份到云端”链路上传的是便携归档；即使外层使用云端 E2EE 密码加密，
  也不会把被便携导出策略剥离的本机密钥材料补回来。当前 UI 必须诚实拒绝把
  “部分归档”当 A/B 槽完整恢复。**不要把 WebDAV 云端整包当成唯一的全保真换机手段。**
- 当前可验证的全保真 Android 换机主路径是：旧设备创建本地完整备份 →
  用备份密码导出加密全保真 ZIP → SAF 传到新设备 → 输入同一密码导入 →
  恢复到非活动槽 → 重启切槽。WebDAV 仍用于记录级同步、版本化云备份和灾备下载。

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

### 3.3 云端整包“恢复”诚实性

1. 在设备 B 选择设备 A 的云端版本并执行恢复。
2. 若清单标记为部分归档，预期是**在切槽前明确拒绝完整恢复**：活动槽不变、无半切换、
   重启后仍是原数据。把此结果记录为当前产品限制，不能手工改清单绕过。
3. 只有当待恢复包的清单通过 `validate_for_slot_restore` 时，才继续下一节的重启验收。
4. 发布说明不得写“Android WebDAV 可全保真一键换机”，除非标准 UI 已能生成并恢复
   加密全保真包，且本节真机用例转绿。

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

### 5.2 仍开缺口

| 级别 | 缺口 | 发布前证据 |
|---|---|---|
| P1 | 没有真机 ContentResolver 读写自动化；`Window<Wry>` 不能由当前 mock runtime 驱动 | 本手册 4.1–4.3 全矩阵，至少 Android 13/14 各一台 |
| P1 | 未显式调用 `takePersistableUriPermission`；异步导出依赖当前进程的 URI grant，进程死亡后不可承诺续写原 URI | provider 授权后强杀/重开测试；失败必须可见，不得报成功 |
| P1 | 导出复制只以 `std::io::copy + flush` 成功为准，未重新打开目标核对长度/SHA256；部分 provider 的延迟提交未被覆盖 | 导出后独立读取并比对 SHA256；后续实现目标回读校验 |
| P2 | 临时物化前没有按源大小做可用空间预检；大 ZIP 可能复制到一半才 ENOSPC | 剩余空间 < ZIP 2 倍的真机故障注入，错误与清理可见 |
| P2 | 不透明 document id 未查询 `OpenableColumns.DISPLAY_NAME/SIZE`；通用导入靠 magic bytes，日志/文件名可读性退化 | Downloads/Drive/厂商 provider 各取一例 |
| P2 | `content%3A%2F%2F...` 双重编码输入在公开 `is_virtual_uri` 层按本地路径 fail-closed | 保持拒绝并给可读错误，或补分类后更新锁定测 |
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
云端部分归档诚实拒绝: [ ]
SAF Downloads 导出/导入 SHA256: [ ]
SAF 第三方 provider 导出/导入 SHA256: [ ]
错密码早失败: [ ]
恢复后自动重启/手动 force-stop: [ ] / [ ]
冷启动两次、无重复切槽: [ ]
中断矩阵: [ ]
未关闭缺口与日志链接:
```

没有真机报告时，只能声明“宿主契约测试通过”，不能声明“Android 换机闭环已实测”。
