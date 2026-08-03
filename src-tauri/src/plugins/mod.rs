//! Pluggable channel plugin system (compile-time registry).

pub mod commands;
pub mod events;
pub mod ilink_bot;
pub mod manager;
pub mod types;

pub use commands::*;
pub use manager::PluginManager;
pub use types::*;
