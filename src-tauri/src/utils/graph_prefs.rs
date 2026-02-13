use crate::database::Database;

const DEFAULT_TOPK: usize = 5;
const MIN_TOPK: usize = 1;
const MAX_TOPK: usize = 20;
const DEFAULT_THRESHOLD: f32 = 0.6;

pub fn is_enabled(db: &Database) -> bool {
    db.get_setting("graph_rag.enabled")
        .ok()
        .flatten()
        .map(|v| v.to_ascii_lowercase())
        .map(|v| v != "0" && v != "false")
        .unwrap_or(true)
}

pub fn topk(db: &Database) -> usize {
    db.get_setting("graph_rag.top_k")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|v| v.clamp(MIN_TOPK, MAX_TOPK))
        .unwrap_or(DEFAULT_TOPK)
}

pub fn threshold(db: &Database) -> f32 {
    db.get_setting("graph_rag.threshold")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<f32>().ok())
        .map(|v| v.clamp(0.0, 1.0))
        .unwrap_or(DEFAULT_THRESHOLD)
}

pub fn dynamic_enabled(db: &Database) -> bool {
    db.get_setting("graph_rag.dynamic")
        .ok()
        .flatten()
        .map(|v| v.to_ascii_lowercase())
        .map(|v| v != "0" && v != "false")
        .unwrap_or(true)
}
