model=gpt-5.6-sol-xhigh-fast

## 结论

本轮不改代码。

Vendor Key 统一存储路径设置为：`/workspace/.secrets/vendor-keys/`。

- 按供应商分文件存放，例如：`/workspace/.secrets/vendor-keys/openai.env`。
- 文件权限应设为仅当前用户可读写（`0600`），目录权限设为 `0700`。
- 应用通过环境变量或密钥管理服务读取，日志、报错和审计产物中必须脱敏。
- 仓库内只保留不含真实值的变量名示例；真实 Key 不得写入仓库、文档、配置样例或提交历史。
