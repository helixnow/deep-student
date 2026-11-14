//! 生成 `host/platform/serde-compat/tests/__fixtures__/serde-json-floats.json`。
//!
//! ```sh
//! cd host/platform/serde-compat/tests/__fixtures__/rust-sampler
//! CARGO_TARGET_DIR=/tmp/serde-compat-sampler-target cargo run --offline --release > ../serde-json-floats.json
//! rm -rf /tmp/serde-compat-sampler-target
//! ```
//!
//! 每个浮点样例记录输入的 IEEE-754 位模式（hex）和 `serde_json::to_string` 的输出；对照表另记 ryu 1.0.23
//! （serde_json 1.0.146 之前用它）的输出，说明两者只在非负指数的 `e+` 上不同。
//! `fsrsStateBeforeSnapshot` 是 dstu-anki `FsrsStateBeforeSnapshot`（fsrs_review_service.rs:857-884）的逐字段副本。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FsrsStateBeforeSnapshot {
    snapshot_version: u8,
    card_state_id: String,
    anki_card_id: String,
    deck_id: Option<String>,
    state: i32,
    stability: Option<f64>,
    difficulty: Option<f64>,
    elapsed_days: f64,
    scheduled_days: f64,
    reps: i32,
    lapses: i32,
    due_ms: i64,
    last_review_ms: Option<i64>,
    suspended: bool,
    fsrs_params_version: String,
    desired_retention: Option<f64>,
    #[serde(default)]
    leech: bool,
    #[serde(default)]
    buried_until_ms: Option<i64>,
    #[serde(default)]
    learning_step: u32,
}

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
}

const TABLE_F64: &[&str] = &[
    "0", "-0", "1", "-1", "92", "525600", "0.1", "0.2", "0.30000000000000004", "1.5", "100.25",
    "0.3333333333333333", "2.5", "1e-7", "1.5e-7", "1e-6", "9.999999999999999e-6", "1e-5", "1.2e-5",
    "0.0001", "0.001", "0.01", "123456789012345.6", "999999999999999.9", "1e15", "1000000000000000.1",
    "9999999999999998", "1e16", "1.5e16", "12345678901234567", "1e17", "1e21", "1e22", "1e23", "9007199254740992",
    "9007199254740993", "1152921504606846976", "18446744073709551615", "1e100", "1.7976931348623157e308",
    "2.2250738585072014e-308", "2.225073858507201e-308", "5e-324", "1e-100", "-2.5e-10", "4.35", "0.000001234",
    "1234567.0", "3.14159", "2.718281828459045", "6.02214076e23", "1.602176634e-19", "-1e300",
];

const TABLE_F32: &[&str] = &[
    "0", "-0", "1", "85", "100", "0.1", "0.3", "0.33333334", "0.212", "1.2931", "0.001", "16777216", "16777217",
    "1e-7", "1e-6", "9.999999e-7", "0.000001", "1e-5", "1e12", "9.999999e12", "1e13", "1.5e13", "123456789",
    "3.4028235e38", "1.17549435e-38", "1e-45", "1.4e-45", "-2.5e-10", "0.9", "0.95", "4.35", "525600",
];

fn zmij64(v: f64) -> String {
    serde_json::to_string(&v).unwrap()
}
fn zmij32(v: f32) -> String {
    serde_json::to_string(&v).unwrap()
}

fn esc(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

fn main() {
    let mut out = String::new();
    out.push_str("{\n  \"generator\": \"host/platform/serde-compat/tests/__fixtures__/rust-sampler (serde_json 1.0.149, zmij 1.0.21, ryu 1.0.23)\",\n");

    // 对照表：输入文本、位模式、serde_json 输出、ryu 输出。
    out.push_str("  \"tableF64\": [\n");
    let rows: Vec<String> = TABLE_F64
        .iter()
        .map(|text| {
            let v: f64 = text.parse().unwrap();
            format!(
                "    [{}, \"{:016x}\", {}, {}]",
                esc(text),
                v.to_bits(),
                esc(&zmij64(v)),
                esc(ryu::Buffer::new().format(v))
            )
        })
        .collect();
    out.push_str(&rows.join(",\n"));
    out.push_str("\n  ],\n  \"tableF32\": [\n");
    let rows: Vec<String> = TABLE_F32
        .iter()
        .map(|text| {
            let v: f32 = text.parse().unwrap();
            format!(
                "    [{}, \"{:08x}\", {}, {}]",
                esc(text),
                v.to_bits(),
                esc(&zmij32(v)),
                esc(ryu::Buffer::new().format(v))
            )
        })
        .collect();
    out.push_str(&rows.join(",\n"));

    // 随机与网格样例：[位模式, serde_json 输出]。
    let mut f64s: Vec<f64> = Vec::new();
    for k in -324..=308 {
        for m in ["1", "1.5", "9.99", "123456789", "2.2250738585"] {
            if let Ok(v) = format!("{m}e{k}").parse::<f64>() {
                if v.is_finite() {
                    f64s.push(v);
                }
            }
        }
    }
    let mut rng = XorShift(0x9e37_79b9_7f4a_7c15);
    let mut n = 0;
    while n < 800 {
        let v = f64::from_bits(rng.next());
        if v.is_finite() {
            f64s.push(v);
            n += 1;
        }
    }
    for _ in 0..500 {
        let mantissa = (rng.next() % 100_000_000) as f64;
        let exp = (rng.next() % 40) as i32 - 20;
        f64s.push(mantissa * 10f64.powi(exp));
        f64s.push(mantissa / 1000.0);
    }
    for k in 0..=64 {
        f64s.push(2f64.powi(k));
        f64s.push(-(2f64.powi(-k)));
    }
    out.push_str("\n  ],\n  \"f64\": [\n");
    let rows: Vec<String> = f64s.iter().map(|v| format!("    [\"{:016x}\", {}]", v.to_bits(), esc(&zmij64(*v)))).collect();
    out.push_str(&rows.join(",\n"));

    let mut f32s: Vec<f32> = Vec::new();
    for k in -45..=38 {
        for m in ["1", "1.5", "9.99", "1234567", "1.17549435"] {
            if let Ok(v) = format!("{m}e{k}").parse::<f32>() {
                if v.is_finite() {
                    f32s.push(v);
                }
            }
        }
    }
    let mut n = 0;
    while n < 800 {
        let v = f32::from_bits(rng.next() as u32);
        if v.is_finite() {
            f32s.push(v);
            n += 1;
        }
    }
    for _ in 0..400 {
        let mantissa = (rng.next() % 10_000_000) as f32;
        f32s.push(mantissa / 10_000.0);
        // 宿主里 f32 字段的值常是 JS double 经 `as f32` 窄化而来（例如 0.212 → 0.21199999749660492）。
        f32s.push(((rng.next() % 1_000_000) as f64 / 1e6) as f32);
    }
    out.push_str("\n  ],\n  \"f32\": [\n");
    let rows: Vec<String> = f32s.iter().map(|v| format!("    [\"{:08x}\", {}]", v.to_bits(), esc(&zmij32(*v)))).collect();
    out.push_str(&rows.join(",\n"));

    let snapshots = vec![
        FsrsStateBeforeSnapshot {
            snapshot_version: 1,
            card_state_id: "fsrs_state_1".into(),
            anki_card_id: "card_1".into(),
            deck_id: None,
            state: 0,
            stability: None,
            difficulty: None,
            elapsed_days: 0.0,
            scheduled_days: 0.0,
            reps: 0,
            lapses: 0,
            due_ms: 1_762_473_600_000,
            last_review_ms: None,
            suspended: false,
            fsrs_params_version: "fsrs-rs-v6".into(),
            desired_retention: None,
            leech: false,
            buried_until_ms: None,
            learning_step: 0,
        },
        FsrsStateBeforeSnapshot {
            snapshot_version: 1,
            card_state_id: "fsrs_state_2".into(),
            anki_card_id: "card_2".into(),
            deck_id: Some("default".into()),
            state: 2,
            stability: Some(92.0),
            difficulty: Some(5.0),
            elapsed_days: 3.0,
            scheduled_days: 92.0,
            reps: 7,
            lapses: 1,
            due_ms: 1_770_000_000_000,
            last_review_ms: Some(1_762_473_600_123),
            suspended: false,
            fsrs_params_version: "fsrs-rs-v6".into(),
            desired_retention: Some(0.9),
            leech: true,
            buried_until_ms: Some(1_762_560_000_000),
            learning_step: 2,
        },
        FsrsStateBeforeSnapshot {
            snapshot_version: 1,
            card_state_id: "fsrs_state_3".into(),
            anki_card_id: "card_\"3\"\u{2028}".into(),
            deck_id: Some("数学".into()),
            state: 1,
            stability: Some(0.212_345_678_901_234_56),
            difficulty: Some(6.8130_f64),
            elapsed_days: 0.000_011_574_074_074_074_073,
            scheduled_days: 1e-7,
            reps: 1,
            lapses: 0,
            due_ms: -1,
            last_review_ms: Some(0),
            suspended: true,
            fsrs_params_version: "fsrs-rs-v6".into(),
            desired_retention: Some(0.95),
            leech: false,
            buried_until_ms: None,
            learning_step: 4_294_967_295,
        },
        FsrsStateBeforeSnapshot {
            snapshot_version: 1,
            card_state_id: "fsrs_state_4".into(),
            anki_card_id: "card_4".into(),
            deck_id: None,
            state: 3,
            stability: Some(f64::NAN),
            difficulty: Some(f64::INFINITY),
            elapsed_days: 36500.0,
            scheduled_days: 1e16,
            reps: i32::MAX,
            lapses: i32::MIN,
            due_ms: i64::MAX,
            last_review_ms: Some(i64::MIN),
            suspended: false,
            fsrs_params_version: "".into(),
            desired_retention: Some(1.0),
            leech: false,
            buried_until_ms: None,
            learning_step: 0,
        },
    ];
    out.push_str("\n  ],\n  \"fsrsStateBeforeSnapshot\": [\n");
    let rows: Vec<String> = snapshots.iter().map(|s| format!("    {}", esc(&serde_json::to_string(s).unwrap()))).collect();
    out.push_str(&rows.join(",\n"));
    out.push_str("\n  ]\n}\n");
    print!("{out}");
}
