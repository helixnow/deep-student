//! Visual preprocess staging for text-model routes.
//!
//! Provides the per-stage/per-turn deadlines, the compile-strategy decision, and the
//! cancellable stage runner used for auxiliary-MM observation and OCR fallback.

pub(super) const AUXILIARY_MM_STAGE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30);
pub(super) const OCR_STAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
pub(super) const VISUAL_PREPROCESS_TURN_BUDGET: std::time::Duration =
    std::time::Duration::from_secs(75);
const UNAVAILABLE_IMAGE_OBSERVATION: &str =
    "[图片内容当前不可解析：没有健康的多模态辅助模型或 OCR 引擎。原图引用已保留，可在能力恢复后重试。]";

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PreprocessStageError<E> {
    Cancelled,
    TimedOut,
    Failed(E),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ContextImageCompileStrategy {
    NoImages,
    MultimodalDirect,
    TextModelPreprocess,
}

pub(super) fn context_image_compile_strategy(
    resolved_model_is_multimodal: bool,
    has_images: bool,
) -> ContextImageCompileStrategy {
    match (has_images, resolved_model_is_multimodal) {
        (false, _) => ContextImageCompileStrategy::NoImages,
        (true, true) => ContextImageCompileStrategy::MultimodalDirect,
        (true, false) => ContextImageCompileStrategy::TextModelPreprocess,
    }
}

pub(super) fn finalize_visual_observation(observation: Option<String>) -> (String, bool) {
    match observation {
        Some(observation) => (observation, true),
        None => (UNAVAILABLE_IMAGE_OBSERVATION.to_string(), false),
    }
}

pub(super) async fn run_preprocess_stage<T, E, F, Fut>(
    parent_cancellation: Option<&tokio_util::sync::CancellationToken>,
    turn_deadline: tokio::time::Instant,
    stage_timeout: std::time::Duration,
    operation: F,
) -> Result<T, PreprocessStageError<E>>
where
    F: FnOnce(tokio_util::sync::CancellationToken) -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let now = tokio::time::Instant::now();
    if now >= turn_deadline {
        return Err(PreprocessStageError::TimedOut);
    }
    let stage_deadline = std::cmp::min(turn_deadline, now + stage_timeout);
    let stage_cancellation = parent_cancellation
        .map(tokio_util::sync::CancellationToken::child_token)
        .unwrap_or_default();
    let cancellation_guard = stage_cancellation.clone().drop_guard();
    let future = operation(stage_cancellation.clone());
    let result = tokio::select! {
        biased;
        _ = stage_cancellation.cancelled() => Err(PreprocessStageError::Cancelled),
        result = tokio::time::timeout_at(stage_deadline, future) => match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(PreprocessStageError::Failed(error)),
            Err(_) => Err(PreprocessStageError::TimedOut),
        },
    };
    drop(cancellation_guard);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn unavailable_visual_placeholder_is_never_a_reusable_artifact() {
        let (placeholder, reusable) = finalize_visual_observation(None);
        assert_eq!(placeholder, UNAVAILABLE_IMAGE_OBSERVATION);
        assert!(!reusable);

        let (observation, reusable) =
            finalize_visual_observation(Some("actual observation".to_string()));
        assert_eq!(observation, "actual observation");
        assert!(reusable);
    }

    #[tokio::test]
    async fn auxiliary_timeout_advances_to_ocr_within_the_turn_budget() {
        let turn_deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(100);
        let auxiliary = run_preprocess_stage(
            None,
            turn_deadline,
            std::time::Duration::from_millis(5),
            |_| async { std::future::pending::<Result<&'static str, &'static str>>().await },
        )
        .await;
        assert_eq!(auxiliary, Err(PreprocessStageError::TimedOut));

        let ocr = run_preprocess_stage(
            None,
            turn_deadline,
            std::time::Duration::from_millis(50),
            |_| async { Ok::<_, &'static str>("recognized") },
        )
        .await;
        assert_eq!(ocr, Ok("recognized"));
    }

    #[tokio::test]
    async fn preprocessing_turn_budget_caps_a_long_stage_and_cancels_its_work() {
        let observed = Arc::new(AtomicBool::new(false));
        let observed_by_task = observed.clone();
        let result = run_preprocess_stage(
            None,
            tokio::time::Instant::now() + std::time::Duration::from_millis(5),
            std::time::Duration::from_secs(1),
            move |stage_cancellation| async move {
                tokio::spawn(async move {
                    stage_cancellation.cancelled().await;
                    observed_by_task.store(true, Ordering::SeqCst);
                });
                std::future::pending::<Result<(), &'static str>>().await
            },
        )
        .await;
        assert_eq!(result, Err(PreprocessStageError::TimedOut));
        tokio::time::timeout(std::time::Duration::from_millis(100), async {
            while !observed.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stage cancellation must reach spawned provider work");
    }

    #[tokio::test]
    async fn parent_cancellation_stops_preprocessing_before_fallback() {
        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        let operation_polled = Arc::new(AtomicBool::new(false));
        let operation_polled_by_future = operation_polled.clone();
        let result = run_preprocess_stage(
            Some(&cancellation),
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(1),
            move |_| async move {
                operation_polled_by_future.store(true, Ordering::SeqCst);
                Ok::<_, &'static str>(())
            },
        )
        .await;
        assert_eq!(result, Err(PreprocessStageError::Cancelled));
        assert!(!operation_polled.load(Ordering::SeqCst));
    }
}
