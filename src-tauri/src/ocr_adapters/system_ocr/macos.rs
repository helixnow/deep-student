//! macOS 系统 OCR 实现
//!
//! 使用 Apple Vision Framework 的 VNRecognizeTextRequest 进行文字识别。
//! 通过 objc runtime 直接调用 Objective-C API，无需额外依赖。

use crate::ocr_adapters::OcrError;

#[link(name = "Vision", kind = "framework")]
extern "C" {}

/// 在当前线程同步执行 Vision OCR（应在 spawn_blocking 中调用）
pub fn recognize_text_blocking(image_data: &[u8]) -> Result<String, OcrError> {
    use objc::runtime::{Class, Object, BOOL, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    unsafe {
        // 创建 autorelease pool
        let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];

        let result = recognize_text_inner(image_data);

        // 释放 autorelease pool
        let _: () = msg_send![pool, drain];

        result
    }
}

unsafe fn recognize_text_inner(image_data: &[u8]) -> Result<String, OcrError> {
    use objc::runtime::{Class, Object};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    // 创建 NSData
    let ns_data: *mut Object = msg_send![
        class!(NSData),
        dataWithBytes:image_data.as_ptr()
        length:image_data.len()
    ];
    if ns_data.is_null() {
        return Err(OcrError::ImageProcessing(
            "Failed to create NSData from image bytes".to_string(),
        ));
    }

    // 创建 VNImageRequestHandler
    let handler_cls = Class::get("VNImageRequestHandler").ok_or_else(|| {
        OcrError::Unsupported(
            "VNImageRequestHandler class not found. Requires macOS 10.13+".to_string(),
        )
    })?;
    let handler: *mut Object = msg_send![handler_cls, alloc];
    let empty_dict: *mut Object = msg_send![class!(NSDictionary), dictionary];
    let handler: *mut Object = msg_send![handler, initWithData:ns_data options:empty_dict];
    if handler.is_null() {
        return Err(OcrError::ImageProcessing(
            "Failed to create VNImageRequestHandler".to_string(),
        ));
    }

    // 创建 VNRecognizeTextRequest
    let request_cls = Class::get("VNRecognizeTextRequest").ok_or_else(|| {
        OcrError::Unsupported(
            "VNRecognizeTextRequest class not found. Requires macOS 10.15+".to_string(),
        )
    })?;
    let request: *mut Object = msg_send![request_cls, alloc];
    let request: *mut Object = msg_send![request, init];
    if request.is_null() {
        return Err(OcrError::ImageProcessing(
            "Failed to create VNRecognizeTextRequest".to_string(),
        ));
    }

    // 设置识别精度为 Accurate (VNRequestTextRecognitionLevelAccurate = 1)
    let _: () = msg_send![request, setRecognitionLevel: 1_i64];

    // 设置识别语言：中文 + 英文
    let zh_hans: *mut Object =
        msg_send![class!(NSString), stringWithUTF8String: b"zh-Hans\0".as_ptr()];
    let en_us: *mut Object = msg_send![class!(NSString), stringWithUTF8String: b"en-US\0".as_ptr()];
    let lang_array: *mut Object = msg_send![
        class!(NSArray),
        arrayWithObjects:&[zh_hans, en_us] as *const *mut Object
        count:2_usize
    ];
    let _: () = msg_send![request, setRecognitionLanguages: lang_array];

    // 将 request 放入数组
    let requests: *mut Object = msg_send![class!(NSArray), arrayWithObject: request];

    // 执行识别
    let mut error: *mut Object = std::ptr::null_mut();
    let success: bool = msg_send![handler, performRequests:requests error:&mut error];

    if !success {
        if !error.is_null() {
            let desc: *mut Object = msg_send![error, localizedDescription];
            let c_str: *const std::os::raw::c_char = msg_send![desc, UTF8String];
            let err_msg = CStr::from_ptr(c_str).to_string_lossy().to_string();
            return Err(OcrError::ImageProcessing(format!(
                "Vision OCR failed: {}",
                err_msg
            )));
        }
        return Err(OcrError::ImageProcessing(
            "Vision OCR failed with unknown error".to_string(),
        ));
    }

    // 提取结果
    let results: *mut Object = msg_send![request, results];
    if results.is_null() {
        return Ok(String::new());
    }

    let count: usize = msg_send![results, count];
    let mut full_text = String::new();

    for i in 0..count {
        let observation: *mut Object = msg_send![results, objectAtIndex: i];
        if observation.is_null() {
            continue;
        }

        // topCandidates:1 获取最佳候选
        let candidates: *mut Object = msg_send![observation, topCandidates: 1_usize];
        if candidates.is_null() {
            continue;
        }

        let candidate_count: usize = msg_send![candidates, count];
        if candidate_count > 0 {
            let candidate: *mut Object = msg_send![candidates, objectAtIndex: 0_usize];
            if !candidate.is_null() {
                let ns_string: *mut Object = msg_send![candidate, string];
                if !ns_string.is_null() {
                    let c_str: *const std::os::raw::c_char = msg_send![ns_string, UTF8String];
                    if !c_str.is_null() {
                        let text = CStr::from_ptr(c_str).to_string_lossy().to_string();
                        if !full_text.is_empty() {
                            full_text.push('\n');
                        }
                        full_text.push_str(&text);
                    }
                }
            }
        }
    }

    Ok(full_text)
}
