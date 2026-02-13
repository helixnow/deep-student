//! 工具性能基准测试

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use deep_student_lib::error_details::{infer_error_code_from_message, ErrorDetailsBuilder};
use deep_student_lib::tools::web_search::{ProviderStrategies, ProviderStrategy};

fn benchmark_error_details_creation(c: &mut Criterion) {
    c.bench_function("error_details_api_key_missing", |b| {
        b.iter(|| {
            let error = ErrorDetailsBuilder::api_key_missing(black_box("TestService"));
            black_box(error);
        })
    });

    c.bench_function("error_details_network_error", |b| {
        b.iter(|| {
            let error = ErrorDetailsBuilder::network_error(black_box("Connection timeout"));
            black_box(error);
        })
    });

    c.bench_function("infer_error_code_from_message", |b| {
        b.iter(|| {
            let code = infer_error_code_from_message(black_box("API key is missing or invalid"));
            black_box(code);
        })
    });
}

fn benchmark_provider_strategies(c: &mut Criterion) {
    let strategies = ProviderStrategies::default();

    c.bench_function("get_provider_strategy", |b| {
        b.iter(|| {
            let strategy = strategies.get_strategy(black_box("bing"));
            black_box(strategy);
        })
    });

    let strategy = ProviderStrategy::default();
    c.bench_function("calculate_retry_delay", |b| {
        b.iter(|| {
            let delay = strategy.calculate_retry_delay(black_box(3));
            black_box(delay);
        })
    });

    c.bench_function("should_retry_decision", |b| {
        b.iter(|| {
            let should_retry = strategy.should_retry(
                black_box(1),
                black_box(Some(500)),
                black_box("Internal Server Error"),
            );
            black_box(should_retry);
        })
    });
}

fn benchmark_json_operations(c: &mut Criterion) {
    let test_error = ErrorDetailsBuilder::rate_limit_error("TestService", Some(30));

    c.bench_function("serialize_error_details", |b| {
        b.iter(|| {
            let json_str = serde_json::to_string(black_box(&test_error)).unwrap();
            black_box(json_str);
        })
    });

    let json_str = serde_json::to_string(&test_error).unwrap();
    c.bench_function("deserialize_error_details", |b| {
        b.iter(|| {
            let error: deep_student_lib::error_details::ErrorDetails =
                serde_json::from_str(black_box(&json_str)).unwrap();
            black_box(error);
        })
    });
}

criterion_group!(
    benches,
    benchmark_error_details_creation,
    benchmark_provider_strategies,
    benchmark_json_operations
);
criterion_main!(benches);
