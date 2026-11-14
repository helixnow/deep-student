# X3-data-compat：旧数据兼容（老用户升级后数据能打开）

目标：证明 Rust 版用户的现有数据目录，被迁移后的 Host 打开时：迁移幂等、数据完整可读、校验和与 refinery 兼容、加密数据可解。

## 交付（只写 `host/e2e/data-compat/` 与 `docs/dev/electron-migration/audits/X3-data-compat.md`）
1. **构造"Rust 版数据库"样本**：**不要编译或运行 Rust**。按 Rust 侧迁移文件（`src-tauri/` 下 refinery 迁移 SQL，按 Rust 的版本顺序）用 better-sqlite3 逐个执行，并按 refinery 的方式写入 `refinery_schema_history`（版本、名称、applied_on、checksum——checksum 用 Rust refinery 的算法，F3 已实现 SipHash-1-3 兼容，复用 `host/platform/storage` 的公开接口）。为每个库插入覆盖主要表的代表性数据（含中文、emoji、大数、NULL、JSON 列、时间列各种格式）。
2. 用 Host 的存储服务打开这些库：断言不会重复执行已应用的迁移、checksum 校验通过、新增迁移（如果 Host 有）正确追加；再经各插件的公开服务读回代表性数据并逐字段比对（时间格式、数值精度、布尔/整数表示、JSON 字符串原样）。
3. 加密/密钥相关：用 F4 已有的测试向量证明旧格式密文能解开（见 `host/platform/secrets` 的测试向量；缺向量就在报告列出缺口，不要伪造）。
4. 多数据空间（data_space 槽位）与备份 ZIP 的读取兼容，能覆盖多少覆盖多少，覆盖不了的写明原因。
5. 不改别的 lane 的代码：发现的不兼容写进报告，按归属 lane 分组。

完成后贴出：覆盖的数据库与表清单、通过/失败统计、不兼容问题清单。
