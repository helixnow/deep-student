// adapters module
// 通过 #[path] 引入含有破折号命名的文件为合法模块名，便于其他模块引用
#[path = "gemini-openai-converter.rs"]
pub mod gemini_openai_converter;
