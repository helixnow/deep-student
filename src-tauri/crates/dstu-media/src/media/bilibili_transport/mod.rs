//! One controlled exit for Bilibili API, authentication, subtitles and media bytes.
pub mod bridge;
pub mod bridge_server;
pub mod grpc;
pub mod native;
pub mod policy;
pub mod session;
pub mod types;

pub use session::{BiliAttempt, TransportSettings};
pub use types::*;

impl From<BiliError> for super::MediaError {
    fn from(error: BiliError) -> Self {
        Self::Transport(Box::new(error))
    }
}
