model=gpt-5.6-sol-xhigh-fast
# WebDAV / S3 / FTP 三联静态复核

- 范围：仅复核 WebDAV `decode_path`、S3 `normalize_endpoint`、FTP 550/501
  缺失判定链。
- 方法：只读当前源码与测试源码；未使用 Git/gh，未运行测试。

## 1. WebDAV `decode_path`

**PASS。**

- `src-tauri/src/cloud_storage/webdav.rs:177-209` 的生产 URL 构造链对 endpoint
  的已编码 path segment 先调用 `decode_path`，再交给 `path_segments_mut().push`
  做一次编码，避免中文或空格 endpoint 被双重编码。
- `webdav.rs:596-639` 从绝对或相对 href 提取原始路径，并把 href 与
  `base_url.path()` 统一解码后再比较；不属于同步根或 prefix 的路径返回空 key，
  没有把越界 href 纳入列表。
- `webdav.rs:1993-2069` 覆盖中文、`%20`、绝对/相对 href 及 URL 回拼，
  `2072-2123` 覆盖 PROPFIND 列表解析，`2126-2153` 有源码契约守卫。
- 边界：当前是整路径百分号解码，测试没有覆盖把 `%2F` 当作资源名内字面分隔符的
  往返语义；现有中文/空格修复成立，但不应外推为所有保留字符均已做供应商实测。

## 2. S3 `normalize_endpoint`

**PASS。**

- `src-tauri/src/cloud_storage/s3.rs:85-120` 先清理空白、尾 `/` 并补默认
  `https://`；只有 host 精确匹配 `{bucket}.{known-service-host}` 时才剥离
  bucket。URL 解析失败、空 bucket、IP、localhost、自建域名与未知供应商均不猜改。
- `s3.rs:122-140` 的服务 host 白名单覆盖 COS、OSS、S4 及 AWS
  global/regional 形态；`152-165` 证明归一化结果实际进入 SDK endpoint 配置，
  不是未调用 helper。
- `s3.rs:1117-1151` 覆盖四类正向剥离；`1187-1272` 覆盖补 scheme、
  path-style 路径保留、规范 endpoint、R2、IP/localhost、bucket 名为 `s3`
  和未知域名等保守反例。
- 边界：白名单之外的 dualstack、accelerate 或其他供应商 bucket-host 不会被
  自动修正；这是保守兼容边界，不是静默误改。

## 3. FTP 550/501

**PASS（限定为 not-found 分类链）。**

- `src-tauri/src/cloud_storage/ftp.rs:239-265` 优先读取 suppaftp
  `UnexpectedResponse` 方括号状态码，再以独立 4xx/5xx token 兜底。
- `ftp.rs:267-287` 必须同时满足状态码属于 550/501，且消息明确含
  `no such file/directory`、`not retrievable`、`does not exist` 或
  file/directory `not found`，才归为缺失；权限型、歧义 550 和无状态码
  `not found` 均保持错误。
- 该双门实际接入 `get`、`list_outcome`、`delete`、`stat` 与文件下载路径
  （`ftp.rs:843-875,913-954,997-1077,1188-1201`）。正反例位于
  `1284-1383`，包含 501 明确缺失、权限/歧义 550、450 和路径中出现 `550`
  的反例。
- 两点口径限制：
  1. `is_missing_directory_error` 先委托通用 helper，因此“明确缺失”的 501
     也会被接受；`289-294` 注释写成“550 CWD”比实现窄，但仍满足本轮
     550/501 双门要求。
  2. `ensure_directory` 在 `350-379` 仍用字符串 `550` 抑制 MKDIR 失败日志，
     没有走严格 helper。后续 CWD/上传仍会失败，未形成 not-found 误报或操作假成功，
     但“所有 FTP 550 处理都已严格白名单化”的更强表述不成立。

## 结论

**PASS（静态、限定口径）。** 三项 helper 均已接入生产路径，正反向测试源码在位；
未发现中文/空格 WebDAV 路径、已知 S3 bucket-host 或 FTP not-found 双门的回退。
保留边界是 WebDAV `%2F` 未覆盖、S3 未知 host 不归一化，以及 FTP MKDIR 550
仍有可观测性弱点；本轮未执行真实供应商联调或测试命令。

**本轮不改代码。**
