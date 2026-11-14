# F3-storage 原生接口需求（F7）

## WP-164 更新：Linux-x64 供方已到位

main `676b29852` 已含 F7 WP-161。`NativeSqliteBusy` 从 `native/api.ts` 发布，真实
`dstu.native` provider 可传给 `openStartupDatabase(path, { nativeSqliteBusy })`，不依赖storage。
F3 Connection/StartupDatabase 已接入单参数setBusyHandler；异常吞为false（busy.rs:60），
下面“安全传回异常”的旧提案不再适用。mac/win产物与panic hook可观测性仍为独立未验边界。

## WP-008 / B5-D17：SQLite busy handler（2026-11-05，待裁定）

L20b `state.rs:597-664` 需要在**同一次 SQL 调用的真实锁冲突回调内**暂停 contender，
再由 writer COMMIT 后放行。已核已安装 better-sqlite3 **13.0.3** 的实际 JS/native 方法表，
没有 handler/interrupt 入口；timeout 的内部 handler 不可观测。main 的 openStartupDatabase
已经存在，阻塞不在开库。请求增补同一绑定，方法仅为：

```ts
setBusyHandler(handler: ((priorInvocations: number) => boolean) | null): void;
```

必须操作该绑定自己的 sqlite3 指针；真实 SQLite 调用回调；null 禁用等待；profile/PRAGMA
timeout 会覆盖 handler；callback 不可重入，异常经 native 栈安全传回，替换/close 释放引用。
worker 的 MessagePort + Atomics 等待支持 parent finally 放行/取消，取消不靠同线程 AbortSignal。
可执行运行时探针、双连接回归、原生落点与完整验收顺序见 `L20B-OBSERVABILITY.md` 的 WP-008 节。
需要架构师批准/F7 交付原生产物，然后 F3 发布方法、L20b 接入原业务测试并复验；当前没有空实现。

更新时间：2026-11-04。**main 的 `host/platform/native/image/api.ts` 只有
`dimensions` / `decodeRgba`，没有 `resizeAndEncodeJpeg`。** F7 候选分支
`ds-mig/F7-native`（核对时 HEAD `f8e38e9c4`）已发布
`nativeImage.resizeAndEncodeJpeg`，实现为 `decodeRgba` → 可选 Triangle 缩放 →
`image` WASM 解码 + jpeg-js 编码，边界只有 RGBA8；该分支尚未合入 main。
F3 已实现不依赖真实重编码的策略 wrapper：`high/unknown/auto` 阈值、`<500 KB` no-op、
invalid 回退与参数顺序均由 `file-manager.ts` 负责，并通过 `ctx.imageQuality` 公开。
原 Rust 1492 测试的第一条（真实 64×32 PNG + 真实 invalid decode）已用真实
`ctx.nativeImage.dimensions`（`image 0.24` WASM）经 `ctx.imageQuality` 移植到
`image-quality-service.test.ts`，不需要 encode。1200×900 的真实 JPEG 格式/尺寸/PSNR
（D5 独立）继续 pending，不能以“能生成相似 JPEG”宣布与 Rust `image = 0.24.9` 等价。

## 1. F7 候选分支的接口（main 尚未合入）

`ds-mig/F7-native:host/platform/native/image/api.ts`（main 目前只有前两项）：

```ts
export interface RgbaImage { width: number; height: number; rgba: Uint8Array }

export interface NativeImage {
  dimensions(bytes: Uint8Array): Promise<{ width: number; height: number }>;
  decodeRgba(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }>;
  resizeRgba(input: RgbaImage, width: number, height: number, filter: 'triangle' | 'lanczos3'): RgbaImage;
  resizeDimensions(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number };
  encode(input: RgbaImage, options: { format: 'png' | 'jpeg'; quality?: number }): Promise<Uint8Array>;
  /** file_manager.rs two-step f64-truncate bounding box, then Triangle + JPEG. RGBA8 boundary. */
  resizeAndEncodeJpeg(
    bytes: Uint8Array,
    options: { maxDimension: number; quality: number },
  ): Promise<Uint8Array>;
}
```

`ds-mig/F7-native:host/platform/native/image/index.ts` 的实现：

```ts
async resizeAndEncodeJpeg(bytes, options) {
  let decoded = await image.decodeRgba(bytes);
  if (Math.max(decoded.width, decoded.height) > options.maxDimension) {
    const scale = options.maxDimension / Math.max(decoded.width, decoded.height);
    const bounds = resizeDimensions(decoded.width, decoded.height,
      Math.trunc(decoded.width * scale), Math.trunc(decoded.height * scale));
    decoded = resizeRgba(decoded, bounds.width, bounds.height, 'triangle');
  }
  return encode(decoded, { format: 'jpeg', quality: options.quality });
}
```

已对齐的部分：

- 解码器是编译到 wasm32-wasip1 的同一 `image = 0.24` crate（`native/wasm/src/image_engine.rs`），
  不是 sharp；BMP/TGA/ICO/PNM 等格式接受面与 Rust `image::load_from_memory` 一致。
- `operations.ts:22-77` 的 Triangle 权重/两阶段采样按 image 0.24.9 `imageops/sample.rs`
  实现：f32、clipped support、裁剪后归一化、垂直→水平、round。代码审阅对齐。
- `resizeDimensions` 复刻 `DynamicImage::resize` 的包围盒（含放大），
  `resizeAndEncodeJpeg` 用 `Math.trunc` 复刻 Rust `(w as f64 * scale) as u32`。
- F7 测试 `host/platform/native/tests/image-operations.test.ts:106-115` 用 1200×900
  的 PNG 验证低质量路径输出 JPEG、尺寸 768×576；但只断言 SOI `[255,216]` 和
  `dimensions`，没有像素/字节交叉向量。

## 2. 与 Rust `FileManager::adjust_image_quality_bytes` 的剩余差异

Rust 源码：`src-tauri/crates/dstu-storage/src/file_manager.rs:74-167`。

### 2.1 编码器不同（阻塞严格等价）

Rust 用 `image = 0.24` 的 `ImageOutputFormat::Jpeg(quality)`；F7 候选分支用
`image` WASM 解码 + jpeg-js 编码（`encode` worker）。
同一 RGBA8 输入在两个编码器下通常能得到可解码的 JPEG，但：
- 字节流不保证相同（量化表、色度下采样、元数据策略可能不同）；
- 解压后的像素不保证逐像素相同（尤其 quality 60 的边缘/色度）；
- Rust 测试只检查 `image::guess_format == Jpeg` 和尺寸，所以“F3 测试能过”不等于
  “编码器等价”。

需要 F7 二选一：

1. **严格路径（推荐）**：在同一个 WASI `image 0.24.9` 引擎内实现
   `DynamicImage::resize(..., Triangle)` + `write_to(Jpeg(quality))`，返回编码后
   字节；不要经过 jpeg-js。若无法保留原始像素类型，至少提供 `Rgb8`/`Rgba8` 两条
   明确路径，并为其他类型给出拒绝/降级规则。
2. **可验证的替代**：保留 jpeg-js 编码，但提供 Rust `image` 生成的 byte-level 或
   解码后 RGBA byte-level 交叉向量（至少 RGB8 1200×900 low、64×32 no-op、invalid
   三类），并由协调者明确接受“编码字节可不同、解码像素在容差内”的降级。没有该
   决定前，F3 不宣布等价。

### 2.2 只接受 RGBA8，Rust 保留 DynamicImage 像素类型

`decodeRgba` 会把 16-bit、灰度、CMYK 等统一转成 8-bit RGBA，再做 Triangle 缩放；
Rust `DynamicImage::resize` 在原始像素类型上采样（如 `Rgb16`、`Luma8`），最后才
编码。两者在以下输入上会不同：

- 16-bit PNG/TIFF：RGBA8 量化后再缩放，精度和舍入不同；
- 灰度/带 alpha：RGBA 通道独立缩放后 jpeg-js 的 alpha 处理可能与 Rust JPEG 编码
  （JPEG 无 alpha，Rust 通常忽略 alpha）不同；
- CMYK JPEG：解码到 RGBA 的色彩转换可能不同。

需要 F7 提供像素类型保留路径，例如：

```ts
export interface DynamicImage {
  width: number;
  height: number;
  kind: 'luma8' | 'luma16' | 'rgb8' | 'rgb16' | 'rgba8' | 'rgba16';
  data: Uint8Array;
}
decodeDynamic(bytes: Uint8Array): Promise<DynamicImage>;
resizeDynamic(input: DynamicImage, width: number, height: number, filter: ImageFilter): DynamicImage;
encodeDynamic(input: DynamicImage, options: ImageEncodeOptions): Promise<Uint8Array>;
```

如果 F7 决定只支持 RGBA8，则必须在 API 文档和 F3 `file-manager.ts` 中写明：
非 RGBA8 输入会先量化，`image_quality_tests` 不能宣称逐像素等价。

### 2.3 no-op / invalid 策略属于 F3，不属于 F7

Rust `adjust_image_quality_bytes` 的策略：

- `vision_quality == "high"` → 原字节返回，不解码；
- 解码失败 → 原字节返回；
- `auto`：>4MP → low(768/60)，>2MP → medium(1024/75)，否则原字节；
- 未知策略 → 原字节；
- 不需要缩放且 **原始字节 < 500_000** → 原字节；
- 否则缩放（如需要）→ JPEG；编码失败 → 原字节。

F7 的 `resizeAndEncodeJpeg` 不做这些判断，invalid 会直接 reject。F3 wrapper
在调用 F7 前完成尺寸/字节数判断，不能把“F7 会编码”当成 Rust 的 no-op 行为。
`host/platform/storage/file-manager.ts` 已导出
`adjustImageQualityBytes(bytes, quality, codec)` / `adjustImageQualityBase64(...)`：
`codec` 是 `dimensions` + `resizeAndEncodeJpeg` 的最小端口，生产调用方必须传真实
`ctx.nativeImage`，测试只注入同一端口的记录替身，不在生产路径写假 codec。

### 2.4 Rust 两条测试的当前去向

`file_manager.rs:1491-1510`（已 ported）：

- 64×32 PNG，quality 为 `high/low/medium/auto/unknown` 时都返回原字节；
- `not an image` + low 返回原字节；
- `not base64!` + low 返回原字符串。

`file_manager.rs:1512-1535`（仍 pending）：

- 1200×900 PNG + low → `guess_format == Jpeg`，尺寸 768×576；
- base64 wrapper 与 bytes wrapper 结果逐字节相同。

第一条的策略语义已在 `file-manager.test.ts` 用注入端口覆盖（`[1,2,3,4]` + recordingCodec）；
真实 64×32 PNG 与真实 invalid decode 已在 `image-quality-service.test.ts` 经
`ctx.imageQuality` + 真实 `ctx.nativeImage.dimensions`（`image 0.24` WASM）跑通，因此该条
标 ported，不依赖 L12 或 F7 encode。第二条的 JPEG 格式/尺寸/PSNR 依赖 F7 编码器合入 main，
不能以策略测试或 jpeg-js 输出替代。`file-manager.test.ts` 另覆盖 auto 的 2MP/4MP 边界与
`resizeAndEncodeJpeg(bytes, { maxDimension, quality })` 的 low=768/60 参数传递。

## 3. 请求 F7 的交付物

1. `resizeAndEncodeJpeg` 改为 `image 0.24.9` 原生 resize+JPEG（推荐），或提供
   协调者接受的交叉向量与容差说明。
2. 明确像素类型支持矩阵：RGBA8 / RGB8 / Luma8 / 16-bit / CMYK 哪些逐像素等价，
   哪些会量化；不支持的输入如何报错（不要静默降级后宣称等价）。
3. 给 F3 的最小接口（按选择）：
   - 严格：`resizeAndEncodeJpeg(bytes, { maxDimension, quality })` 完全等价；
   - 保留类型：`decodeDynamic` / `resizeDynamic` / `encodeDynamic`；
   - 至少：`jpegEncode(dynamic, quality)` + `resizeDynamic`。
4. 测试向量：Rust `image` 对 RGB8 1200×900 low 的 JPEG 输出（或解码后 RGBA
   bytes）、64×32 no-op 原字节、invalid 输入；标注生成用的 Rust/image 版本。

## 4. 调用方与状态

- 生产调用方：L12 `pdf_processing_service.rs:483` 的 `"low"` 策略；F3 已通过
  `ctx.imageQuality.adjustImageQualityBytes(bytes, quality, ctx.nativeImage)` /
  `adjustImageQualityBase64(...)` 提供正式服务入口。L12 当前 `image-codec.ts` 仍有自有
  sharp/PNG 实现，需要切到该入口并删除本地策略。
- F3 测试：`host/platform/storage/tests/file-manager.test.ts` 覆盖策略 no-op/invalid/auto
  阈值/参数顺序；`image-quality-service.test.ts` 覆盖 `ctx.imageQuality` 服务入口，并以
  真实 64×32 PNG + 真实 invalid decode 跑通第一条 Rust 测试。第二条 Rust image quality
  测试仍 pending，等 F7 的 `resizeAndEncodeJpeg` 合入 main 后做 JPEG 等价验证。
- 本 lane 不引入 sharp 或新图像依赖；F7 是唯一原生图像入口。
