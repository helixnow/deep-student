//! Runtime adapter for capability-aware, multi-profile VFS retrieval.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use futures::future::join_all;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::llm_manager::{ApiConfig, ImagePayload, LLMManager};
use crate::multimodal::MultimodalInput;
use crate::vfs::repos::{embedding_dim_repo, VfsBlobRepo, VfsResourceRepo};
use crate::vfs::retrieval_planner::{
    fuse_route_results, normalize_route_family_weights, plan_derived_text_routes, plan_retrieval,
    CapabilitySnapshot, CapabilityState, FusedRetrievalResult, IndexProfileCapability,
    PlannedQueryDerivation, PlannedRetrievalRoute, ProfileCircuitBreaker, ProfileCircuitDecision,
    QueryDerivationKind, QueryDerivationProvenance, QueryModality, RetrievalHit, RetrievalIdentity,
    RetrievalPlan, RetrievalRouteFailure, RetrievalRouteKind, RetrievalRouteResult,
};
use crate::vfs::{VfsDatabase, VfsError, VfsLanceSearchResult, VfsLanceStore, VfsResult};

const ROUTE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_FTS_SCAN: usize = 1000;
const MAX_FTS_TERMS: usize = 12;
const MAX_FTS_TERM_CHARS: usize = 64;

static PROFILE_CIRCUITS: OnceLock<Mutex<HashMap<String, ProfileCircuitBreaker>>> = OnceLock::new();
static CIRCUIT_CLOCK: OnceLock<Instant> = OnceLock::new();

fn circuit_now_ms() -> u64 {
    CIRCUIT_CLOCK
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn profile_circuit_rejection(profile_id: &str) -> Option<String> {
    let now_ms = circuit_now_ms();
    let circuits = PROFILE_CIRCUITS.get_or_init(|| Mutex::new(HashMap::new()));
    let guard = circuits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get(profile_id)
        .and_then(|breaker| breaker.rejection_reason(now_ms))
}

fn acquire_profile_circuit(profile_id: &str) -> Result<(), String> {
    let now_ms = circuit_now_ms();
    let circuits = PROFILE_CIRCUITS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = circuits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard
        .entry(profile_id.to_string())
        .or_default()
        .decision(now_ms)
    {
        ProfileCircuitDecision::Allow | ProfileCircuitDecision::AllowHalfOpenProbe => Ok(()),
        ProfileCircuitDecision::RejectOpen { retry_after_ms } => Err(format!(
            "profile circuit open; route skipped; retry after {}ms",
            retry_after_ms
        )),
        ProfileCircuitDecision::RejectHalfOpen => {
            Err("profile circuit half-open probe already in flight; route skipped".to_string())
        }
    }
}

fn record_profile_circuit_success(profile_id: &str) {
    let circuits = PROFILE_CIRCUITS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = circuits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .entry(profile_id.to_string())
        .or_default()
        .record_success();
}

fn record_profile_circuit_failure(profile_id: &str) {
    let now_ms = circuit_now_ms();
    let circuits = PROFILE_CIRCUITS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = circuits
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .entry(profile_id.to_string())
        .or_default()
        .record_failure(now_ms);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedRetrievalRequest {
    pub query_text: Option<String>,
    pub query_image_base64: Option<String>,
    pub query_image_media_type: Option<String>,
    pub query_modality: QueryModality,
    pub top_k: usize,
    pub folder_ids: Option<Vec<String>>,
    pub resource_ids: Option<Vec<String>>,
    pub resource_types: Option<Vec<String>>,
}

impl UnifiedRetrievalRequest {
    pub fn text(query: impl Into<String>, top_k: usize) -> Self {
        Self {
            query_text: Some(query.into()),
            query_image_base64: None,
            query_image_media_type: None,
            query_modality: QueryModality::Text,
            top_k,
            folder_ids: None,
            resource_ids: None,
            resource_types: None,
        }
    }

    pub fn validate(&self) -> VfsResult<()> {
        let has_text = self
            .query_text
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        let has_image = self
            .query_image_base64
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        let valid = match self.query_modality {
            QueryModality::Text => has_text,
            QueryModality::Image => has_image,
            QueryModality::Mixed => has_text && has_image,
        };
        if valid {
            Ok(())
        } else {
            Err(VfsError::InvalidArgument {
                param: "query".to_string(),
                reason: format!(
                    "query payload does not match {:?} mode (text={}, image={})",
                    self.query_modality, has_text, has_image
                ),
            })
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedRetrievalResponse {
    pub capability_snapshot: CapabilitySnapshot,
    pub plan: RetrievalPlan,
    pub result: FusedRetrievalResult,
    #[serde(default)]
    pub query_derivations: Vec<QueryDerivationAttempt>,
}

/// One actual image-to-text attempt. Planned-but-skipped stages remain visible in
/// `RetrievalPlan::image_fallback_chain`; this list contains only work that actually ran.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDerivationAttempt {
    pub provenance: QueryDerivationProvenance,
    pub succeeded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derived_query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct ImageFallbackRuntime {
    observer_config_id: Option<String>,
}

pub struct VfsUnifiedRetriever {
    db: Arc<VfsDatabase>,
    lance_store: Arc<VfsLanceStore>,
    llm_manager: Arc<LLMManager>,
}

impl VfsUnifiedRetriever {
    pub fn new(
        db: Arc<VfsDatabase>,
        lance_store: Arc<VfsLanceStore>,
        llm_manager: Arc<LLMManager>,
    ) -> Self {
        Self {
            db,
            lance_store,
            llm_manager,
        }
    }

    pub async fn search(
        &self,
        request: UnifiedRetrievalRequest,
    ) -> VfsResult<UnifiedRetrievalResponse> {
        self.search_with_scope(request, false).await
    }

    /// Dedicated multimodal API scope: query every queryable ME profile while keeping
    /// ordinary text embedding and lexical hits out of the page/image DTO.
    pub async fn search_multimodal(
        &self,
        request: UnifiedRetrievalRequest,
    ) -> VfsResult<UnifiedRetrievalResponse> {
        self.search_with_scope(request, true).await
    }

    /// Inspect the current configured/runtime capability state without repairing Lance
    /// schemas or indexes. Search takes a separate repair-then-reread snapshot.
    pub async fn inspect_capabilities(&self) -> VfsResult<CapabilitySnapshot> {
        let (snapshot, _, _) = self.capability_snapshot_inner(false).await?;
        Ok(snapshot)
    }

    async fn search_with_scope(
        &self,
        request: UnifiedRetrievalRequest,
        multimodal_only: bool,
    ) -> VfsResult<UnifiedRetrievalResponse> {
        request.validate()?;
        let (snapshot, profiles, fallback_runtime) = self.capability_snapshot().await?;
        let mut skipped_circuit_failures =
            circuit_open_route_failures(&profiles, request.query_modality, multimodal_only);
        let mut plan = plan_retrieval(&snapshot, request.query_modality, &profiles, request.top_k);
        if multimodal_only {
            plan.routes.retain(|route| {
                matches!(
                    route.kind,
                    RetrievalRouteKind::MultimodalText | RetrievalRouteKind::MultimodalImage
                )
            });
        }

        // Image fallback is gated only by ME-image routes. Text-side TE/ME routes
        // still run concurrently, but a slow text provider must not delay visual
        // observation/OCR after every image-vector route has missed.
        let (mut route_results, pending_non_image_routes) = if request.query_modality.has_image() {
            let (image_routes, non_image_routes) =
                partition_image_fallback_gate_routes(plan.routes.clone());
            let pending = if non_image_routes.is_empty() {
                None
            } else {
                let routes_for_failure = non_image_routes.clone();
                let retriever = Self::new(
                    Arc::clone(&self.db),
                    Arc::clone(&self.lance_store),
                    Arc::clone(&self.llm_manager),
                );
                let non_image_request = request.clone();
                let task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
                    retriever
                        .execute_routes(non_image_request, non_image_routes)
                        .await
                }));
                Some((routes_for_failure, task))
            };
            (
                self.execute_routes(request.clone(), image_routes).await,
                pending,
            )
        } else {
            (
                self.execute_routes(request.clone(), plan.routes.clone())
                    .await,
                None,
            )
        };
        let needs_image_fallback = request.query_modality.has_image()
            && !image_embedding_has_candidate_coverage(&route_results);
        let mut query_derivations = Vec::new();

        if needs_image_fallback {
            let (derived, derivation_failures, attempts) = self
                .derive_image_query(&request, &plan.image_fallback_chain, &fallback_runtime)
                .await;
            route_results.extend(derivation_failures.into_iter().map(Err));
            query_derivations = attempts;

            if let Some((image_text, provenance)) = derived {
                let mut derived_request = request.clone();
                derived_request.query_text = Some(combine_text_and_image_query(
                    request.query_text.as_deref(),
                    &image_text,
                ));
                derived_request.query_modality = QueryModality::Text;
                derived_request.query_image_base64 = None;
                derived_request.query_image_media_type = None;

                // A dedicated multimodal search remains ME-only for ordinary text queries.
                // Image/mixed queries may append only derived FTS/TE routes after every ME
                // image route missed, which is the explicit degraded contract for this scope.
                let derived_routes =
                    plan_derived_text_routes(&snapshot, &profiles, plan.top_k, provenance.clone());
                skipped_circuit_failures
                    .extend(derived_circuit_open_failures(&profiles, &provenance));
                plan.routes.extend(derived_routes.iter().cloned());
                let derived_results = self.execute_routes(derived_request, derived_routes).await;
                route_results.extend(derived_results);
            } else if query_derivations.is_empty() {
                route_results.push(Err(RetrievalRouteFailure {
                    route_id: "query_derivation:image_semantics_unavailable".to_string(),
                    profile_id: None,
                    dimension: None,
                    error: plan
                        .image_fallback_unavailable_reason
                        .clone()
                        .unwrap_or_else(|| {
                            "image embedding produced no candidates and no image-to-text fallback succeeded"
                                .to_string()
                        }),
                    timed_out: false,
                    query_derivation: None,
                }));
            }
        }

        if let Some((routes, task)) = pending_non_image_routes {
            match task.await {
                Ok(results) => route_results.extend(results),
                Err(error) => {
                    let error = format!("route batch task failed: {error}");
                    route_results.extend(routes.into_iter().map(|route| {
                        Err(RetrievalRouteFailure {
                            route_id: route.route_id,
                            profile_id: route.profile_id,
                            dimension: route.dimension,
                            error: error.clone(),
                            timed_out: false,
                            query_derivation: route.query_derivation,
                        })
                    }));
                }
            }
        }

        normalize_route_family_weights(&mut plan.routes);
        apply_plan_route_weights(&mut route_results, &plan.routes);
        let mut result = fuse_route_results(route_results, plan.top_k);
        if multimodal_only {
            result.hits.retain(is_multimodal_scope_hit);
        }
        result.failures.splice(0..0, skipped_circuit_failures);
        Ok(UnifiedRetrievalResponse {
            capability_snapshot: snapshot,
            plan,
            result,
            query_derivations,
        })
    }

    async fn execute_routes(
        &self,
        request: UnifiedRetrievalRequest,
        routes: Vec<PlannedRetrievalRoute>,
    ) -> Vec<Result<RetrievalRouteResult, RetrievalRouteFailure>> {
        let route_futures = routes.into_iter().map(|route| {
            let db = Arc::clone(&self.db);
            let lance_store = Arc::clone(&self.lance_store);
            let llm_manager = Arc::clone(&self.llm_manager);
            let request = request.clone();
            async move {
                if let Some(profile_id) = route.profile_id.as_deref() {
                    if let Err(error) = acquire_profile_circuit(profile_id) {
                        return Err(RetrievalRouteFailure {
                            route_id: route.route_id.clone(),
                            profile_id: route.profile_id.clone(),
                            dimension: route.dimension,
                            error,
                            timed_out: false,
                            query_derivation: route.query_derivation.clone(),
                        });
                    }
                }
                let outcome = match tokio::time::timeout(
                    ROUTE_TIMEOUT,
                    Self::execute_route(db, lance_store, llm_manager, request, route.clone()),
                )
                .await
                {
                    Ok(result) => result.map_err(|error| RetrievalRouteFailure {
                        route_id: route.route_id.clone(),
                        profile_id: route.profile_id.clone(),
                        dimension: route.dimension,
                        error: error.to_string(),
                        timed_out: false,
                        query_derivation: route.query_derivation.clone(),
                    }),
                    Err(_) => Err(RetrievalRouteFailure {
                        route_id: route.route_id.clone(),
                        profile_id: route.profile_id.clone(),
                        dimension: route.dimension,
                        error: format!("route timed out after {}s", ROUTE_TIMEOUT.as_secs()),
                        timed_out: true,
                        query_derivation: route.query_derivation.clone(),
                    }),
                };
                if let Some(profile_id) = route.profile_id.as_deref() {
                    if outcome.is_ok() {
                        record_profile_circuit_success(profile_id);
                    } else {
                        record_profile_circuit_failure(profile_id);
                    }
                }
                outcome
            }
        });
        join_all(route_futures).await
    }

    async fn capability_snapshot(
        &self,
    ) -> VfsResult<(
        CapabilitySnapshot,
        Vec<IndexProfileCapability>,
        ImageFallbackRuntime,
    )> {
        self.capability_snapshot_inner(true).await
    }

    async fn capability_snapshot_inner(
        &self,
        repair_profiles: bool,
    ) -> VfsResult<(
        CapabilitySnapshot,
        Vec<IndexProfileCapability>,
        ImageFallbackRuntime,
    )> {
        if repair_profiles {
            let initial_profiles = {
                let conn = self.db.get_conn_safe()?;
                embedding_dim_repo::list_active_profiles(&conn, None)?
            };
            // Search is the self-healing boundary. Inspect callers never enter this block.
            let repairs = initial_profiles.iter().map(|profile| async {
                let result = tokio::time::timeout(
                    ROUTE_TIMEOUT,
                    self.lance_store.ensure_profile_ready(&profile.id),
                )
                .await;
                (profile.id.as_str(), result)
            });
            for (profile_id, result) in join_all(repairs).await {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => log::warn!(
                        "[VfsUnifiedRetriever] profile readiness repair failed for {}: {}",
                        profile_id,
                        error
                    ),
                    Err(_) => log::warn!(
                        "[VfsUnifiedRetriever] profile readiness repair timed out for {}",
                        profile_id
                    ),
                }
            }
        }
        let active_profiles = {
            let conn = self.db.get_conn_safe()?;
            embedding_dim_repo::list_active_profiles(&conn, None)?
        };
        let configured_model_list = self.llm_manager.get_api_configs().await.unwrap_or_default();
        let configured_models: HashMap<String, ApiConfig> = configured_model_list
            .iter()
            .cloned()
            .map(|config| (config.id.clone(), config))
            .collect();
        let structured_ocr_configs = self
            .llm_manager
            .get_ocr_configs_by_priority(crate::ocr_adapters::OcrTaskType::Structured)
            .await
            .unwrap_or_default();
        let free_text_ocr_candidates = self
            .llm_manager
            .get_free_text_ocr_candidates_by_priority()
            .await
            .unwrap_or_default();
        let dedicated_ocr_available = has_dedicated_ocr_capability(
            free_text_ocr_candidates
                .iter()
                .map(|candidate| candidate.engine_type()),
        );
        let dedicated_ocr_config_ids = dedicated_ocr_config_ids(&free_text_ocr_candidates);
        let observer = select_multimodal_observer(
            &configured_model_list,
            &structured_ocr_configs,
            &dedicated_ocr_config_ids,
        );

        let mut profiles = Vec::with_capacity(active_profiles.len());
        for profile in active_profiles {
            let circuit_open = profile_circuit_rejection(&profile.id).is_some();
            profiles.push(index_profile_capability(
                profile,
                &configured_models,
                circuit_open,
            ));
        }

        let text_embedding = aggregate_embedding_capability(&profiles, "text");
        let multimodal_embedding = aggregate_embedding_capability(&profiles, "multimodal");
        let text_model = generation_capability(
            configured_model_list
                .iter()
                .any(|config| is_general_text_generation_config(config, &dedicated_ocr_config_ids)),
            "no enabled pure-text generation model",
        );
        let multimodal_model = generation_capability(
            observer.is_some(),
            "no enabled general-purpose multimodal generation model",
        );
        let ocr = generation_capability(dedicated_ocr_available, "no enabled OCR engine");
        Ok((
            CapabilitySnapshot {
                text_embedding,
                multimodal_embedding,
                text_model,
                multimodal_model,
                ocr,
            },
            profiles,
            ImageFallbackRuntime {
                observer_config_id: observer.map(|config| config.id.clone()),
            },
        ))
    }

    async fn derive_image_query(
        &self,
        request: &UnifiedRetrievalRequest,
        stages: &[PlannedQueryDerivation],
        runtime: &ImageFallbackRuntime,
    ) -> (
        Option<(String, QueryDerivationProvenance)>,
        Vec<RetrievalRouteFailure>,
        Vec<QueryDerivationAttempt>,
    ) {
        let mut failures = Vec::new();
        let mut attempts = Vec::new();

        for stage in stages {
            match stage.kind {
                QueryDerivationKind::MultimodalObservation => {
                    let Some(config_id) = runtime.observer_config_id.as_deref() else {
                        continue;
                    };
                    let provenance = QueryDerivationProvenance {
                        kind: QueryDerivationKind::MultimodalObservation,
                        model_config_id: Some(config_id.to_string()),
                    };
                    let started = Instant::now();
                    let payload = match image_payload_from_request(request) {
                        Ok(payload) => payload,
                        Err(error) => {
                            let error = error.to_string();
                            failures.push(query_derivation_failure(
                                &provenance,
                                error.clone(),
                                false,
                            ));
                            attempts.push(QueryDerivationAttempt {
                                provenance,
                                succeeded: false,
                                derived_query: None,
                                error: Some(error),
                                elapsed_ms: started.elapsed().as_millis() as u64,
                            });
                            continue;
                        }
                    };
                    let contextual_prompt = image_observation_prompt(request.query_text.as_deref());
                    let outcome = tokio::time::timeout(
                        ROUTE_TIMEOUT,
                        self.llm_manager.call_raw_prompt_with_config_id_and_images(
                            config_id,
                            &contextual_prompt,
                            vec![payload],
                            crate::llm_usage::CallerType::Other(
                                "vfs_retrieval_query_derivation".to_string(),
                            ),
                        ),
                    )
                    .await;
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    match outcome {
                        Ok(Ok(output)) if !output.assistant_message.trim().is_empty() => {
                            let derived_query = output.assistant_message.trim().to_string();
                            attempts.push(QueryDerivationAttempt {
                                provenance: provenance.clone(),
                                succeeded: true,
                                derived_query: Some(derived_query.clone()),
                                error: None,
                                elapsed_ms,
                            });
                            // A successful general MM observation is authoritative for this
                            // fallback. OCR must never run merely to augment it.
                            return (Some((derived_query, provenance)), failures, attempts);
                        }
                        Ok(Ok(_)) => {
                            let error =
                                "multimodal observation returned an empty query".to_string();
                            failures.push(query_derivation_failure(
                                &provenance,
                                error.clone(),
                                false,
                            ));
                            attempts.push(QueryDerivationAttempt {
                                provenance,
                                succeeded: false,
                                derived_query: None,
                                error: Some(error),
                                elapsed_ms,
                            });
                        }
                        Ok(Err(error)) => {
                            let error = error.to_string();
                            failures.push(query_derivation_failure(
                                &provenance,
                                error.clone(),
                                false,
                            ));
                            attempts.push(QueryDerivationAttempt {
                                provenance,
                                succeeded: false,
                                derived_query: None,
                                error: Some(error),
                                elapsed_ms,
                            });
                        }
                        Err(_) => {
                            let error = format!(
                                "multimodal query observation timed out after {}s",
                                ROUTE_TIMEOUT.as_secs()
                            );
                            failures.push(query_derivation_failure(
                                &provenance,
                                error.clone(),
                                true,
                            ));
                            attempts.push(QueryDerivationAttempt {
                                provenance,
                                succeeded: false,
                                derived_query: None,
                                error: Some(error),
                                elapsed_ms,
                            });
                        }
                    }
                }
                QueryDerivationKind::Ocr => {
                    let provenance = QueryDerivationProvenance {
                        kind: QueryDerivationKind::Ocr,
                        model_config_id: None,
                    };
                    let started = Instant::now();
                    let outcome =
                        tokio::time::timeout(ROUTE_TIMEOUT, self.ocr_image_query(request)).await;
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    match outcome {
                        Ok(Ok(text)) if !text.trim().is_empty() => {
                            let derived_query = text.trim().to_string();
                            attempts.push(QueryDerivationAttempt {
                                provenance: provenance.clone(),
                                succeeded: true,
                                derived_query: Some(derived_query.clone()),
                                error: None,
                                elapsed_ms,
                            });
                            return (Some((derived_query, provenance)), failures, attempts);
                        }
                        Ok(Ok(_)) => {
                            let error = "OCR returned no visible text; non-text image semantics remain unavailable"
                                .to_string();
                            failures.push(query_derivation_failure(
                                &provenance,
                                error.clone(),
                                false,
                            ));
                            attempts.push(QueryDerivationAttempt {
                                provenance,
                                succeeded: false,
                                derived_query: None,
                                error: Some(error),
                                elapsed_ms,
                            });
                        }
                        Ok(Err(error)) => {
                            failures.push(query_derivation_failure(
                                &provenance,
                                error.clone(),
                                false,
                            ));
                            attempts.push(QueryDerivationAttempt {
                                provenance,
                                succeeded: false,
                                derived_query: None,
                                error: Some(error),
                                elapsed_ms,
                            });
                        }
                        Err(_) => {
                            let error = format!(
                                "OCR query derivation timed out after {}s",
                                ROUTE_TIMEOUT.as_secs()
                            );
                            failures.push(query_derivation_failure(
                                &provenance,
                                error.clone(),
                                true,
                            ));
                            attempts.push(QueryDerivationAttempt {
                                provenance,
                                succeeded: false,
                                derived_query: None,
                                error: Some(error),
                                elapsed_ms,
                            });
                        }
                    }
                }
            }
        }

        (None, failures, attempts)
    }

    async fn ocr_image_query(&self, request: &UnifiedRetrievalRequest) -> Result<String, String> {
        let payload = image_payload_from_request(request).map_err(|error| error.to_string())?;
        let suffix = image_temp_suffix(&payload.mime);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&payload.base64)
            .map_err(|error| format!("invalid image base64 for OCR fallback: {}", error))?;
        let mut file = tempfile::Builder::new()
            .prefix("vfs-query-ocr-")
            .suffix(suffix)
            .tempfile()
            .map_err(|error| format!("failed to create OCR temporary file: {}", error))?;
        file.write_all(&bytes)
            .map_err(|error| format!("failed to write OCR temporary file: {}", error))?;
        let path = file
            .path()
            .to_str()
            .ok_or_else(|| "OCR temporary path is not UTF-8".to_string())?;
        let cancellation = tokio_util::sync::CancellationToken::new();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        self.llm_manager
            .call_dedicated_ocr_free_text_with_fallback(path, cancellation)
            .await
            .map_err(|error| error.to_string())
    }

    async fn execute_route(
        db: Arc<VfsDatabase>,
        lance_store: Arc<VfsLanceStore>,
        llm_manager: Arc<LLMManager>,
        request: UnifiedRetrievalRequest,
        route: PlannedRetrievalRoute,
    ) -> VfsResult<RetrievalRouteResult> {
        let started = Instant::now();
        let hits = match route.kind {
            RetrievalRouteKind::FullText => {
                let query = request
                    .query_text
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or_default();
                if query.is_empty() {
                    Vec::new()
                } else {
                    let db = Arc::clone(&db);
                    let query = query.to_string();
                    let request = request.clone();
                    let fetch_limit = route.fetch_limit;
                    tokio::task::spawn_blocking(move || {
                        Self::execute_fts_route(&db, &query, &request, fetch_limit)
                    })
                    .await
                    .map_err(|error| {
                        VfsError::Other(format!("lexical route task failed: {}", error))
                    })??
                }
            }
            RetrievalRouteKind::TextEmbedding => {
                let model_id = required_model_id(&route)?;
                let query = required_query_text(&request)?;
                let embedding = llm_manager
                    .call_embedding_api(vec![query.to_string()], model_id)
                    .await
                    .map_err(|error| VfsError::Other(error.to_string()))?
                    .into_iter()
                    .next()
                    .ok_or_else(|| VfsError::Other("文本嵌入 API 返回空结果".to_string()))?;
                validate_dimension(&route, &embedding)?;
                validate_route_runtime_fingerprint(&llm_manager, &route).await?;
                let rows = lance_store
                    .vector_search_profile_full(
                        required_profile_id(&route)?,
                        &embedding,
                        route.fetch_limit,
                        // Folder membership is canonical in SQLite and may have moved after
                        // the Lance row was written. Filter it after retrieval below.
                        None,
                        request.resource_ids.as_deref(),
                        request.resource_types.as_deref(),
                    )
                    .await?;
                Self::lance_rows_to_hits(&db, rows, &route, &request)?
            }
            RetrievalRouteKind::MultimodalText => {
                let input = MultimodalInput::text(required_query_text(&request)?);
                let embedding = llm_manager
                    .call_multimodal_embedding_api_for_model(&[input], required_model_id(&route)?)
                    .await
                    .map_err(|error| VfsError::Other(error.to_string()))?
                    .into_iter()
                    .next()
                    .ok_or_else(|| VfsError::Other("多模态文本嵌入 API 返回空结果".to_string()))?;
                validate_dimension(&route, &embedding)?;
                validate_route_runtime_fingerprint(&llm_manager, &route).await?;
                let rows = lance_store
                    .vector_search_profile_full(
                        required_profile_id(&route)?,
                        &embedding,
                        route.fetch_limit,
                        None,
                        request.resource_ids.as_deref(),
                        request.resource_types.as_deref(),
                    )
                    .await?;
                Self::lance_rows_to_hits(&db, rows, &route, &request)?
            }
            RetrievalRouteKind::MultimodalImage => {
                let image = request
                    .query_image_base64
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| VfsError::InvalidArgument {
                        param: "queryImageBase64".to_string(),
                        reason: "multimodal image route requires original image bytes".to_string(),
                    })?;
                let media_type = request
                    .query_image_media_type
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("image/png");
                let input = MultimodalInput::image_base64(image, media_type);
                let embedding = llm_manager
                    .call_multimodal_embedding_api_for_model(&[input], required_model_id(&route)?)
                    .await
                    .map_err(|error| VfsError::Other(error.to_string()))?
                    .into_iter()
                    .next()
                    .ok_or_else(|| VfsError::Other("多模态图片嵌入 API 返回空结果".to_string()))?;
                validate_dimension(&route, &embedding)?;
                validate_route_runtime_fingerprint(&llm_manager, &route).await?;
                let rows = lance_store
                    .vector_search_profile_full(
                        required_profile_id(&route)?,
                        &embedding,
                        route.fetch_limit,
                        None,
                        request.resource_ids.as_deref(),
                        request.resource_types.as_deref(),
                    )
                    .await?;
                Self::lance_rows_to_hits(&db, rows, &route, &request)?
            }
        };

        Ok(RetrievalRouteResult {
            route,
            hits,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// SQLite text-ledger retrieval. It never requests a query vector, so TE/ME failures
    /// cannot disable the lexical fallback.
    fn execute_fts_route(
        db: &VfsDatabase,
        query: &str,
        request: &UnifiedRetrievalRequest,
        fetch_limit: usize,
    ) -> VfsResult<Vec<RetrievalHit>> {
        let terms = extract_lexical_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let patterns = terms
            .iter()
            .map(|term| escaped_like_pattern(term))
            .collect::<Vec<_>>();
        let scan_limit = fetch_limit
            .saturating_mul(10)
            .clamp(fetch_limit, MAX_FTS_SCAN);
        let segment_match_count = lexical_match_count_sql("s.content_text", terms.len());
        let segment_match_any = lexical_match_any_sql("s.content_text", terms.len());
        let unit_match_count = lexical_match_count_sql("u.text_content", terms.len());
        let unit_match_any = lexical_match_any_sql("u.text_content", terms.len());
        let limit_parameter = terms.len() + 2;
        let sql = format!(
            "SELECT embedding_id, resource_id, chunk_index, unit_index, content_text,
                    metadata_json, image_blob_hash
             FROM (
                 SELECT s.lance_row_id AS embedding_id, u.resource_id AS resource_id,
                        s.segment_index AS chunk_index, u.unit_index AS unit_index,
                        COALESCE(s.content_text, '') AS content_text,
                        s.metadata_json AS metadata_json,
                        u.image_blob_hash AS image_blob_hash,
                        CASE WHEN s.content_text = ?1 THEN 0 ELSE 1 END AS exact_rank,
                        {segment_match_count} AS match_count,
                        0 AS source_rank, s.updated_at AS rank_updated
                 FROM vfs_index_segments s
                 JOIN vfs_index_units u ON u.id = s.unit_id
                 LEFT JOIN resources r ON r.id = u.resource_id
                 WHERE s.modality = 'text'
                   AND ({segment_match_any})
                   AND (r.id IS NULL OR (r.deleted_at IS NULL
                        AND COALESCE(r.index_state, 'pending') <> 'disabled'))
                   AND (
                        s.index_profile_id IS NULL OR (
                            u.text_profile_id = s.index_profile_id
                            AND u.text_generation = s.generation
                            AND EXISTS (
                                SELECT 1 FROM vfs_index_profiles p
                                WHERE p.id = s.index_profile_id
                                  AND p.state IN ('active', 'building', 'queryable')
                            )
                        )
                   )
                 UNION ALL
                 SELECT 'unit:' || u.id AS embedding_id, u.resource_id AS resource_id,
                        0 AS chunk_index, u.unit_index AS unit_index,
                        COALESCE(u.text_content, '') AS content_text,
                        NULL AS metadata_json, u.image_blob_hash AS image_blob_hash,
                        CASE WHEN u.text_content = ?1 THEN 0 ELSE 1 END AS exact_rank,
                        {unit_match_count} AS match_count,
                        1 AS source_rank, u.updated_at AS rank_updated
                 FROM vfs_index_units u
                 LEFT JOIN resources r ON r.id = u.resource_id
                 WHERE ({unit_match_any})
                   AND (r.id IS NULL OR (r.deleted_at IS NULL
                        AND COALESCE(r.index_state, 'pending') <> 'disabled'))
             ) lexical
             ORDER BY exact_rank, match_count DESC, source_rank, rank_updated DESC, embedding_id
             LIMIT ?{limit_parameter}"
        );
        let mut parameters = Vec::with_capacity(patterns.len() + 2);
        parameters.push(SqlValue::Text(query.to_string()));
        parameters.extend(patterns.into_iter().map(SqlValue::Text));
        parameters.push(SqlValue::Integer(scan_limit as i64));
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(parameters.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        drop(conn);

        let resource_filter = request
            .resource_ids
            .as_ref()
            .map(|values| values.iter().map(String::as_str).collect::<HashSet<_>>());
        let type_filter = request
            .resource_types
            .as_ref()
            .map(|values| values.iter().map(String::as_str).collect::<HashSet<_>>());
        let folder_filter = request
            .folder_ids
            .as_ref()
            .map(|values| values.iter().map(String::as_str).collect::<HashSet<_>>());
        let mut hits = Vec::new();
        let mut seen = HashSet::new();
        for (embedding_id, resource_id, chunk_index, unit_index, text, metadata, blob_hash) in rows
        {
            if resource_filter
                .as_ref()
                .is_some_and(|filter| !filter.contains(resource_id.as_str()))
            {
                continue;
            }
            let Some(resource) = VfsResourceRepo::get_resource(db, &resource_id)? else {
                continue;
            };
            let resource_type = resource.resource_type.to_string();
            if type_filter
                .as_ref()
                .is_some_and(|filter| !filter.contains(resource_type.as_str()))
            {
                continue;
            }
            let folder_id = resource_folder_id(db, &resource_id, resource.source_id.as_deref())?;
            if folder_filter.as_ref().is_some_and(|filter| {
                !folder_id
                    .as_deref()
                    .is_some_and(|folder| filter.contains(folder))
            }) {
                continue;
            }
            let title = resource
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.title.clone().or_else(|| metadata.name.clone()));
            let metadata_value = metadata
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok())
                .unwrap_or(Value::Null);
            let image_url = blob_hash.as_deref().and_then(|hash| {
                VfsBlobRepo::get_blob_path(db, hash)
                    .ok()
                    .flatten()
                    .map(|path| path.to_string_lossy().to_string())
            });
            let identity = RetrievalIdentity {
                resource_id: resource_id.clone(),
                chunk_index,
                page_index: Some(unit_index),
            };
            if !seen.insert(identity.clone()) {
                continue;
            }
            hits.push(RetrievalHit {
                identity,
                embedding_id,
                text,
                title,
                resource_type: Some(resource_type),
                source_id: resource.source_id,
                folder_id,
                blob_hash,
                image_url,
                raw_score: None,
                metadata: metadata_value,
            });
            if hits.len() >= fetch_limit {
                break;
            }
        }
        Ok(hits)
    }

    fn lance_rows_to_hits(
        db: &VfsDatabase,
        rows: Vec<VfsLanceSearchResult>,
        route: &PlannedRetrievalRoute,
        request: &UnifiedRetrievalRequest,
    ) -> VfsResult<Vec<RetrievalHit>> {
        let active_ids = active_segment_row_ids(db, &rows, route)?;
        let folder_filter = request
            .folder_ids
            .as_ref()
            .map(|values| values.iter().map(String::as_str).collect::<HashSet<_>>());
        let type_filter = request
            .resource_types
            .as_ref()
            .map(|values| values.iter().map(String::as_str).collect::<HashSet<_>>());
        let mut hits = Vec::new();
        for row in rows
            .into_iter()
            .filter(|row| active_ids.contains(&row.embedding_id))
        {
            let Some(resource) = VfsResourceRepo::get_resource(db, &row.resource_id)? else {
                continue;
            };
            let resource_type = resource.resource_type.to_string();
            if type_filter
                .as_ref()
                .is_some_and(|filter| !filter.contains(resource_type.as_str()))
            {
                continue;
            }
            let canonical_folder =
                resource_folder_id(db, &row.resource_id, resource.source_id.as_deref())?;
            if folder_filter.as_ref().is_some_and(|filter| {
                !canonical_folder
                    .as_deref()
                    .is_some_and(|folder| filter.contains(folder))
            }) {
                continue;
            }
            let metadata = row
                .metadata_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .unwrap_or(Value::Null);
            let page_index = row.page_index.or_else(|| {
                metadata
                    .get("page_index")
                    .and_then(Value::as_i64)
                    .and_then(|value| i32::try_from(value).ok())
            });
            let blob_hash = metadata
                .get("blob_hash")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            let image_url = blob_hash.as_deref().and_then(|hash| {
                VfsBlobRepo::get_blob_path(db, hash)
                    .ok()
                    .flatten()
                    .map(|path| path.to_string_lossy().to_string())
            });
            let title = resource
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.title.clone().or_else(|| metadata.name.clone()));
            let source_id = row.source_id.or(resource.source_id);
            hits.push(RetrievalHit {
                identity: RetrievalIdentity {
                    resource_id: row.resource_id.clone(),
                    chunk_index: row.chunk_index,
                    page_index,
                },
                embedding_id: row.embedding_id,
                text: row.text,
                title,
                resource_type: Some(resource_type),
                source_id,
                folder_id: canonical_folder,
                blob_hash,
                image_url,
                raw_score: Some(row.score as f64),
                metadata,
            });
        }
        Ok(hits)
    }
}

fn extract_lexical_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    let mut remaining_lines = Vec::new();

    // The MM observation prompt asks for an explicit final keyword line. Consume those
    // terms first so prose cannot exhaust the bounded SQL parameter budget.
    for line in query.lines() {
        if let Some(payload) = lexical_keyword_payload(line) {
            for candidate in payload.split(|character: char| {
                character.is_whitespace()
                    || matches!(character, ',' | '，' | ';' | '；' | '、' | '|')
            }) {
                push_lexical_term(candidate, &mut terms, &mut seen);
                if terms.len() == MAX_FTS_TERMS {
                    return terms;
                }
            }
        } else {
            remaining_lines.push(line);
        }
    }

    for line in remaining_lines {
        for candidate in line.split(|character: char| !character.is_alphanumeric()) {
            push_lexical_term(candidate, &mut terms, &mut seen);
            if terms.len() == MAX_FTS_TERMS {
                return terms;
            }
        }
    }
    terms
}

fn lexical_keyword_payload(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let (label, payload) = trimmed
        .split_once('：')
        .or_else(|| trimmed.split_once(':'))?;
    let normalized = label.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "关键词"
            | "关键字"
            | "检索关键词"
            | "检索关键字"
            | "keyword"
            | "keywords"
            | "search keywords"
    )
    .then_some(payload)
}

fn push_lexical_term(candidate: &str, terms: &mut Vec<String>, seen: &mut HashSet<String>) {
    let candidate = candidate.trim().trim_matches(|character: char| {
        !character.is_alphanumeric() && !matches!(character, '%' | '_' | '\\' | '-')
    });
    let character_count = candidate.chars().count();
    if character_count < 2 {
        return;
    }
    let bounded = if character_count > MAX_FTS_TERM_CHARS {
        candidate.chars().take(MAX_FTS_TERM_CHARS).collect()
    } else {
        candidate.to_string()
    };
    if seen.insert(bounded.to_lowercase()) {
        terms.push(bounded);
    }
}

fn escaped_like_pattern(term: &str) -> String {
    format!(
        "%{}%",
        term.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn lexical_match_any_sql(column: &str, term_count: usize) -> String {
    (0..term_count)
        .map(|offset| format!("{column} LIKE ?{} ESCAPE '\\'", offset + 2))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn lexical_match_count_sql(column: &str, term_count: usize) -> String {
    (0..term_count)
        .map(|offset| {
            format!(
                "CASE WHEN {column} LIKE ?{} ESCAPE '\\' THEN 1 ELSE 0 END",
                offset + 2
            )
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

fn is_multimodal_scope_hit(hit: &crate::vfs::retrieval_planner::FusedRetrievalHit) -> bool {
    hit.hit
        .blob_hash
        .as_deref()
        .is_some_and(|value| !value.is_empty())
        || hit
            .hit
            .image_url
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || hit.provenance.iter().any(|provenance| {
            matches!(
                provenance.route_kind,
                RetrievalRouteKind::MultimodalText | RetrievalRouteKind::MultimodalImage
            )
        })
}

fn valid_generation_config(config: &ApiConfig) -> bool {
    config.enabled && !config.is_embedding && !config.is_reranker && !config.is_image_generation
}

fn is_general_text_generation_config(
    config: &ApiConfig,
    dedicated_ocr_config_ids: &HashSet<String>,
) -> bool {
    valid_generation_config(config)
        && !config.is_multimodal
        && !dedicated_ocr_config_ids.contains(&config.id)
}

fn generation_capability(available: bool, unavailable_reason: &str) -> CapabilityState {
    if available {
        CapabilityState::available()
    } else {
        CapabilityState {
            reason: Some(unavailable_reason.to_string()),
            ..CapabilityState::unavailable()
        }
    }
}

fn has_dedicated_ocr_capability(
    engine_types: impl IntoIterator<Item = crate::ocr_adapters::OcrEngineType>,
) -> bool {
    engine_types
        .into_iter()
        .any(|engine| engine.is_dedicated_ocr())
}

fn dedicated_ocr_config_ids(
    candidates: &[crate::llm_manager::OcrRuntimeCandidate],
) -> HashSet<String> {
    candidates
        .iter()
        .filter_map(|candidate| match candidate {
            crate::llm_manager::OcrRuntimeCandidate::Remote {
                config,
                engine_type,
            } if engine_type.is_dedicated_ocr() => Some(config.id.clone()),
            crate::llm_manager::OcrRuntimeCandidate::Remote { .. }
            | crate::llm_manager::OcrRuntimeCandidate::SystemOcr => None,
        })
        .collect()
}

fn select_multimodal_observer<'a>(
    configs: &'a [ApiConfig],
    prioritized_ocr_configs: &[(ApiConfig, crate::ocr_adapters::OcrEngineType)],
    dedicated_ocr_config_ids: &HashSet<String>,
) -> Option<&'a ApiConfig> {
    let priority_by_id: HashMap<&str, usize> = prioritized_ocr_configs
        .iter()
        .enumerate()
        .filter(|(_, (_, engine))| !engine.is_dedicated_ocr())
        .map(|(rank, (config, _))| (config.id.as_str(), rank))
        .collect();
    let mut candidates = configs
        .iter()
        .filter(|config| {
            valid_generation_config(config)
                && config.is_multimodal
                && !dedicated_ocr_config_ids.contains(&config.id)
                && !crate::ocr_adapters::OcrAdapterFactory::infer_engine_from_model(&config.model)
                    .is_dedicated_ocr()
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        priority_by_id
            .get(left.id.as_str())
            .copied()
            .unwrap_or(usize::MAX)
            .cmp(
                &priority_by_id
                    .get(right.id.as_str())
                    .copied()
                    .unwrap_or(usize::MAX),
            )
            .then_with(|| left.id.cmp(&right.id))
    });
    candidates.into_iter().next()
}

fn image_embedding_has_candidate_coverage(
    results: &[Result<RetrievalRouteResult, RetrievalRouteFailure>],
) -> bool {
    results.iter().any(|result| {
        result.as_ref().is_ok_and(|result| {
            result.route.kind == RetrievalRouteKind::MultimodalImage && !result.hits.is_empty()
        })
    })
}

fn partition_image_fallback_gate_routes(
    routes: Vec<PlannedRetrievalRoute>,
) -> (Vec<PlannedRetrievalRoute>, Vec<PlannedRetrievalRoute>) {
    routes
        .into_iter()
        .partition(|route| route.kind == RetrievalRouteKind::MultimodalImage)
}

fn apply_plan_route_weights(
    results: &mut [Result<RetrievalRouteResult, RetrievalRouteFailure>],
    routes: &[PlannedRetrievalRoute],
) {
    let weights = routes
        .iter()
        .map(|route| (route.route_id.as_str(), route.weight))
        .collect::<HashMap<_, _>>();
    for result in results.iter_mut().filter_map(|result| result.as_mut().ok()) {
        if let Some(weight) = weights.get(result.route.route_id.as_str()) {
            result.route.weight = *weight;
        }
    }
}

fn combine_text_and_image_query(original_text: Option<&str>, image_text: &str) -> String {
    let original_text = original_text.map(str::trim).filter(|text| !text.is_empty());
    match original_text {
        Some(text) => format!("{}\n\n[image semantics]\n{}", text, image_text.trim()),
        None => image_text.trim().to_string(),
    }
}

fn image_observation_prompt(original_text: Option<&str>) -> String {
    let context = original_text
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| format!("\n用户同时提供的文本查询：{}", text))
        .unwrap_or_default();
    format!(
        "请直接观察原图，为知识库检索生成忠实、紧凑的文本查询。保留可见文字、主体、场景、结构、图表关系和关键属性；不要回答问题，不要臆测。最后另起一行给出 3 到 12 个用空格分隔的检索关键词。{}",
        context
    )
}

fn image_payload_from_request(request: &UnifiedRetrievalRequest) -> VfsResult<ImagePayload> {
    let raw = request
        .query_image_base64
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| VfsError::InvalidArgument {
            param: "queryImageBase64".to_string(),
            reason: "image query fallback requires original image bytes".to_string(),
        })?;
    let (mime_from_data_url, base64) = if let Some(data_url) = raw.strip_prefix("data:") {
        let (metadata, payload) =
            data_url
                .split_once(',')
                .ok_or_else(|| VfsError::InvalidArgument {
                    param: "queryImageBase64".to_string(),
                    reason: "invalid image data URL".to_string(),
                })?;
        if !metadata.ends_with(";base64") {
            return Err(VfsError::InvalidArgument {
                param: "queryImageBase64".to_string(),
                reason: "image data URL must use base64 encoding".to_string(),
            });
        }
        (
            metadata.strip_suffix(";base64").map(str::to_string),
            payload,
        )
    } else {
        (None, raw)
    };
    base64::engine::general_purpose::STANDARD
        .decode(base64)
        .map_err(|error| VfsError::InvalidArgument {
            param: "queryImageBase64".to_string(),
            reason: format!("invalid image base64: {}", error),
        })?;
    let mime = request
        .query_image_media_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(mime_from_data_url)
        .unwrap_or_else(|| "image/png".to_string());
    Ok(ImagePayload {
        mime,
        base64: base64.to_string(),
    })
}

fn image_temp_suffix(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/bmp" => ".bmp",
        "image/heic" => ".heic",
        "image/heif" => ".heif",
        _ => ".jpg",
    }
}

fn query_derivation_failure(
    provenance: &QueryDerivationProvenance,
    error: String,
    timed_out: bool,
) -> RetrievalRouteFailure {
    let stage = match provenance.kind {
        QueryDerivationKind::MultimodalObservation => "mm_observation",
        QueryDerivationKind::Ocr => "ocr",
    };
    let producer = provenance
        .model_config_id
        .as_deref()
        .unwrap_or("engine_chain");
    RetrievalRouteFailure {
        route_id: format!("query_derivation:{}:{}", stage, producer),
        profile_id: None,
        dimension: None,
        error,
        timed_out,
        query_derivation: Some(provenance.clone()),
    }
}

fn derived_circuit_open_failures(
    profiles: &[IndexProfileCapability],
    provenance: &QueryDerivationProvenance,
) -> Vec<RetrievalRouteFailure> {
    let suffix = match provenance.kind {
        QueryDerivationKind::MultimodalObservation => "mm_observation",
        QueryDerivationKind::Ocr => "ocr",
    };
    circuit_open_route_failures(profiles, QueryModality::Text, false)
        .into_iter()
        .filter(|failure| {
            failure.profile_id.as_deref().is_some_and(|profile_id| {
                profiles.iter().any(|profile| {
                    profile.profile_id == profile_id
                        && profile.modality == "text"
                        && profile.embedding_protocol == "text-embedding-v1"
                })
            })
        })
        .map(|mut failure| {
            failure.route_id = format!("derived_{}:{}", suffix, failure.route_id);
            failure.query_derivation = Some(provenance.clone());
            failure
        })
        .collect()
}

fn index_profile_capability(
    profile: embedding_dim_repo::VfsIndexProfile,
    configured_models: &HashMap<String, ApiConfig>,
    circuit_open: bool,
) -> IndexProfileCapability {
    let expected_protocol =
        embedding_dim_repo::embedding_protocol_for_modality(&profile.modality).ok();
    let protocol_compatible = expected_protocol == Some(profile.embedding_protocol.as_str());
    let physical_index_compatible = is_profile_index_compatible(
        &profile.ann_metric,
        profile.ann_index_version,
        profile.schema_version,
    );
    let dimension_compatible = (embedding_dim_repo::MIN_DIMENSION
        ..=embedding_dim_repo::MAX_DIMENSION)
        .contains(&profile.dimension);
    let model_config = profile
        .model_config_id
        .as_ref()
        .and_then(|id| configured_models.get(id));
    let runtime_model_fingerprint = model_config.and_then(|config| {
        embedding_dim_repo::model_fingerprint_for_config(config, &profile.modality).ok()
    });
    let fingerprint_compatible = model_config.is_some_and(|config| {
        profile_fingerprint_compatible(
            &profile,
            config,
            protocol_compatible,
            dimension_compatible,
            physical_index_compatible,
        )
    });
    let model_healthy = model_config.is_some_and(|config| {
        config.enabled
            && config.is_embedding
            && !config.is_reranker
            && if matches!(profile.modality.as_str(), "multimodal" | "image") {
                config.is_multimodal
            } else {
                !config.is_multimodal
            }
    }) && fingerprint_compatible;

    IndexProfileCapability {
        profile_id: profile.id,
        dimension: profile.dimension.max(0) as usize,
        modality: profile.modality,
        embedding_protocol: profile.embedding_protocol,
        model_config_id: profile.model_config_id,
        runtime_model_fingerprint,
        configured: model_config.is_some(),
        active: matches!(profile.state.as_str(), "active" | "building" | "queryable"),
        healthy: model_healthy,
        circuit_open,
        protocol_compatible,
        index_compatible: physical_index_compatible
            && dimension_compatible
            && fingerprint_compatible,
        weight: 1.0,
    }
}

async fn validate_route_runtime_fingerprint(
    llm_manager: &LLMManager,
    route: &PlannedRetrievalRoute,
) -> VfsResult<()> {
    let configs = llm_manager
        .get_api_configs()
        .await
        .map_err(|error| VfsError::Other(error.to_string()))?;
    validate_route_config_fingerprint(route, &configs)
}

fn validate_route_config_fingerprint(
    route: &PlannedRetrievalRoute,
    configs: &[ApiConfig],
) -> VfsResult<()> {
    let expected = route
        .expected_model_fingerprint
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            VfsError::Other(format!(
                "vector route {} has no planned runtime model fingerprint",
                route.route_id
            ))
        })?;
    let model_config_id = required_model_id(route)?;
    let config = configs
        .iter()
        .find(|config| config.id == model_config_id)
        .ok_or_else(|| {
            VfsError::Other(format!(
                "stale vector route {}: model config {} no longer exists",
                route.route_id, model_config_id
            ))
        })?;
    let route_protocol_valid = config.enabled
        && config.is_embedding
        && !config.is_reranker
        && match route.kind {
            RetrievalRouteKind::TextEmbedding => !config.is_multimodal,
            RetrievalRouteKind::MultimodalText | RetrievalRouteKind::MultimodalImage => {
                config.is_multimodal
            }
            RetrievalRouteKind::FullText => false,
        };
    if !route_protocol_valid {
        return Err(VfsError::Other(format!(
            "stale vector route {}: model config {} no longer supports {:?}",
            route.route_id, model_config_id, route.kind
        )));
    }
    let actual = embedding_dim_repo::model_fingerprint_for_config(config, &route.modality)?;
    if actual != expected {
        return Err(VfsError::Other(format!(
            "stale vector route {}: model config {} changed after planning",
            route.route_id, model_config_id
        )));
    }
    Ok(())
}

fn profile_fingerprint_compatible(
    profile: &embedding_dim_repo::VfsIndexProfile,
    config: &ApiConfig,
    protocol_compatible: bool,
    dimension_compatible: bool,
    physical_index_compatible: bool,
) -> bool {
    let runtime_fingerprint =
        embedding_dim_repo::model_fingerprint_for_config(config, &profile.modality).ok();
    if runtime_fingerprint.as_deref() == Some(profile.model_fingerprint.as_str()) {
        return true;
    }

    let expected_legacy_fingerprint = format!("legacy:model-config:{}", config.id);
    profile.model_fingerprint == expected_legacy_fingerprint
        && profile.model_config_id.as_deref() == Some(config.id.as_str())
        && protocol_compatible
        && dimension_compatible
        && physical_index_compatible
}

fn circuit_open_route_failures(
    profiles: &[IndexProfileCapability],
    query_modality: QueryModality,
    multimodal_only: bool,
) -> Vec<RetrievalRouteFailure> {
    let mut failures = Vec::new();
    for profile in profiles.iter().filter(|profile| {
        profile.circuit_open
            && profile.configured
            && profile.active
            && profile.healthy
            && profile.protocol_compatible
            && profile.index_compatible
            && profile.dimension > 0
            && profile
                .model_config_id
                .as_ref()
                .is_some_and(|id| !id.is_empty())
    }) {
        let mut kinds = Vec::new();
        if !multimodal_only
            && profile.modality == "text"
            && profile.embedding_protocol == "text-embedding-v1"
            && query_modality.has_text()
        {
            kinds.push(RetrievalRouteKind::TextEmbedding);
        } else if matches!(profile.modality.as_str(), "multimodal" | "image")
            && profile.embedding_protocol == "multimodal-embedding-v1"
        {
            if query_modality.has_text() {
                kinds.push(RetrievalRouteKind::MultimodalText);
            }
            if query_modality.has_image() {
                kinds.push(RetrievalRouteKind::MultimodalImage);
            }
        }
        let reason = profile_circuit_rejection(&profile.profile_id)
            .unwrap_or_else(|| "profile circuit open; route skipped".to_string());
        failures.extend(kinds.into_iter().map(|kind| RetrievalRouteFailure {
            route_id: format!("{:?}:{}", kind, profile.profile_id).to_ascii_lowercase(),
            profile_id: Some(profile.profile_id.clone()),
            dimension: Some(profile.dimension),
            error: reason.clone(),
            timed_out: false,
            query_derivation: None,
        }));
    }
    failures
}

fn aggregate_embedding_capability(
    profiles: &[IndexProfileCapability],
    modality: &str,
) -> CapabilityState {
    let matching: Vec<_> = profiles
        .iter()
        .filter(|profile| {
            profile.modality == modality
                || (modality == "multimodal" && profile.modality == "image")
        })
        .collect();
    if matching.is_empty() {
        return CapabilityState::unavailable();
    }
    let configured = matching
        .iter()
        .any(|profile| profile.configured && profile.active);
    let healthy = matching
        .iter()
        .any(|profile| profile.configured && profile.active && profile.healthy);
    let protocol_compatible = matching.iter().any(|profile| {
        profile.configured && profile.active && profile.healthy && profile.protocol_compatible
    });
    let viable: Vec<_> = matching
        .iter()
        .filter(|profile| {
            profile.configured
                && profile.active
                && profile.healthy
                && profile.protocol_compatible
                && profile.index_compatible
                && profile.dimension > 0
                && profile
                    .model_config_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty())
        })
        .collect();
    let index_compatible = !viable.is_empty();
    let circuit_open = !viable.is_empty() && viable.iter().all(|profile| profile.circuit_open);
    CapabilityState {
        configured,
        healthy,
        circuit_open,
        protocol_compatible,
        index_compatible,
        reason: if circuit_open {
            Some("all otherwise viable active profiles have open circuit breakers".to_string())
        } else if configured && healthy && protocol_compatible && index_compatible {
            None
        } else {
            Some("no healthy protocol/index-compatible active profile".to_string())
        },
    }
}

fn is_profile_index_compatible(metric: &str, version: i32, schema_version: i32) -> bool {
    schema_version >= 1
        && match metric {
            // Tiny tables intentionally bypass ANN and perform exact cosine search.
            "exact" => true,
            "cosine" => version >= 1,
            _ => false,
        }
}

fn required_model_id(route: &PlannedRetrievalRoute) -> VfsResult<&str> {
    route
        .model_config_id
        .as_deref()
        .ok_or_else(|| VfsError::Other(format!("route {} has no model binding", route.route_id)))
}

fn required_profile_id(route: &PlannedRetrievalRoute) -> VfsResult<&str> {
    route
        .profile_id
        .as_deref()
        .ok_or_else(|| VfsError::Other(format!("route {} has no profile", route.route_id)))
}

fn required_query_text(request: &UnifiedRetrievalRequest) -> VfsResult<&str> {
    request
        .query_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| VfsError::InvalidArgument {
            param: "queryText".to_string(),
            reason: "text retrieval route requires query text".to_string(),
        })
}

fn validate_dimension(route: &PlannedRetrievalRoute, embedding: &[f32]) -> VfsResult<()> {
    if route.dimension == Some(embedding.len()) {
        Ok(())
    } else {
        Err(VfsError::Other(format!(
            "profile {:?} index mismatch: expected dimension {:?}, model returned {}",
            route.profile_id,
            route.dimension,
            embedding.len()
        )))
    }
}

fn resource_folder_id(
    db: &VfsDatabase,
    resource_id: &str,
    source_id: Option<&str>,
) -> VfsResult<Option<String>> {
    let conn = db.get_conn_safe()?;
    let source_id = source_id.unwrap_or(resource_id);
    let result = conn
        .query_row(
            "SELECT folder_id FROM folder_items
             WHERE deleted_at IS NULL AND (item_id = ?1 OR item_id = ?2)
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![resource_id, source_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(result)
}

/// Validate Lance candidates against the committed SQLite ledger in bounded batches.
fn active_segment_row_ids(
    db: &VfsDatabase,
    rows: &[VfsLanceSearchResult],
    route: &PlannedRetrievalRoute,
) -> VfsResult<HashSet<String>> {
    if rows.is_empty() {
        return Ok(HashSet::new());
    }
    let profile_id = required_profile_id(route)?;
    let dimension = route.dimension.ok_or_else(|| {
        VfsError::Other(format!(
            "route {} has no embedding dimension",
            route.route_id
        ))
    })?;
    let unique_ids: Vec<String> = rows
        .iter()
        .map(|row| row.embedding_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let conn = db.get_conn_safe()?;
    let mut active = HashSet::new();
    // Leave room under SQLite's conservative parameter limit for route metadata.
    for chunk in unique_ids.chunks(400) {
        let placeholders = std::iter::repeat("?")
            .take(chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT s.lance_row_id
             FROM vfs_index_segments s
             JOIN vfs_index_units u ON u.id = s.unit_id
             JOIN vfs_index_profiles p ON p.id = s.index_profile_id
             LEFT JOIN resources r ON r.id = u.resource_id
             WHERE s.lance_row_id IN ({})
               AND s.index_profile_id = ?
               AND s.embedding_dim = ?
               AND p.state IN ('active', 'building', 'queryable')
               AND (
                    (s.modality = 'text'
                     AND u.text_profile_id = s.index_profile_id
                     AND u.text_generation = s.generation
                     AND (r.id IS NULL OR (r.deleted_at IS NULL
                          AND COALESCE(r.index_state, 'pending') <> 'disabled')))
                    OR
                    (s.modality IN ('image', 'multimodal')
                     AND u.mm_profile_id = s.index_profile_id
                     AND u.mm_generation = s.generation
                     AND (r.id IS NULL OR (r.deleted_at IS NULL
                          AND COALESCE(r.mm_index_state, 'pending') <> 'disabled')))
               )",
            placeholders
        );
        let mut values: Vec<SqlValue> = chunk.iter().cloned().map(SqlValue::Text).collect();
        values.push(SqlValue::Text(profile_id.to_string()));
        values.push(SqlValue::Integer(dimension as i64));
        let mut stmt = conn.prepare(&sql)?;
        let ids = stmt
            .query_map(params_from_iter(values.iter()), |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        active.extend(ids);
    }
    Ok(active)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_text_profile(
        id: &str,
        config_id: &str,
        model_name: Option<&str>,
    ) -> embedding_dim_repo::VfsIndexProfile {
        embedding_dim_repo::VfsIndexProfile {
            id: id.to_string(),
            model_fingerprint: format!("legacy:model-config:{config_id}"),
            model_config_id: Some(config_id.to_string()),
            model_name: model_name.map(str::to_string),
            dimension: 1024,
            modality: "text".to_string(),
            embedding_protocol: "text-embedding-v1".to_string(),
            schema_version: 1,
            lance_table_name: format!("profile_{id}"),
            active_generation: 0,
            state: "active".to_string(),
            ann_metric: "cosine".to_string(),
            ann_index_version: 1,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn create_lexical_unit(
        db: &VfsDatabase,
        source_id: &str,
        text: &str,
        unit_index: i32,
    ) -> String {
        use crate::vfs::repos::index_unit_repo::{self, CreateUnitInput};
        use crate::vfs::{VfsResourceMetadata, VfsResourceRepo, VfsResourceType};

        let created = VfsResourceRepo::create_or_reuse(
            db,
            VfsResourceType::Note,
            text,
            Some(source_id),
            Some("notes"),
            Some(&VfsResourceMetadata {
                title: Some(source_id.to_string()),
                ..Default::default()
            }),
        )
        .expect("create lexical resource");
        let conn = db.get_conn_safe().expect("open vfs");
        index_unit_repo::create(
            &conn,
            CreateUnitInput {
                resource_id: created.resource_id.clone(),
                unit_index,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some(text.to_string()),
                text_source: Some("native".to_string()),
            },
        )
        .expect("create lexical unit");
        created.resource_id
    }

    #[test]
    fn request_validation_matches_declared_modality() {
        let text = UnifiedRetrievalRequest::text("query", 10);
        assert!(text.validate().is_ok());

        let invalid = UnifiedRetrievalRequest {
            query_text: Some("text".to_string()),
            query_image_base64: None,
            query_image_media_type: None,
            query_modality: QueryModality::Mixed,
            top_k: 10,
            folder_ids: None,
            resource_ids: None,
            resource_types: None,
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn image_fallback_gate_waits_only_for_multimodal_image_routes() {
        let route = |route_id: &str, kind: RetrievalRouteKind| PlannedRetrievalRoute {
            route_id: route_id.to_string(),
            kind,
            profile_id: Some(format!("profile-{route_id}")),
            model_config_id: Some(format!("model-{route_id}")),
            expected_model_fingerprint: Some(format!("fingerprint-{route_id}")),
            dimension: Some(1024),
            modality: "multimodal".to_string(),
            weight: 1.0,
            fetch_limit: 10,
            query_derivation: None,
        };
        let (gated, concurrent) = partition_image_fallback_gate_routes(vec![
            route("me-image-a", RetrievalRouteKind::MultimodalImage),
            route("te", RetrievalRouteKind::TextEmbedding),
            route("me-text", RetrievalRouteKind::MultimodalText),
            route("fts", RetrievalRouteKind::FullText),
            route("me-image-b", RetrievalRouteKind::MultimodalImage),
        ]);

        assert_eq!(
            gated
                .iter()
                .map(|route| route.route_id.as_str())
                .collect::<Vec<_>>(),
            vec!["me-image-a", "me-image-b"]
        );
        assert_eq!(
            concurrent
                .iter()
                .map(|route| route.route_id.as_str())
                .collect::<Vec<_>>(),
            vec!["te", "me-text", "fts"]
        );
    }

    #[test]
    fn generic_multimodal_model_is_observer_but_not_ocr_capability() {
        use crate::ocr_adapters::OcrEngineType;

        assert!(!has_dedicated_ocr_capability([
            OcrEngineType::GenericVlm,
            OcrEngineType::Glm4vOcr,
        ]));
        assert!(has_dedicated_ocr_capability([
            OcrEngineType::SystemOcr,
            OcrEngineType::DeepSeekOcr,
        ]));

        let generic = ApiConfig {
            id: "generic-mm".to_string(),
            name: "Generic multimodal observer".to_string(),
            model: "Qwen/Qwen2.5-VL-7B-Instruct".to_string(),
            enabled: true,
            is_multimodal: true,
            ..Default::default()
        };
        let prioritized = vec![(generic.clone(), OcrEngineType::GenericVlm)];
        let dedicated_ids = HashSet::new();
        assert_eq!(
            select_multimodal_observer(
                std::slice::from_ref(&generic),
                &prioritized,
                &dedicated_ids,
            )
            .map(|config| config.id.as_str()),
            Some("generic-mm")
        );
    }

    #[test]
    fn dedicated_ocr_only_does_not_advertise_text_or_multimodal_model() {
        use crate::llm_manager::OcrRuntimeCandidate;
        use crate::ocr_adapters::OcrEngineType;

        let dedicated = ApiConfig {
            id: "dedicated-ocr".to_string(),
            name: "Dedicated OCR".to_string(),
            model: "deepseek-ai/DeepSeek-OCR".to_string(),
            enabled: true,
            is_multimodal: true,
            ..Default::default()
        };
        let candidates = vec![OcrRuntimeCandidate::Remote {
            config: dedicated.clone(),
            engine_type: OcrEngineType::DeepSeekOcr,
        }];
        let dedicated_ids = dedicated_ocr_config_ids(&candidates);
        let prioritized = vec![(dedicated.clone(), OcrEngineType::DeepSeekOcr)];

        assert!(has_dedicated_ocr_capability(
            candidates.iter().map(OcrRuntimeCandidate::engine_type)
        ));
        assert!(dedicated_ids.contains(&dedicated.id));
        assert!(select_multimodal_observer(
            std::slice::from_ref(&dedicated),
            &prioritized,
            &dedicated_ids,
        )
        .is_none());

        let mut text_shaped_ocr = dedicated;
        text_shaped_ocr.is_multimodal = false;
        assert!(valid_generation_config(&text_shaped_ocr));
        assert!(!is_general_text_generation_config(
            &text_shaped_ocr,
            &dedicated_ids,
        ));
    }

    #[test]
    fn capability_aggregation_exposes_index_mismatch() {
        let profile = IndexProfileCapability {
            profile_id: "profile".to_string(),
            dimension: 1024,
            modality: "text".to_string(),
            embedding_protocol: "text-embedding-v1".to_string(),
            model_config_id: Some("model".to_string()),
            runtime_model_fingerprint: Some("fingerprint-model".to_string()),
            configured: true,
            active: true,
            healthy: true,
            circuit_open: false,
            protocol_compatible: true,
            index_compatible: false,
            weight: 1.0,
        };
        let state = aggregate_embedding_capability(&[profile], "text");
        assert!(state.configured);
        assert!(state.healthy);
        assert!(!state.index_compatible);
        assert!(!state.embedding_available());
    }

    #[test]
    fn runtime_fingerprint_mismatch_isolated_to_its_profile() {
        let config = ApiConfig {
            id: "embedding-config".to_string(),
            name: "Embedding".to_string(),
            base_url: "https://embedding.example/v1".to_string(),
            model: "embedding-model".to_string(),
            is_embedding: true,
            enabled: true,
            ..Default::default()
        };
        let fingerprint =
            embedding_dim_repo::model_fingerprint_for_config(&config, "text").unwrap();
        let make_profile =
            |id: &str, model_fingerprint: String| embedding_dim_repo::VfsIndexProfile {
                id: id.to_string(),
                model_fingerprint,
                model_config_id: Some(config.id.clone()),
                model_name: Some(config.model.clone()),
                dimension: 1024,
                modality: "text".to_string(),
                embedding_protocol: "text-embedding-v1".to_string(),
                schema_version: 1,
                lance_table_name: format!("profile_{id}"),
                active_generation: 1,
                state: "active".to_string(),
                ann_metric: "cosine".to_string(),
                ann_index_version: 1,
                created_at: 0,
                updated_at: 0,
            };
        let models = HashMap::from([(config.id.clone(), config.clone())]);
        let healthy =
            index_profile_capability(make_profile("healthy", fingerprint), &models, false);
        let mismatched = index_profile_capability(
            make_profile("mismatched", "sha256:stale-runtime-binding".to_string()),
            &models,
            false,
        );

        assert!(healthy.healthy && healthy.index_compatible && healthy.usable());
        assert!(!mismatched.healthy);
        assert!(!mismatched.index_compatible);
        assert!(!mismatched.usable());

        let profiles = vec![healthy, mismatched];
        let snapshot = CapabilitySnapshot {
            text_embedding: aggregate_embedding_capability(&profiles, "text"),
            ..Default::default()
        };
        let plan = plan_retrieval(&snapshot, QueryModality::Text, &profiles, 10);
        assert!(plan.routes.iter().any(|route| route.route_id == "fts"));
        assert_eq!(
            plan.routes
                .iter()
                .filter(|route| route.kind == RetrievalRouteKind::TextEmbedding)
                .filter_map(|route| route.profile_id.as_deref())
                .collect::<Vec<_>>(),
            vec!["healthy"]
        );
    }

    #[test]
    fn planned_routes_reject_same_id_model_or_transport_changes_independently() {
        let config = |id: &str, model: &str, base_url: &str| ApiConfig {
            id: id.to_string(),
            name: id.to_string(),
            base_url: base_url.to_string(),
            model: model.to_string(),
            is_embedding: true,
            enabled: true,
            ..Default::default()
        };
        let original = config(
            "reused-config-id",
            "embedding-space-v1",
            "https://embedding-a.example/v1",
        );
        let stable = config(
            "stable-config-id",
            "stable-space",
            "https://embedding-b.example/v1",
        );
        let profile = |id: &str, config: &ApiConfig| embedding_dim_repo::VfsIndexProfile {
            id: id.to_string(),
            model_fingerprint: embedding_dim_repo::model_fingerprint_for_config(config, "text")
                .unwrap(),
            model_config_id: Some(config.id.clone()),
            model_name: Some(config.model.clone()),
            dimension: 1024,
            modality: "text".to_string(),
            embedding_protocol: "text-embedding-v1".to_string(),
            schema_version: 1,
            lance_table_name: format!("profile_{id}"),
            active_generation: 1,
            state: "active".to_string(),
            ann_metric: "cosine".to_string(),
            ann_index_version: 1,
            created_at: 0,
            updated_at: 0,
        };
        let snapshot_models = HashMap::from([
            (original.id.clone(), original.clone()),
            (stable.id.clone(), stable.clone()),
        ]);
        let profiles = vec![
            index_profile_capability(profile("changing", &original), &snapshot_models, false),
            index_profile_capability(profile("stable", &stable), &snapshot_models, false),
        ];
        let snapshot = CapabilitySnapshot {
            text_embedding: aggregate_embedding_capability(&profiles, "text"),
            ..Default::default()
        };
        let plan = plan_retrieval(&snapshot, QueryModality::Text, &profiles, 10);
        let changing_route = plan
            .routes
            .iter()
            .find(|route| route.profile_id.as_deref() == Some("changing"))
            .unwrap();
        let stable_route = plan
            .routes
            .iter()
            .find(|route| route.profile_id.as_deref() == Some("stable"))
            .unwrap();

        let changed_model = config(
            "reused-config-id",
            "embedding-space-v2",
            "https://embedding-a.example/v1",
        );
        let current_models = vec![changed_model, stable.clone()];
        let error = validate_route_config_fingerprint(changing_route, &current_models)
            .expect_err("same ID with a different model must be stale");
        assert!(error.to_string().contains("changed after planning"));
        validate_route_config_fingerprint(stable_route, &current_models)
            .expect("an unrelated profile remains queryable");

        let changed_transport = config(
            "reused-config-id",
            "embedding-space-v1",
            "https://embedding-a-alt.example/v1",
        );
        let current_models = vec![changed_transport, stable];
        assert!(validate_route_config_fingerprint(changing_route, &current_models).is_err());
        validate_route_config_fingerprint(stable_route, &current_models)
            .expect("transport change is isolated to the bound route");
    }

    #[test]
    fn matching_bound_legacy_profile_remains_queryable() {
        let config = ApiConfig {
            id: "legacy-config".to_string(),
            name: "Legacy embedding".to_string(),
            base_url: "https://embedding.example/v1".to_string(),
            model: "BAAI/bge-m3".to_string(),
            is_embedding: true,
            enabled: true,
            ..Default::default()
        };
        let models = HashMap::from([(config.id.clone(), config.clone())]);
        let capability = index_profile_capability(
            legacy_text_profile(
                "legacy-ready",
                &config.id,
                Some("SiliconFlow - BAAI/bge-m3"),
            ),
            &models,
            false,
        );
        assert!(capability.healthy);
        assert!(capability.index_compatible);
        assert!(capability.usable());

        let fallback_config = ApiConfig {
            id: "same-id-and-model".to_string(),
            name: "Legacy fallback".to_string(),
            base_url: "https://embedding.example/v1".to_string(),
            model: "same-id-and-model".to_string(),
            is_embedding: true,
            enabled: true,
            ..Default::default()
        };
        let fallback_models =
            HashMap::from([(fallback_config.id.clone(), fallback_config.clone())]);
        let fallback = index_profile_capability(
            legacy_text_profile("legacy-fallback", &fallback_config.id, None),
            &fallback_models,
            false,
        );
        assert!(fallback.usable());
    }

    #[test]
    fn bound_legacy_profile_with_changed_model_name_remains_queryable() {
        let config = ApiConfig {
            id: "legacy-config".to_string(),
            name: "Legacy embedding".to_string(),
            base_url: "https://embedding.example/v1".to_string(),
            model: "new-model".to_string(),
            is_embedding: true,
            enabled: true,
            ..Default::default()
        };
        let models = HashMap::from([(config.id.clone(), config.clone())]);
        let capability = index_profile_capability(
            legacy_text_profile("legacy-queryable", &config.id, Some("old-display-name")),
            &models,
            false,
        );
        assert!(capability.healthy);
        assert!(capability.index_compatible);
        assert!(capability.usable());

        let profiles = vec![capability];
        let snapshot = CapabilitySnapshot {
            text_embedding: aggregate_embedding_capability(&profiles, "text"),
            ..Default::default()
        };
        let plan = plan_retrieval(&snapshot, QueryModality::Text, &profiles, 10);
        assert!(plan.routes.iter().any(|route| {
            route.kind == RetrievalRouteKind::TextEmbedding
                && route.profile_id.as_deref() == Some("legacy-queryable")
                && route.model_config_id.as_deref() == Some(config.id.as_str())
        }));
    }

    #[test]
    fn unbound_or_differently_bound_legacy_profiles_are_isolated() {
        let config = ApiConfig {
            id: "legacy-config".to_string(),
            name: "Legacy embedding".to_string(),
            base_url: "https://embedding.example/v1".to_string(),
            model: "current-model".to_string(),
            is_embedding: true,
            enabled: true,
            ..Default::default()
        };
        let models = HashMap::from([(config.id.clone(), config.clone())]);

        let mut unbound = legacy_text_profile("legacy-unbound", &config.id, Some("old-model"));
        unbound.model_fingerprint = "legacy:unbound:text:1024".to_string();
        let unbound = index_profile_capability(unbound, &models, false);
        assert!(!unbound.healthy);
        assert!(!unbound.index_compatible);
        assert!(!unbound.usable());

        let mut differently_bound =
            legacy_text_profile("legacy-other-config", &config.id, Some("old-model"));
        differently_bound.model_fingerprint = "legacy:model-config:other-config".to_string();
        let differently_bound = index_profile_capability(differently_bound, &models, false);
        assert!(!differently_bound.healthy);
        assert!(!differently_bound.index_compatible);
        assert!(!differently_bound.usable());
    }

    #[test]
    fn bound_legacy_profile_still_requires_protocol_dimension_and_index_compatibility() {
        let config = ApiConfig {
            id: "legacy-config".to_string(),
            name: "Legacy embedding".to_string(),
            base_url: "https://embedding.example/v1".to_string(),
            model: "current-model".to_string(),
            is_embedding: true,
            enabled: true,
            ..Default::default()
        };
        let models = HashMap::from([(config.id.clone(), config.clone())]);

        let mut invalid_protocol = legacy_text_profile("legacy-invalid-protocol", &config.id, None);
        invalid_protocol.embedding_protocol = "multimodal-embedding-v1".to_string();
        assert!(!index_profile_capability(invalid_protocol, &models, false).usable());

        let mut invalid_dimension =
            legacy_text_profile("legacy-invalid-dimension", &config.id, None);
        invalid_dimension.dimension = embedding_dim_repo::MAX_DIMENSION + 1;
        assert!(!index_profile_capability(invalid_dimension, &models, false).usable());

        let mut invalid_index = legacy_text_profile("legacy-invalid-index", &config.id, None);
        invalid_index.ann_metric = "legacy_l2".to_string();
        invalid_index.ann_index_version = 0;
        assert!(!index_profile_capability(invalid_index, &models, false).usable());
    }

    #[test]
    fn tiny_exact_profile_is_index_compatible() {
        assert!(is_profile_index_compatible("exact", 0, 1));
        assert!(is_profile_index_compatible("exact", 1, 1));
        assert!(is_profile_index_compatible("cosine", 1, 1));
        assert!(!is_profile_index_compatible("legacy_l2", 0, 1));
        assert!(!is_profile_index_compatible("exact", 0, 0));
    }

    #[test]
    fn lexical_route_finds_unit_text_without_embedding_segment() {
        use crate::vfs::repos::index_unit_repo::{self, CreateUnitInput};
        use crate::vfs::{VfsResourceMetadata, VfsResourceRepo, VfsResourceType};

        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let created = VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Note,
            "unit only lexical content",
            Some("note_lexical_only"),
            Some("notes"),
            Some(&VfsResourceMetadata {
                title: Some("Lexical only".to_string()),
                ..Default::default()
            }),
        )
        .expect("create resource");
        let conn = db.get_conn_safe().expect("open vfs");
        index_unit_repo::create(
            &conn,
            CreateUnitInput {
                resource_id: created.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some("unit only lexical content".to_string()),
                text_source: Some("native".to_string()),
            },
        )
        .expect("create unit without segment");
        drop(conn);

        let request = UnifiedRetrievalRequest::text("lexical content", 10);
        let hits = VfsUnifiedRetriever::execute_fts_route(&db, "lexical content", &request, 10)
            .expect("lexical search");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].identity.resource_id, created.resource_id);
        assert!(hits[0].embedding_id.starts_with("unit:"));
    }

    #[test]
    fn lexical_route_uses_keywords_from_long_multimodal_observation() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let target = create_lexical_unit(
            &db,
            "note_mm_keywords",
            "量子纠缠实验使用纠错码保护逻辑量子比特",
            0,
        );
        create_lexical_unit(&db, "note_mm_distractor", "普通课堂板书与课程安排", 0);

        let query = "画面是一张复杂的实验装置照片，包含大量与知识库原文不同的视觉描述，整段描述不会逐字出现在任何记录中。\n关键词：量子纠缠 纠错码";
        let request = UnifiedRetrievalRequest::text(query, 10);
        let hits = VfsUnifiedRetriever::execute_fts_route(&db, query, &request, 10)
            .expect("keyword-led lexical search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].identity.resource_id, target);
    }

    #[test]
    fn lexical_route_ranks_more_term_matches_first_deterministically() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let two_terms = create_lexical_unit(
            &db,
            "note_two_terms",
            "distributed consensus preserves causal ordering",
            0,
        );
        let one_term = create_lexical_unit(
            &db,
            "note_one_term",
            "distributed workers process independent jobs",
            0,
        );
        let query = "Keywords: distributed consensus";
        let request = UnifiedRetrievalRequest::text(query, 10);
        let hits = VfsUnifiedRetriever::execute_fts_route(&db, query, &request, 10)
            .expect("rank lexical matches");

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].identity.resource_id, two_terms);
        assert_eq!(hits[1].identity.resource_id, one_term);
    }

    #[test]
    fn lexical_route_escapes_percent_and_underscore_keywords() {
        assert_eq!(escaped_like_pattern("100%_ready"), "%100\\%\\_ready%");
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let literal = create_lexical_unit(
            &db,
            "note_literal_wildcards",
            "release marker 100%_ready is literal",
            0,
        );
        create_lexical_unit(
            &db,
            "note_wildcard_decoy",
            "release marker 100Xalmostready is different",
            0,
        );
        let query = "关键词：100%_ready";
        let request = UnifiedRetrievalRequest::text(query, 10);
        let hits = VfsUnifiedRetriever::execute_fts_route(&db, query, &request, 10)
            .expect("escaped wildcard search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].identity.resource_id, literal);
    }

    #[test]
    fn multimodal_scope_drops_plain_text_hits_without_media_or_me_provenance() {
        let route = |kind, id: &str| PlannedRetrievalRoute {
            route_id: id.to_string(),
            kind,
            profile_id: Some(id.to_string()),
            model_config_id: Some(format!("model-{id}")),
            expected_model_fingerprint: Some(format!("fingerprint-{id}")),
            dimension: Some(1024),
            modality: "text".to_string(),
            weight: 1.0,
            fetch_limit: 10,
            query_derivation: Some(QueryDerivationProvenance {
                kind: QueryDerivationKind::MultimodalObservation,
                model_config_id: Some("observer".to_string()),
            }),
        };
        let hit = RetrievalHit {
            identity: RetrievalIdentity {
                resource_id: "text-only".to_string(),
                chunk_index: 0,
                page_index: None,
            },
            embedding_id: "text-only-row".to_string(),
            text: "plain text result".to_string(),
            title: None,
            resource_type: Some("note".to_string()),
            source_id: None,
            folder_id: None,
            blob_hash: None,
            image_url: None,
            raw_score: None,
            metadata: Value::Null,
        };
        let fused = fuse_route_results(
            vec![Ok(RetrievalRouteResult {
                route: route(RetrievalRouteKind::TextEmbedding, "te"),
                hits: vec![hit.clone()],
                elapsed_ms: 1,
            })],
            10,
        );
        assert!(!is_multimodal_scope_hit(&fused.hits[0]));

        let mut media_hit = hit.clone();
        media_hit.blob_hash = Some("blob".to_string());
        let fused = fuse_route_results(
            vec![Ok(RetrievalRouteResult {
                route: route(RetrievalRouteKind::TextEmbedding, "te"),
                hits: vec![media_hit],
                elapsed_ms: 1,
            })],
            10,
        );
        assert!(is_multimodal_scope_hit(&fused.hits[0]));

        let fused = fuse_route_results(
            vec![Ok(RetrievalRouteResult {
                route: route(RetrievalRouteKind::MultimodalText, "me"),
                hits: vec![hit],
                elapsed_ms: 1,
            })],
            10,
        );
        assert!(is_multimodal_scope_hit(&fused.hits[0]));
    }

    #[test]
    fn vector_hits_require_active_ledger_and_use_canonical_folder() {
        use crate::vfs::repos::index_segment_repo::{self, CreateSegmentInput};
        use crate::vfs::repos::index_unit_repo::{self, CreateUnitInput};
        use crate::vfs::{VfsResourceMetadata, VfsResourceRepo, VfsResourceType};

        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let created = VfsResourceRepo::create_or_reuse(
            &db,
            VfsResourceType::Note,
            "active ledger text",
            Some("note_active_ledger"),
            Some("notes"),
            Some(&VfsResourceMetadata {
                title: Some("Active ledger".to_string()),
                ..Default::default()
            }),
        )
        .expect("create resource");
        let conn = db.get_conn_safe().expect("open vfs");
        let registered = embedding_dim_repo::register_with_model(
            &conn,
            128,
            "text",
            Some("model-text"),
            Some("Text embedding"),
        )
        .expect("register profile");
        let profile_id = registered.active_profile_id.expect("active profile");
        let unit = index_unit_repo::create(
            &conn,
            CreateUnitInput {
                resource_id: created.resource_id.clone(),
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some("active ledger text".to_string()),
                text_source: Some("native".to_string()),
            },
        )
        .expect("create unit");
        let unit_id = unit.id.clone();
        conn.execute(
            "UPDATE vfs_index_units SET text_profile_id = ?2, text_generation = 1 WHERE id = ?1",
            params![unit_id, profile_id],
        )
        .expect("bind unit generation");
        index_segment_repo::create(
            &conn,
            CreateSegmentInput {
                unit_id: unit_id.clone(),
                segment_index: 0,
                modality: "text".to_string(),
                embedding_dim: 128,
                lance_row_id: "active-row".to_string(),
                content_text: Some("active ledger text".to_string()),
                content_hash: None,
                start_pos: None,
                end_pos: None,
                metadata_json: None,
            },
        )
        .expect("commit active segment");
        let unit_generation_four = index_unit_repo::create(
            &conn,
            CreateUnitInput {
                resource_id: created.resource_id.clone(),
                unit_index: 1,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some("second active ledger text".to_string()),
                text_source: Some("native".to_string()),
            },
        )
        .expect("create second unit");
        let unit_generation_four_id = unit_generation_four.id.clone();
        conn.execute(
            "UPDATE vfs_index_units SET text_profile_id = ?2, text_generation = 4 WHERE id = ?1",
            params![unit_generation_four_id, profile_id],
        )
        .expect("bind independent unit generation");
        index_segment_repo::create(
            &conn,
            CreateSegmentInput {
                unit_id: unit_generation_four_id.clone(),
                segment_index: 0,
                modality: "text".to_string(),
                embedding_dim: 128,
                lance_row_id: "active-row-generation-four".to_string(),
                content_text: Some("second active ledger text".to_string()),
                content_hash: None,
                start_pos: None,
                end_pos: None,
                metadata_json: None,
            },
        )
        .expect("commit second active segment");
        conn.execute(
            "INSERT INTO folders (id, title, created_at, updated_at) VALUES ('fld_canonical', 'Canonical', 1, 1)",
            [],
        )
        .expect("create canonical folder");
        conn.execute(
            "INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at)
             VALUES ('fi_canonical', 'fld_canonical', 'note', 'note_active_ledger', 1)",
            [],
        )
        .expect("place resource in canonical folder");
        drop(conn);

        let row = |embedding_id: &str, row_unit_id: &str, generation: i64, page: i32| {
            VfsLanceSearchResult {
                embedding_id: embedding_id.to_string(),
                resource_id: created.resource_id.clone(),
                unit_id: row_unit_id.to_string(),
                resource_type: "note".to_string(),
                folder_id: Some("fld_stale_lance_value".to_string()),
                chunk_index: 0,
                text: "active ledger text".to_string(),
                score: 0.9,
                metadata_json: None,
                index_profile_id: profile_id.clone(),
                generation,
                page_index: Some(page),
                source_id: Some("note_active_ledger".to_string()),
            }
        };
        let route = PlannedRetrievalRoute {
            route_id: "text-profile".to_string(),
            kind: RetrievalRouteKind::TextEmbedding,
            profile_id: Some(profile_id.clone()),
            model_config_id: Some("model-text".to_string()),
            expected_model_fingerprint: Some("fingerprint-model-text".to_string()),
            dimension: Some(128),
            modality: "text".to_string(),
            weight: 1.0,
            fetch_limit: 30,
            query_derivation: None,
        };
        let mut request = UnifiedRetrievalRequest::text("active", 10);
        request.folder_ids = Some(vec!["fld_canonical".to_string()]);
        let hits = VfsUnifiedRetriever::lance_rows_to_hits(
            &db,
            vec![
                row("active-row", &unit_id, 1, 0),
                row("active-row-generation-four", &unit_generation_four_id, 4, 1),
                row("staged-or-orphan-row", &unit_id, 1, 0),
            ],
            &route,
            &request,
        )
        .expect("validate vector hits");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].embedding_id, "active-row");
        assert!(hits
            .iter()
            .all(|hit| hit.folder_id.as_deref() == Some("fld_canonical")));
    }
}
