# 桌面应用升级与用户插件

官方应用包与用户数据目录独立。升级只替换应用包；已安装社区插件、工坊源码、配置、同意记录和插件数据留在用户数据目录。不应直接修改安装目录里的官方插件；需要定制时用工坊或社区插件。

- `engines.deepStudent` 声明插件实际依赖的应用版本。可以另用 `engines.deepStudentPluginApi` 声明所需插件 API 主版本（目前为字符串 `"1"`）。应用小版本与插件 API 版本独立；应用增加小版本不应移除仍受支持的插件 API。
- 旧工坊托管项目的默认 `^0.20` 在仍支持 API 1 的 0.x 应用中继续有效；不改包内容、锁或同意记录。第三方插件明确写的应用版本上限仍生效。
- Node 桌面版点击应用内更新时先按目标应用版本检查已启用的用户插件清单，不导入模块。提示已知不兼容和无法检查的条目，用户可继续更新。此检查不能预测运行时报错，也不替代对候选版本的验证。通过外部安装器直接更新不会经过应用内提示。
- 启动时按实际应用版本重新检查。版本不兼容只降级插件，不改用户的启用设置；社区模块缺失或导入抛错会标记 `IMPORT_FAILED`，其他插件照常加载。状态出现在插件管理器和诊断记录中。用户 profile 本身损坏或整个 Host 崩溃仍走官方配置回退。

## 发布前验证

对跨小版本发布，在目标平台用上一版安装包安装并修改一个工坊插件，再使用候选安装包更新同一个隔离数据目录。确认兼容插件和内置功能可用、不兼容和启动抛错的插件分别降级、用户源码和配置完整，最后在诊断包中核对插件 ID 和故障码。更新后的官方应用能启动是门槛；兼容性提示不应阻断用户主动更新。至少覆盖发布支持的 macOS、Windows、Linux 安装方式。

在候选 checkout 使用同一个脚本直接启动两个应用包（以下以 Linux 为例；无图形桌面的测试机用 `xvfb-run -a` 包裹命令）：

```sh
upgrade_data=$(mktemp -d)
npm run test:plugin-upgrade -- seed "$upgrade_data" /absolute/path/to/0.20.0/linux-unpacked/deep-student
npm run test:plugin-upgrade -- verify "$upgrade_data" /absolute/path/to/0.21.0/linux-unpacked/deep-student
npm run test:plugin-upgrade -- restore "$upgrade_data" /absolute/path/to/0.20.0/linux-unpacked/deep-student
```

脚本通过实际 Electron 和 Host 安装测试插件，核对前后应用版本、数据保留、独立降级、诊断和内置笔记。最后仅在隔离数据中换回旧应用，确认受版本限制的工坊插件无需重装即可恢复。它验证应用包启动，不验证签名、安装器替换或更新器下载。开发时也可不传可执行文件路径，在 0.20、0.21 两份源码 checkout 构建前端和 preload 后，用同一目录分别运行 `seed`、`verify`（旧 checkout 需复制这份测试脚本）。


macOS 验收还需要从当前已发布的客户端走应用内更新：旧版负责下载、验签及替换，候选包无法修复正在运行的旧更新器。检查更新后原路径上的 `.app` 能再次启动，`codesign --verify --deep --strict` 通过，且旧笔记内容可读。为本地验证生成 `.app.tar.gz` 时，用 `COPYFILE_DISABLE=1 /usr/bin/tar --no-mac-metadata --no-xattrs --no-acls --no-fflags` 打包，避免把 AppleDouble 旁车文件解成签名范围内的额外文件。旧客户端如果仍用 Electron 的虚拟文件系统解包，请先用 DMG 安装修正版，再恢复应用内更新。
