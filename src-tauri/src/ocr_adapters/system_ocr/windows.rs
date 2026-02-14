//! Windows 系统 OCR 实现
//!
//! 使用 Windows.Media.Ocr.OcrEngine API 进行文字识别。
//! 通过 `windows` crate 调用 WinRT API。

use crate::ocr_adapters::OcrError;

/// 在当前线程同步执行 Windows OCR（应在 spawn_blocking 中调用）
pub fn recognize_text_blocking(image_data: &[u8]) -> Result<String, OcrError> {
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    // 创建 OCR 引擎（使用用户系统语言）
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| {
        OcrError::Configuration(format!(
            "Failed to create Windows OCR engine: {}. \
             Ensure OCR language packs are installed in Windows Settings.",
            e
        ))
    })?;

    // 将图片数据写入内存流
    let stream = InMemoryRandomAccessStream::new()
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to create memory stream: {}", e)))?;

    let writer = DataWriter::CreateDataWriter(&stream)
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to create DataWriter: {}", e)))?;

    writer
        .WriteBytes(image_data)
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to write image bytes: {}", e)))?;

    writer
        .StoreAsync()
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to store data: {}", e)))?
        .get()
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to complete store: {}", e)))?;

    writer
        .FlushAsync()
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to flush: {}", e)))?
        .get()
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to complete flush: {}", e)))?;

    // 将流指针回到开头
    stream
        .Seek(0)
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to seek stream: {}", e)))?;

    // 解码图片为 SoftwareBitmap
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to create BitmapDecoder: {}", e)))?
        .get()
        .map_err(|e| {
            OcrError::ImageProcessing(format!("Failed to complete bitmap decoding: {}", e))
        })?;

    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to get SoftwareBitmap: {}", e)))?
        .get()
        .map_err(|e| {
            OcrError::ImageProcessing(format!("Failed to complete bitmap conversion: {}", e))
        })?;

    // 执行 OCR
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| OcrError::ImageProcessing(format!("OCR recognition failed: {}", e)))?
        .get()
        .map_err(|e| {
            OcrError::ImageProcessing(format!("Failed to complete OCR recognition: {}", e))
        })?;

    // 提取文本（OcrResult.Text 包含所有行文本，已由换行符分隔）
    let text = result
        .Text()
        .map_err(|e| OcrError::ImageProcessing(format!("Failed to get OCR text: {}", e)))?
        .to_string();

    Ok(text)
}
