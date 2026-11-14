# L01-llm-providers 原生依赖需求

## 0. R1 复核后的状态（2026-11-04）

- L01-01 远程图片：已在生产入口接入 `llmAdapters.prepareRemoteImages`，使用
  `host/platform/net-policy` 的 `fetchBinaryWithCache` 真实下载并改写为 `data:` URL；
  `index.ts` 注册同步缓存读取器。L02 的同步 `preparePlainProviderRequest` 调用点仍需
  L02 侧在构建请求前 `await ctx.llmAdapters.prepareRemoteImages?.(body)`。
- L01-02 系统 OCR：按协调者指令移交 C2，本 lane 不声称 macOS/Windows 已实现；Linux
  `unsupported` 仍是 Rust 同平台行为。
- L01-03 Codex 认证：本 lane 已发布 `llmCodexAuth` 服务，与五个命令共享同一个
  `CodexAuthManager`；L02 的 `connection_test.ts` 拒绝分支需 L02 侧改为调用该服务。

## 1. 系统 OCR（唯一真实原生依赖，F7 类别，已移交 C2）

Rust 实现：`crates/dstu-llm/src/ocr_adapters/system_ocr/`（macOS Vision / Windows.Media.Ocr / iOS Vision）。
Host 已完成可移植部分：

- `SystemOcrAdapter`（`engineType='system_ocr'`、仅 `free_ocr`、空 prompt、文本结果封装、`maxTokens=0`、`requiresHighDetail=false`）；
- `performSystemOcr(imageData)`（平台检查、错误映射、绑定调用）；
- `isSystemOcrPlatformSupported()` 与 `OcrAdapterFactory` 的平台列表/工厂创建。

缺少的只有真正的平台识别调用。需要 F7/原生 lane 在启动时注入：

```ts
setSystemOcrBinding({
  async performSystemOcr(imageData: Uint8Array): Promise<string> {
    // macOS: VNRecognizeTextRequest；Windows: Windows.Media.Ocr。
    // 返回纯文本；失败抛 OcrError 或普通 Error（会被映射为 OcrError.imageProcessing）。
    return text;
  },
});
```

未注入时 `performSystemOcr` 抛 `OcrError.unsupported`，不会返回伪造文本或假数据。
桌面端平台检测为 `darwin` / `win32`（Rust 另有 iOS，Electron 桌面不涉及）。

## 2. Gemini / Anthropic 远程图片内联（生产入口已接入）

Rust 的 `build_request` 会通过 `dstu_util::utils::fetch::fetch_binary_with_cache` 同步抓取
http(s) 图片并转成 base64。Host 的 `ProviderAdapter.buildRequest` 是同步函数，不能执行网络 I/O，
因此生产路径拆成两步：

1. `await ctx.llmAdapters.prepareRemoteImages?.(body)`：调用
   `host/platform/net-policy` 的 `fetchBinaryWithCache`（SSRF 校验、10 秒超时、不跟随重定向、
   内存缓存）真实下载 OpenAI/Anthropic 形状的图片 part，并把它们改写为 `data:` URL；
   同时把字节写入本 lane 缓存。
2. 同步 `buildRequest`：`data:` URL 直接内联；原始 http(s) URL 命中本 lane 缓存或
   `setRemoteImageFetcher` 注入的读取器时内联；下载失败/未命中时跳过图片。

- Anthropic 的 `createBase64Payload` 与 Gemini 的 `imageUrlToInlineData` 共用
  `src/media/remote-image.ts`；`index.ts` 已注册 `setRemoteImageFetcher({ fetchImage: cachedRemoteImage })`。
- 失败路径与 Rust `fetch_binary_with_cache -> None` 一致：保留原 URL 并由适配器跳过，不会伪造图片。
- 跨 lane：L02 的 `preparePlainProviderRequest` 目前仍是同步函数，需在调用前增加
  `await ctx.llmAdapters.prepareRemoteImages?.(body)`；该文件属于 L02，本 lane 未修改。

## 3. 多模态嵌入服务依赖的 L02 接口（非原生）

`MultimodalEmbeddingService` 已按最小运行时接口完成，真实实现由 L02 注入：
`isMultimodalRagConfigured`、`getVlEmbeddingModelConfig`、`callMultimodalEmbeddingApi`、
`callMultimodalEmbeddingApiWithConfig`、`getEmbeddingModelConfig`、`callEmbeddingApi`、
`callOcrModelRawPrompt`。接口定义在 `src/multimodal/embedding-service.ts` 并已从 `api.ts` 导出。
