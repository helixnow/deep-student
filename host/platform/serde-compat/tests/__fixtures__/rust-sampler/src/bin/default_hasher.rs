//! 生成 `host/platform/serde-compat/tests/__fixtures__/default-hasher-promotion-fingerprint.json`。
//!
//! ```sh
//! cd host/platform/serde-compat/tests/__fixtures__/rust-sampler
//! CARGO_TARGET_DIR=/tmp/serde-compat-sampler-target cargo run --offline --release --bin default_hasher > ../default-hasher-promotion-fingerprint.json
//! rm -rf /tmp/serde-compat-sampler-target
//! ```
//!
//! dstu-memory/src/memory/evolution.rs:1090-1099 `promotion_fingerprint` 的逐行副本：`DefaultHasher::new()`
//! （SipHash-1-3，零密钥）依次 hash 每条日志的 date 与 content（`str::hash` = 字节 + 0xFF）。
//! 每行记录 `[[[date, content], ...], 指纹]`。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

fn promotion_fingerprint(logs: &[(&str, &str)]) -> String {
    let mut hasher = DefaultHasher::new();
    for (date, content) in logs {
        date.hash(&mut hasher);
        content.hash(&mut hasher);
    }
    format!("{}:{:x}", logs.len(), hasher.finish())
}

const CASES: &[&[(&str, &str)]] = &[
    &[],
    &[("2026-11-01", "")],
    &[("2026-11-01", "今天复习了二次函数，配方时符号又错了。")],
    &[
        ("2026-11-01", "a"),
        ("2026-11-02", "bcdefgh"),
        ("2026-11-03", "12345678"),
    ],
    &[("2026-11-05", "😀 emoji\n多行\t制表"), ("2026-11-06", "0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")],
];

fn esc(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let rows: Vec<String> = CASES
        .iter()
        .map(|logs| {
            let pairs: Vec<String> = logs.iter().map(|(d, c)| format!("[{}, {}]", esc(d), esc(c))).collect();
            format!("    [[{}], {}]", pairs.join(", "), esc(&promotion_fingerprint(logs)))
        })
        .collect();
    println!(
        "{{\n  \"generator\": \"host/platform/serde-compat/tests/__fixtures__/rust-sampler --bin default_hasher (std DefaultHasher)\",\n  \"promotionFingerprint\": [\n{}\n  ]\n}}",
        rows.join(",\n")
    );
}
