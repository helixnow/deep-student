# L02 native capability requests

## F7: image 0.24 resize and JPEG encoding

Source: `dstu-llm/src/llm_manager/exam_engine.rs:350–394`.
`NativeImage` currently publishes `dimensions(bytes)` and `decodeRgba(bytes)` only.
Required same-engine operation (suggested additive API):

```ts
resizeTriangleJpeg(
  bytes: Uint8Array,
  maxWidth: number,
  maxHeight: number,
  quality: number,
): Promise<Uint8Array>;
```

L02 calls this only above 1,500,000 image bytes, with bounds 1600×1600 and quality 85.
Do not resize when both dimensions already fit; preserve `image::DynamicImage::resize`
aspect ratio/rounding, `FilterType::Triangle`, and `ImageOutputFormat::Jpeg(85)` defaults.
The <=1,500,000-byte branch must preserve original bytes/MIME.
Decode/resize and encode errors need to remain distinguishable so L02 can retain
`加载试卷图片失败: {e}` versus `压缩试卷图片失败: {e}`.

Affected: image preparation for `ocr_extract_text`, free-text OCR, and structured OCR pages.
No substitute codec or native dependency was installed by L02.

## Native system OCR

L01 already exposes `performSystemOcr` and `SystemOcrNativeBinding`. F7 must supply the
platform binding on macOS/Windows; Linux keeps Rust's unsupported-platform behavior.
This is separate from the image codec above. Remote OCR is not blocked by native OCR itself.
