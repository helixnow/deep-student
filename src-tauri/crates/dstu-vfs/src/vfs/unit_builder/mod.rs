//! Unit Builder 模块
//!
//! 将不同类型的资源转换为 Unit 列表的统一接口。
//! 每种资源类型有对应的 Builder 实现。

mod builders;
mod registry;
mod trait_def;

pub use builders::*;
pub use registry::UnitBuilderRegistry;
pub use trait_def::{UnitBuildInput, UnitBuildOutput, UnitBuilder};
