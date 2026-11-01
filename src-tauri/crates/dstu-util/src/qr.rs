//! QR code PNG (base64) helpers.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use image::Luma;
use qrcode::QrCode;

use crate::models::AppError;

/// Encode `content` as a QR PNG and return raw base64 (no data-url prefix).
pub fn qrcode_png_base64(content: &str) -> Result<String, AppError> {
    let code = QrCode::new(content.as_bytes())
        .map_err(|e| AppError::validation(format!("生成二维码失败: {}", e)))?;
    let image = code.render::<Luma<u8>>().min_dimensions(256, 256).build();
    let mut png_bytes: Vec<u8> = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png_bytes);
        image::DynamicImage::ImageLuma8(image)
            .write_to(&mut cursor, image::ImageOutputFormat::Png)
            .map_err(|e| AppError::internal(format!("编码 PNG 失败: {}", e)))?;
    }
    Ok(B64.encode(png_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_non_empty_png() {
        let b64 = qrcode_png_base64("https://weixin.qq.com/x/test").expect("qr");
        assert!(b64.len() > 100);
        let bytes = B64.decode(&b64).expect("decode");
        assert_eq!(&bytes[0..8], b"\x89PNG\r\n\x1a\n");
    }
}
