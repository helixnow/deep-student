# 本地测试工具

桌面版启动与打包见 [Node 版构建说明](../docs/BUILD-CONFIG.md)。这里保留 Electron 和移动版共用的云同步测试工具。

启动 WebDAV、MinIO 和 FTP 测试服务需要 Docker：

```sh
npm run dstu-test:cloud:up
```

这与 CI 的云存储契约测试使用同一份 [Compose 配置](../scripts/dev/docker-compose.sync-test.yml)。本地 WebDAV 地址为 `http://127.0.0.1:8080`，测试用户名和密码分别为 `webdav` 和 `webdav123`。测试结束后可运行 `npm run dstu-test:cloud:down` 停止服务并清除测试卷。

使用专用测试数据目录验证大批量同步：

```sh
npm run dstu-test:seed-wide-sync -- --slot-root /path/to/test-data
npm run dstu-test:inspect-wide-sync -- --slot-root /path/to/test-data
```
