#[cfg(feature = "builtin_free_models")]
mod siliconflow;

#[cfg(feature = "builtin_free_models")]
pub use siliconflow::load_builtin_api_configs;

#[cfg(not(feature = "builtin_free_models"))]
pub fn load_builtin_api_configs(
) -> Result<Vec<crate::llm_manager::ApiConfig>, crate::models::AppError> {
    Ok(Vec::new())
}
