//! First job-bus test gate. Include from `ink_jobs.rs` after main verifies the DB RED.
//! These tests intentionally specify the typed identity contract without providing
//! a test-only bus implementation or changing the active Rust compile while main's
//! shared sync/backup/Ink batch is running.

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use crate::ink_jobs::{
        InkJobBusError, InkJobIdentity, InkJobKind, InkJobResponse, InkJobResponseValue,
        InkStagedPage, PendingInkJobBus,
    };

    fn identity(request_id: &str, kind: InkJobKind) -> InkJobIdentity {
        InkJobIdentity {
            request_id: request_id.to_owned(),
            operation_id: "op-parent-1".to_owned(),
            kind,
            session_id: Some("session-parent-1".to_owned()),
            tool_call_id: Some("call-parent-1".to_owned()),
        }
    }

    fn prepare_response(identity: &InkJobIdentity) -> InkJobResponse {
        InkJobResponse {
            request_id: identity.request_id.clone(),
            operation_id: identity.operation_id.clone(),
            kind: InkJobKind::Prepare,
            session_id: identity.session_id.clone(),
            tool_call_id: identity.tool_call_id.clone(),
            value: Some(InkJobResponseValue::Prepared {
                pages: vec![InkStagedPage {
                    staged_upload_id: "staged-page-1".to_owned(),
                    width_px: 64,
                    height_px: 48,
                    source_page_index: Some(0),
                }],
                converter_version: "test-converter-v1".to_owned(),
                warnings: Vec::new(),
            }),
            error: None,
        }
    }

    fn export_response(identity: &InkJobIdentity) -> InkJobResponse {
        InkJobResponse {
            request_id: identity.request_id.clone(),
            operation_id: identity.operation_id.clone(),
            kind: InkJobKind::Export,
            session_id: identity.session_id.clone(),
            tool_call_id: identity.tool_call_id.clone(),
            value: Some(InkJobResponseValue::Exported {
                staged_upload_id: "staged-export-1".to_owned(),
            }),
            error: None,
        }
    }

    #[tokio::test]
    async fn trusted_main_result_preserves_prepare_or_export_variant_and_parent_identity() {
        let bus = PendingInkJobBus::default();
        let prepare_identity = identity("request-prepare-1", InkJobKind::Prepare);
        let pending_prepare = bus.register(prepare_identity.clone()).unwrap();
        bus.complete_from_labels("main", Some("main"), prepare_response(&prepare_identity))
            .unwrap();
        assert!(matches!(
            pending_prepare
                .wait(Duration::from_secs(1), &CancellationToken::new())
                .await,
            Ok(InkJobResponseValue::Prepared { .. })
        ));

        let export_identity = identity("request-export-1", InkJobKind::Export);
        let pending_export = bus.register(export_identity.clone()).unwrap();
        bus.complete_from_labels("main", Some("main"), export_response(&export_identity))
            .unwrap();
        assert!(matches!(
            pending_export
                .wait(Duration::from_secs(1), &CancellationToken::new())
                .await,
            Ok(InkJobResponseValue::Exported { .. })
        ));
    }

    #[tokio::test]
    async fn foreign_webview_cannot_consume_a_pending_prepare_result() {
        let bus = PendingInkJobBus::default();
        let expected = identity("request-trusted-1", InkJobKind::Prepare);
        let pending = bus.register(expected.clone()).unwrap();

        assert_eq!(
            bus.complete_from_labels("settings", Some("main"), prepare_response(&expected)),
            Err(InkJobBusError::ForeignWebview),
        );
        bus.complete_from_labels("main", Some("main"), prepare_response(&expected))
            .unwrap();
        assert!(matches!(
            pending
                .wait(Duration::from_secs(1), &CancellationToken::new())
                .await,
            Ok(InkJobResponseValue::Prepared { .. })
        ));
    }

    #[tokio::test]
    async fn mismatched_operation_kind_session_or_tool_call_does_not_consume_pending_result() {
        let bus = PendingInkJobBus::default();
        let expected = identity("request-parent-1", InkJobKind::Prepare);
        let pending = bus.register(expected.clone()).unwrap();
        let mut mismatched = prepare_response(&expected);
        mismatched.operation_id = "different-operation".to_owned();

        assert_eq!(
            bus.complete_from_labels("main", Some("main"), mismatched),
            Err(InkJobBusError::IdentityMismatch),
        );
        let mut wrong_kind = prepare_response(&expected);
        wrong_kind.kind = InkJobKind::Export;
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), wrong_kind),
            Err(InkJobBusError::IdentityMismatch),
        );
        let mut wrong_session = prepare_response(&expected);
        wrong_session.session_id = Some("foreign-session".to_owned());
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), wrong_session),
            Err(InkJobBusError::IdentityMismatch),
        );
        let mut wrong_tool_call = prepare_response(&expected);
        wrong_tool_call.tool_call_id = Some("foreign-call".to_owned());
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), wrong_tool_call),
            Err(InkJobBusError::IdentityMismatch),
        );
        bus.complete_from_labels("main", Some("main"), prepare_response(&expected))
            .unwrap();
        assert!(matches!(
            pending
                .wait(Duration::from_secs(1), &CancellationToken::new())
                .await,
            Ok(InkJobResponseValue::Prepared { .. })
        ));
    }

    #[tokio::test]
    async fn timeout_removes_pending_job_and_rejects_late_result() {
        let bus = PendingInkJobBus::default();
        let expected = identity("request-timeout-1", InkJobKind::Export);
        let pending = bus.register(expected.clone()).unwrap();

        assert_eq!(
            pending
                .wait(Duration::ZERO, &CancellationToken::new())
                .await,
            Err(InkJobBusError::Timeout),
        );
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), export_response(&expected)),
            Err(InkJobBusError::NotPending),
        );
    }

    #[tokio::test]
    async fn cancellation_removes_pending_job_and_rejects_late_result() {
        let bus = PendingInkJobBus::default();
        let expected = identity("request-cancel-1", InkJobKind::Prepare);
        let pending = bus.register(expected.clone()).unwrap();
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        assert_eq!(
            pending.wait(Duration::from_secs(30), &cancellation).await,
            Err(InkJobBusError::Cancelled),
        );
        assert_eq!(
            bus.complete_from_labels("main", Some("main"), prepare_response(&expected)),
            Err(InkJobBusError::NotPending),
        );
    }
}
