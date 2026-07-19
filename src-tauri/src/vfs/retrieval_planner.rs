//! Capability-aware retrieval and generation routing.
//!
//! This module is deliberately free of Tauri, database, and network concerns. Runtime
//! adapters take an immutable capability snapshot at the start of a turn, execute the
//! planned routes independently, and feed the outcomes into weighted RRF.

use std::cmp::Ordering;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_OVERSAMPLE_FACTOR: usize = 3;
const DEFAULT_RRF_K: f64 = 60.0;
const FTS_FAMILY_WEIGHT: f64 = 1.0;
const TEXT_EMBEDDING_FAMILY_WEIGHT: f64 = 1.0;
const MULTIMODAL_TEXT_FAMILY_WEIGHT: f64 = 1.0;
const MULTIMODAL_IMAGE_FAMILY_WEIGHT: f64 = 1.0;

pub(crate) const PROFILE_CIRCUIT_FAILURE_THRESHOLD: u32 = 3;
pub(crate) const PROFILE_CIRCUIT_COOLDOWN_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileCircuitPhase {
    Closed,
    Open { opened_at_ms: u64 },
    HalfOpen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProfileCircuitDecision {
    Allow,
    AllowHalfOpenProbe,
    RejectOpen { retry_after_ms: u64 },
    RejectHalfOpen,
}

/// Pure per-profile circuit-breaker state machine. Runtime storage is process-local,
/// while tests drive time explicitly so cooldown and half-open behavior stay deterministic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProfileCircuitBreaker {
    phase: ProfileCircuitPhase,
    consecutive_failures: u32,
    failure_threshold: u32,
    cooldown_ms: u64,
}

impl Default for ProfileCircuitBreaker {
    fn default() -> Self {
        Self::new(
            PROFILE_CIRCUIT_FAILURE_THRESHOLD,
            PROFILE_CIRCUIT_COOLDOWN_MS,
        )
    }
}

impl ProfileCircuitBreaker {
    pub(crate) fn new(failure_threshold: u32, cooldown_ms: u64) -> Self {
        Self {
            phase: ProfileCircuitPhase::Closed,
            consecutive_failures: 0,
            failure_threshold: failure_threshold.max(1),
            cooldown_ms,
        }
    }

    pub(crate) fn decision(&mut self, now_ms: u64) -> ProfileCircuitDecision {
        match self.phase {
            ProfileCircuitPhase::Closed => ProfileCircuitDecision::Allow,
            ProfileCircuitPhase::Open { opened_at_ms } => {
                let elapsed = now_ms.saturating_sub(opened_at_ms);
                if elapsed >= self.cooldown_ms {
                    self.phase = ProfileCircuitPhase::HalfOpen;
                    ProfileCircuitDecision::AllowHalfOpenProbe
                } else {
                    ProfileCircuitDecision::RejectOpen {
                        retry_after_ms: self.cooldown_ms.saturating_sub(elapsed),
                    }
                }
            }
            ProfileCircuitPhase::HalfOpen => ProfileCircuitDecision::RejectHalfOpen,
        }
    }

    pub(crate) fn record_success(&mut self) {
        self.phase = ProfileCircuitPhase::Closed;
        self.consecutive_failures = 0;
    }

    pub(crate) fn record_failure(&mut self, now_ms: u64) {
        match self.phase {
            ProfileCircuitPhase::Closed => {
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                if self.consecutive_failures >= self.failure_threshold {
                    self.phase = ProfileCircuitPhase::Open {
                        opened_at_ms: now_ms,
                    };
                }
            }
            ProfileCircuitPhase::Open { .. } | ProfileCircuitPhase::HalfOpen => {
                self.consecutive_failures = self.failure_threshold;
                self.phase = ProfileCircuitPhase::Open {
                    opened_at_ms: now_ms,
                };
            }
        }
    }

    pub(crate) fn rejection_reason(&self, now_ms: u64) -> Option<String> {
        match self.phase {
            ProfileCircuitPhase::Closed => None,
            ProfileCircuitPhase::Open { opened_at_ms } => {
                let elapsed = now_ms.saturating_sub(opened_at_ms);
                (elapsed < self.cooldown_ms).then(|| {
                    format!(
                        "profile circuit open; retry after {}ms",
                        self.cooldown_ms.saturating_sub(elapsed)
                    )
                })
            }
            ProfileCircuitPhase::HalfOpen => {
                Some("profile circuit half-open probe already in flight".to_string())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    TextEmbedding,
    MultimodalEmbedding,
    TextModel,
    MultimodalModel,
    Ocr,
}

/// Runtime state for one configured capability.
///
/// `index_compatible` is meaningful for embedding capabilities. Generation and OCR
/// availability intentionally ignore it because they do not read a vector space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityState {
    pub configured: bool,
    pub healthy: bool,
    pub circuit_open: bool,
    pub protocol_compatible: bool,
    pub index_compatible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl CapabilityState {
    pub const fn unavailable() -> Self {
        Self {
            configured: false,
            healthy: false,
            circuit_open: false,
            protocol_compatible: true,
            index_compatible: true,
            reason: None,
        }
    }

    pub const fn available() -> Self {
        Self {
            configured: true,
            healthy: true,
            circuit_open: false,
            protocol_compatible: true,
            index_compatible: true,
            reason: None,
        }
    }

    pub fn runtime_available(&self) -> bool {
        self.configured && self.healthy && !self.circuit_open && self.protocol_compatible
    }

    pub fn embedding_available(&self) -> bool {
        self.runtime_available() && self.index_compatible
    }
}

impl Default for CapabilityState {
    fn default() -> Self {
        Self::unavailable()
    }
}

/// Immutable per-request capability snapshot. A UI model switch creates a new snapshot
/// for the next request and never mutates an in-flight plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub text_embedding: CapabilityState,
    pub multimodal_embedding: CapabilityState,
    pub text_model: CapabilityState,
    pub multimodal_model: CapabilityState,
    pub ocr: CapabilityState,
}

impl CapabilitySnapshot {
    pub fn state(&self, kind: CapabilityKind) -> &CapabilityState {
        match kind {
            CapabilityKind::TextEmbedding => &self.text_embedding,
            CapabilityKind::MultimodalEmbedding => &self.multimodal_embedding,
            CapabilityKind::TextModel => &self.text_model,
            CapabilityKind::MultimodalModel => &self.multimodal_model,
            CapabilityKind::Ocr => &self.ocr,
        }
    }

    pub fn is_available(&self, kind: CapabilityKind) -> bool {
        match kind {
            CapabilityKind::TextEmbedding | CapabilityKind::MultimodalEmbedding => {
                self.state(kind).embedding_available()
            }
            CapabilityKind::TextModel | CapabilityKind::MultimodalModel | CapabilityKind::Ocr => {
                self.state(kind).runtime_available()
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryModality {
    Text,
    Image,
    Mixed,
}

impl QueryModality {
    pub const fn has_text(self) -> bool {
        matches!(self, Self::Text | Self::Mixed)
    }

    pub const fn has_image(self) -> bool {
        matches!(self, Self::Image | Self::Mixed)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActiveGenerationModel {
    Text,
    Multimodal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationRoute {
    TextModelDirect,
    MultimodalModelDirect,
    MultimodalObservationThenTextModel,
    OcrThenTextModel,
    TextModelWithoutImage,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPlan {
    pub route: GenerationRoute,
    pub active_model: Option<ActiveGenerationModel>,
    pub fallback_from: Option<ActiveGenerationModel>,
    /// True only when original image bytes are sent directly to a multimodal model.
    pub sends_original_images: bool,
    /// OCR is a text-model fallback and never a prerequisite for MM or ME.
    pub uses_ocr: bool,
    pub degraded: bool,
}

pub fn plan_generation(
    snapshot: &CapabilitySnapshot,
    requested_active: Option<ActiveGenerationModel>,
    query: QueryModality,
) -> GenerationPlan {
    let tm = snapshot.is_available(CapabilityKind::TextModel);
    let mm = snapshot.is_available(CapabilityKind::MultimodalModel);
    let ocr = snapshot.is_available(CapabilityKind::Ocr);
    let has_image = query.has_image();

    let selected = requested_active.or({
        if has_image && mm {
            Some(ActiveGenerationModel::Multimodal)
        } else if tm {
            Some(ActiveGenerationModel::Text)
        } else if mm {
            Some(ActiveGenerationModel::Multimodal)
        } else {
            None
        }
    });

    match selected {
        Some(ActiveGenerationModel::Multimodal) if mm => GenerationPlan {
            route: GenerationRoute::MultimodalModelDirect,
            active_model: selected,
            fallback_from: None,
            sends_original_images: has_image,
            uses_ocr: false,
            degraded: false,
        },
        Some(ActiveGenerationModel::Multimodal) if tm => {
            let (route, uses_ocr, degraded) = if !has_image {
                (GenerationRoute::TextModelDirect, false, true)
            } else if ocr {
                (GenerationRoute::OcrThenTextModel, true, true)
            } else {
                (GenerationRoute::TextModelWithoutImage, false, true)
            };
            GenerationPlan {
                route,
                active_model: Some(ActiveGenerationModel::Text),
                fallback_from: Some(ActiveGenerationModel::Multimodal),
                sends_original_images: false,
                uses_ocr,
                degraded,
            }
        }
        Some(ActiveGenerationModel::Text) if tm => {
            let (route, sends_original_images, uses_ocr, degraded) = if !has_image {
                (GenerationRoute::TextModelDirect, false, false, false)
            } else if mm {
                (
                    GenerationRoute::MultimodalObservationThenTextModel,
                    true,
                    false,
                    false,
                )
            } else if ocr {
                (GenerationRoute::OcrThenTextModel, false, true, true)
            } else {
                (GenerationRoute::TextModelWithoutImage, false, false, true)
            };
            GenerationPlan {
                route,
                active_model: selected,
                fallback_from: None,
                sends_original_images,
                uses_ocr,
                degraded,
            }
        }
        Some(ActiveGenerationModel::Text) if mm => GenerationPlan {
            route: GenerationRoute::MultimodalModelDirect,
            active_model: Some(ActiveGenerationModel::Multimodal),
            fallback_from: Some(ActiveGenerationModel::Text),
            sends_original_images: has_image,
            uses_ocr: false,
            degraded: true,
        },
        _ => GenerationPlan {
            route: GenerationRoute::Unavailable,
            active_model: None,
            fallback_from: selected,
            sends_original_images: false,
            uses_ocr: false,
            degraded: true,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProfileCapability {
    pub profile_id: String,
    pub dimension: usize,
    pub modality: String,
    pub embedding_protocol: String,
    pub model_config_id: Option<String>,
    /// Fingerprint of the exact runtime configuration observed by the capability snapshot.
    /// Vector routes freeze this value so a reused config ID cannot silently switch spaces
    /// between planning and Lance lookup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_model_fingerprint: Option<String>,
    pub configured: bool,
    pub active: bool,
    pub healthy: bool,
    pub circuit_open: bool,
    pub protocol_compatible: bool,
    pub index_compatible: bool,
    pub weight: f64,
}

impl IndexProfileCapability {
    pub fn usable(&self) -> bool {
        self.configured
            && self.active
            && self.healthy
            && !self.circuit_open
            && self.protocol_compatible
            && self.index_compatible
            && self.dimension > 0
            && self
                .model_config_id
                .as_ref()
                .is_some_and(|id| !id.is_empty())
            && self
                .runtime_model_fingerprint
                .as_ref()
                .is_some_and(|fingerprint| !fingerprint.is_empty())
    }

    fn is_text_protocol(&self) -> bool {
        self.modality == "text" && self.embedding_protocol == "text-embedding-v1"
    }

    fn is_multimodal_protocol(&self) -> bool {
        matches!(self.modality.as_str(), "multimodal" | "image")
            && self.embedding_protocol == "multimodal-embedding-v1"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalRouteKind {
    FullText,
    TextEmbedding,
    MultimodalText,
    MultimodalImage,
}

/// How an image was converted into text before a lexical/text-embedding route.
///
/// This is deliberately separate from [`RetrievalRouteKind`]: MM observation and OCR
/// produce a query, not knowledge-base candidates. Keeping the origin typed prevents a
/// derived query from being reported as if it were the user's original text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryDerivationKind {
    MultimodalObservation,
    Ocr,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDerivationProvenance {
    pub kind: QueryDerivationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_config_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedQueryDerivation {
    pub kind: QueryDerivationKind,
    /// The stage runs only when no ME image route produced candidates.
    pub conditional_on_image_embedding_miss: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedRetrievalRoute {
    pub route_id: String,
    pub kind: RetrievalRouteKind,
    pub profile_id: Option<String>,
    pub model_config_id: Option<String>,
    /// Runtime fingerprint captured when this route was planned. It must still match after
    /// query-vector generation and immediately before the profile table is searched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_model_fingerprint: Option<String>,
    pub dimension: Option<usize>,
    pub modality: String,
    pub weight: f64,
    pub fetch_limit: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_derivation: Option<QueryDerivationProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalPlan {
    pub query_modality: QueryModality,
    pub top_k: usize,
    pub routes: Vec<PlannedRetrievalRoute>,
    /// Ordered, conditional image-to-text fallback. ME is always attempted first when
    /// available; MM observes original pixels, and OCR is attempted only after MM failure.
    #[serde(default)]
    pub image_fallback_chain: Vec<PlannedQueryDerivation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_fallback_unavailable_reason: Option<String>,
}

/// Plan independent candidate routes plus a conditional image-to-text derivation chain.
/// MM/OCR are not candidate routes: they may derive a text query only after every direct
/// ME image route fails to produce candidates.
pub fn plan_retrieval(
    snapshot: &CapabilitySnapshot,
    query_modality: QueryModality,
    profiles: &[IndexProfileCapability],
    top_k: usize,
) -> RetrievalPlan {
    let top_k = top_k.max(1);
    let fetch_limit = top_k
        .saturating_mul(DEFAULT_OVERSAMPLE_FACTOR)
        .clamp(top_k, 500);
    let mut routes = Vec::new();
    if query_modality.has_text() {
        routes.push(PlannedRetrievalRoute {
            route_id: "fts".to_string(),
            kind: RetrievalRouteKind::FullText,
            profile_id: None,
            model_config_id: None,
            expected_model_fingerprint: None,
            dimension: None,
            modality: "text".to_string(),
            weight: 1.0,
            fetch_limit,
            query_derivation: None,
        });
    }

    for profile in profiles.iter().filter(|profile| profile.usable()) {
        if profile.is_text_protocol()
            && query_modality.has_text()
            && snapshot.is_available(CapabilityKind::TextEmbedding)
        {
            routes.push(profile_route(
                profile,
                RetrievalRouteKind::TextEmbedding,
                fetch_limit,
            ));
        } else if profile.is_multimodal_protocol()
            && snapshot.is_available(CapabilityKind::MultimodalEmbedding)
        {
            if query_modality.has_text() {
                routes.push(profile_route(
                    profile,
                    RetrievalRouteKind::MultimodalText,
                    fetch_limit,
                ));
            }
            if query_modality.has_image() {
                routes.push(profile_route(
                    profile,
                    RetrievalRouteKind::MultimodalImage,
                    fetch_limit,
                ));
            }
        }
    }

    normalize_route_family_weights(&mut routes);

    let mut image_fallback_chain = Vec::new();
    if query_modality.has_image() {
        if snapshot.is_available(CapabilityKind::MultimodalModel) {
            image_fallback_chain.push(PlannedQueryDerivation {
                kind: QueryDerivationKind::MultimodalObservation,
                conditional_on_image_embedding_miss: true,
            });
        }
        if snapshot.is_available(CapabilityKind::Ocr) {
            image_fallback_chain.push(PlannedQueryDerivation {
                kind: QueryDerivationKind::Ocr,
                conditional_on_image_embedding_miss: true,
            });
        }
    }
    let image_fallback_unavailable_reason =
        (query_modality.has_image() && image_fallback_chain.is_empty()).then(|| {
            "no healthy multimodal observation model or OCR engine is available if image embedding misses"
                .to_string()
        });

    RetrievalPlan {
        query_modality,
        top_k,
        routes,
        image_fallback_chain,
        image_fallback_unavailable_reason,
    }
}

/// Keep one fixed RRF budget per route family even when rolling profiles or a derived
/// image query add more routes. The runtime calls this again after appending fallback routes.
pub(crate) fn normalize_route_family_weights(routes: &mut [PlannedRetrievalRoute]) {
    for (kind, family_budget) in [
        (RetrievalRouteKind::FullText, FTS_FAMILY_WEIGHT),
        (
            RetrievalRouteKind::TextEmbedding,
            TEXT_EMBEDDING_FAMILY_WEIGHT,
        ),
        (
            RetrievalRouteKind::MultimodalText,
            MULTIMODAL_TEXT_FAMILY_WEIGHT,
        ),
        (
            RetrievalRouteKind::MultimodalImage,
            MULTIMODAL_IMAGE_FAMILY_WEIGHT,
        ),
    ] {
        let total = routes
            .iter()
            .filter(|route| route.kind == kind)
            .map(|route| route.weight)
            .filter(|weight| weight.is_finite() && *weight > 0.0)
            .sum::<f64>();
        if total <= 0.0 {
            continue;
        }
        for route in routes.iter_mut().filter(|route| route.kind == kind) {
            route.weight = family_budget * route.weight / total;
        }
    }
}

fn profile_route(
    profile: &IndexProfileCapability,
    kind: RetrievalRouteKind,
    fetch_limit: usize,
) -> PlannedRetrievalRoute {
    PlannedRetrievalRoute {
        route_id: format!("{:?}:{}", kind, profile.profile_id).to_ascii_lowercase(),
        kind,
        profile_id: Some(profile.profile_id.clone()),
        model_config_id: profile.model_config_id.clone(),
        expected_model_fingerprint: profile.runtime_model_fingerprint.clone(),
        dimension: Some(profile.dimension),
        modality: profile.modality.clone(),
        weight: if profile.weight.is_finite() && profile.weight > 0.0 {
            profile.weight
        } else {
            1.0
        },
        fetch_limit,
        query_derivation: None,
    }
}

/// Build lexical/TE routes for text derived from an image. ME-text is intentionally excluded:
/// the fallback exists because direct ME image routes were unavailable, failed, or returned no
/// candidates, so retrying the same ME family with synthetic text is neither stable nor cheap.
pub fn plan_derived_text_routes(
    snapshot: &CapabilitySnapshot,
    profiles: &[IndexProfileCapability],
    top_k: usize,
    provenance: QueryDerivationProvenance,
) -> Vec<PlannedRetrievalRoute> {
    let suffix = match provenance.kind {
        QueryDerivationKind::MultimodalObservation => "mm_observation",
        QueryDerivationKind::Ocr => "ocr",
    };
    let mut routes = plan_retrieval(snapshot, QueryModality::Text, profiles, top_k)
        .routes
        .into_iter()
        .filter(|route| {
            matches!(
                route.kind,
                RetrievalRouteKind::FullText | RetrievalRouteKind::TextEmbedding
            )
        })
        .collect::<Vec<_>>();
    for route in &mut routes {
        route.route_id = format!("derived_{}:{}", suffix, route.route_id);
        route.query_derivation = Some(provenance.clone());
    }
    normalize_route_family_weights(&mut routes);
    routes
}

/// A semantic unit identity. Different chunks or pages of one resource must not collapse.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalIdentity {
    pub resource_id: String,
    pub chunk_index: i32,
    pub page_index: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalHit {
    pub identity: RetrievalIdentity,
    pub embedding_id: String,
    pub text: String,
    pub title: Option<String>,
    pub resource_type: Option<String>,
    pub source_id: Option<String>,
    pub folder_id: Option<String>,
    pub blob_hash: Option<String>,
    pub image_url: Option<String>,
    pub raw_score: Option<f64>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalRouteResult {
    pub route: PlannedRetrievalRoute,
    pub hits: Vec<RetrievalHit>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalRouteFailure {
    pub route_id: String,
    pub profile_id: Option<String>,
    pub dimension: Option<usize>,
    pub error: String,
    pub timed_out: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_derivation: Option<QueryDerivationProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalHitProvenance {
    pub route_id: String,
    pub route_kind: RetrievalRouteKind,
    pub profile_id: Option<String>,
    pub dimension: Option<usize>,
    pub modality: String,
    pub raw_rank: usize,
    pub raw_score: Option<f64>,
    pub route_weight: f64,
    pub rrf_contribution: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_derivation: Option<QueryDerivationProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusedRetrievalHit {
    pub hit: RetrievalHit,
    pub rrf_score: f64,
    pub provenance: Vec<RetrievalHitProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusedRetrievalResult {
    pub hits: Vec<FusedRetrievalHit>,
    pub failures: Vec<RetrievalRouteFailure>,
}

/// Fuses successful routes without comparing raw scores from unrelated vector spaces.
/// Failed and timed-out routes are retained as diagnostics and do not suppress other routes.
pub fn fuse_route_results(
    route_results: Vec<Result<RetrievalRouteResult, RetrievalRouteFailure>>,
    top_k: usize,
) -> FusedRetrievalResult {
    let mut fused: HashMap<RetrievalIdentity, FusedRetrievalHit> = HashMap::new();
    let mut failures = Vec::new();

    for result in route_results {
        let route_result = match result {
            Ok(result) => result,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        let weight = if route_result.route.weight.is_finite() && route_result.route.weight > 0.0 {
            route_result.route.weight
        } else {
            1.0
        };

        for (offset, hit) in route_result.hits.into_iter().enumerate() {
            let raw_rank = offset + 1;
            let contribution = weight / (DEFAULT_RRF_K + raw_rank as f64);
            let provenance = RetrievalHitProvenance {
                route_id: route_result.route.route_id.clone(),
                route_kind: route_result.route.kind,
                profile_id: route_result.route.profile_id.clone(),
                dimension: route_result.route.dimension,
                modality: route_result.route.modality.clone(),
                raw_rank,
                raw_score: hit.raw_score,
                route_weight: weight,
                rrf_contribution: contribution,
                query_derivation: route_result.route.query_derivation.clone(),
            };
            fused
                .entry(hit.identity.clone())
                .and_modify(|current| {
                    current.rrf_score += contribution;
                    current.provenance.push(provenance.clone());
                    // Keep the richer representative without using cross-space score order.
                    if current.hit.text.is_empty() && !hit.text.is_empty() {
                        current.hit = hit.clone();
                    }
                })
                .or_insert_with(|| FusedRetrievalHit {
                    hit,
                    rrf_score: contribution,
                    provenance: vec![provenance],
                });
        }
    }

    let mut hits: Vec<_> = fused.into_values().collect();
    hits.sort_by(|left, right| {
        right
            .rrf_score
            .partial_cmp(&left.rrf_score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                left.hit
                    .identity
                    .resource_id
                    .cmp(&right.hit.identity.resource_id)
            })
            .then_with(|| {
                left.hit
                    .identity
                    .chunk_index
                    .cmp(&right.hit.identity.chunk_index)
            })
            .then_with(|| {
                left.hit
                    .identity
                    .page_index
                    .cmp(&right.hit.identity.page_index)
            })
    });
    hits.truncate(top_k);

    FusedRetrievalResult { hits, failures }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(mask: u8) -> CapabilitySnapshot {
        let state = |bit: u8| {
            if mask & (1u8 << bit) != 0 {
                CapabilityState::available()
            } else {
                CapabilityState::unavailable()
            }
        };
        CapabilitySnapshot {
            text_embedding: state(0),
            multimodal_embedding: state(1),
            text_model: state(2),
            multimodal_model: state(3),
            ocr: state(4),
        }
    }

    fn profile(id: &str, modality: &str, protocol: &str) -> IndexProfileCapability {
        IndexProfileCapability {
            profile_id: id.to_string(),
            dimension: 1024,
            modality: modality.to_string(),
            embedding_protocol: protocol.to_string(),
            model_config_id: Some(format!("model-{id}")),
            runtime_model_fingerprint: Some(format!("fingerprint-{id}")),
            configured: true,
            active: true,
            healthy: true,
            circuit_open: false,
            protocol_compatible: true,
            index_compatible: true,
            weight: 1.0,
        }
    }

    fn expected_generation(
        mask: u8,
        active: Option<ActiveGenerationModel>,
        query: QueryModality,
    ) -> (GenerationRoute, bool, bool) {
        let tm = mask & (1u8 << 2) != 0;
        let mm = mask & (1u8 << 3) != 0;
        let ocr = mask & (1u8 << 4) != 0;
        let image = query.has_image();
        match active {
            Some(ActiveGenerationModel::Multimodal) if mm => {
                (GenerationRoute::MultimodalModelDirect, image, false)
            }
            Some(ActiveGenerationModel::Multimodal) if tm && !image => {
                (GenerationRoute::TextModelDirect, false, false)
            }
            Some(ActiveGenerationModel::Multimodal) if tm && ocr => {
                (GenerationRoute::OcrThenTextModel, false, true)
            }
            Some(ActiveGenerationModel::Multimodal) if tm => {
                (GenerationRoute::TextModelWithoutImage, false, false)
            }
            Some(ActiveGenerationModel::Text) if tm && !image => {
                (GenerationRoute::TextModelDirect, false, false)
            }
            Some(ActiveGenerationModel::Text) if tm && mm => (
                GenerationRoute::MultimodalObservationThenTextModel,
                true,
                false,
            ),
            Some(ActiveGenerationModel::Text) if tm && ocr => {
                (GenerationRoute::OcrThenTextModel, false, true)
            }
            Some(ActiveGenerationModel::Text) if tm => {
                (GenerationRoute::TextModelWithoutImage, false, false)
            }
            Some(ActiveGenerationModel::Text) if mm => {
                (GenerationRoute::MultimodalModelDirect, image, false)
            }
            None if image && mm => (GenerationRoute::MultimodalModelDirect, true, false),
            None if tm && !image => (GenerationRoute::TextModelDirect, false, false),
            None if tm && ocr => (GenerationRoute::OcrThenTextModel, false, true),
            None if tm => (GenerationRoute::TextModelWithoutImage, false, false),
            None if mm => (GenerationRoute::MultimodalModelDirect, false, false),
            _ => (GenerationRoute::Unavailable, false, false),
        }
    }

    #[test]
    fn all_32_capability_subsets_match_exact_generation_and_retrieval_matrix() {
        let profiles = [
            profile("te", "text", "text-embedding-v1"),
            profile("me", "multimodal", "multimodal-embedding-v1"),
        ];
        for mask in 0u8..32 {
            let capabilities = snapshot(mask);
            let has_te = mask & 1 != 0;
            let has_me = mask & 2 != 0;
            let has_mm = mask & (1u8 << 3) != 0;
            let has_ocr = mask & (1u8 << 4) != 0;

            for query in [
                QueryModality::Text,
                QueryModality::Image,
                QueryModality::Mixed,
            ] {
                for active in [
                    None,
                    Some(ActiveGenerationModel::Text),
                    Some(ActiveGenerationModel::Multimodal),
                ] {
                    let plan = plan_generation(&capabilities, active, query);
                    let (expected_route, expected_images, expected_ocr) =
                        expected_generation(mask, active, query);
                    assert_eq!(
                        (plan.route, plan.sends_original_images, plan.uses_ocr),
                        (expected_route, expected_images, expected_ocr),
                        "generation mismatch for mask={mask:05b}, query={query:?}, active={active:?}"
                    );
                }

                let retrieval = plan_retrieval(&capabilities, query, &profiles, 10);
                let mut expected_routes = Vec::new();
                if query.has_text() {
                    expected_routes.push(RetrievalRouteKind::FullText);
                    if has_te {
                        expected_routes.push(RetrievalRouteKind::TextEmbedding);
                    }
                    if has_me {
                        expected_routes.push(RetrievalRouteKind::MultimodalText);
                    }
                }
                if query.has_image() && has_me {
                    expected_routes.push(RetrievalRouteKind::MultimodalImage);
                }
                assert_eq!(
                    retrieval
                        .routes
                        .iter()
                        .map(|route| route.kind)
                        .collect::<Vec<_>>(),
                    expected_routes,
                    "retrieval mismatch for mask={mask:05b}, query={query:?}"
                );

                let mut expected_fallback = Vec::new();
                if query.has_image() && has_mm {
                    expected_fallback.push(QueryDerivationKind::MultimodalObservation);
                }
                if query.has_image() && has_ocr {
                    expected_fallback.push(QueryDerivationKind::Ocr);
                }
                assert_eq!(
                    retrieval
                        .image_fallback_chain
                        .iter()
                        .map(|stage| stage.kind)
                        .collect::<Vec<_>>(),
                    expected_fallback,
                    "fallback mismatch for mask={mask:05b}, query={query:?}"
                );
                assert_eq!(
                    retrieval.image_fallback_unavailable_reason.is_some(),
                    query.has_image() && !has_mm && !has_ocr,
                    "fallback availability mismatch for mask={mask:05b}, query={query:?}"
                );
            }
        }
    }

    #[test]
    fn active_mm_receives_original_image_and_never_uses_ocr() {
        let capabilities = snapshot((1 << 3) | (1 << 4));
        let plan = plan_generation(
            &capabilities,
            Some(ActiveGenerationModel::Multimodal),
            QueryModality::Image,
        );
        assert_eq!(plan.route, GenerationRoute::MultimodalModelDirect);
        assert!(plan.sends_original_images);
        assert!(!plan.uses_ocr);
    }

    #[test]
    fn active_tm_prefers_mm_observation_then_ocr() {
        let both = snapshot((1 << 2) | (1 << 3) | (1 << 4));
        let plan = plan_generation(
            &both,
            Some(ActiveGenerationModel::Text),
            QueryModality::Image,
        );
        assert_eq!(
            plan.route,
            GenerationRoute::MultimodalObservationThenTextModel
        );
        assert!(!plan.uses_ocr);

        let ocr_only = snapshot((1 << 2) | (1 << 4));
        let fallback = plan_generation(
            &ocr_only,
            Some(ActiveGenerationModel::Text),
            QueryModality::Image,
        );
        assert_eq!(fallback.route, GenerationRoute::OcrThenTextModel);
        assert!(fallback.uses_ocr);
    }

    #[test]
    fn image_retrieval_never_routes_through_text_embedding_or_ocr() {
        let capabilities = snapshot(0b1_1111);
        let plan = plan_retrieval(
            &capabilities,
            QueryModality::Image,
            &[
                profile("te", "text", "text-embedding-v1"),
                profile("me", "multimodal", "multimodal-embedding-v1"),
            ],
            5,
        );
        assert_eq!(
            plan.routes
                .iter()
                .map(|route| route.kind)
                .collect::<Vec<_>>(),
            vec![RetrievalRouteKind::MultimodalImage]
        );
    }

    #[test]
    fn unhealthy_or_incompatible_capability_keeps_fts_alive() {
        let mut capabilities = snapshot(0b11);
        capabilities.text_embedding.circuit_open = true;
        capabilities.multimodal_embedding.protocol_compatible = false;
        let plan = plan_retrieval(
            &capabilities,
            QueryModality::Mixed,
            &[
                profile("te", "text", "text-embedding-v1"),
                profile("me", "multimodal", "multimodal-embedding-v1"),
            ],
            10,
        );
        assert_eq!(plan.routes.len(), 1);
        assert_eq!(plan.routes[0].kind, RetrievalRouteKind::FullText);
    }

    fn hit(resource: &str, chunk: i32, page: Option<i32>, score: f64) -> RetrievalHit {
        RetrievalHit {
            identity: RetrievalIdentity {
                resource_id: resource.to_string(),
                chunk_index: chunk,
                page_index: page,
            },
            embedding_id: format!("{resource}-{chunk}-{:?}", page),
            text: format!("text-{chunk}"),
            title: None,
            resource_type: None,
            source_id: None,
            folder_id: None,
            blob_hash: None,
            image_url: None,
            raw_score: Some(score),
            metadata: Value::Null,
        }
    }

    fn route(id: &str) -> PlannedRetrievalRoute {
        PlannedRetrievalRoute {
            route_id: id.to_string(),
            kind: RetrievalRouteKind::TextEmbedding,
            profile_id: Some(id.to_string()),
            model_config_id: Some(format!("model-{id}")),
            expected_model_fingerprint: Some(format!("fingerprint-{id}")),
            dimension: Some(1024),
            modality: "text".to_string(),
            weight: 1.0,
            fetch_limit: 30,
            query_derivation: None,
        }
    }

    #[test]
    fn rrf_does_not_merge_distinct_chunks_or_pages_of_same_resource() {
        let result = fuse_route_results(
            vec![Ok(RetrievalRouteResult {
                route: route("te"),
                hits: vec![
                    hit("resource", 0, Some(0), 0.9),
                    hit("resource", 1, Some(0), 0.8),
                    hit("resource", 0, Some(1), 0.7),
                ],
                elapsed_ms: 1,
            })],
            10,
        );
        assert_eq!(result.hits.len(), 3);
    }

    #[test]
    fn rrf_fuses_same_unit_without_comparing_raw_scores() {
        let result = fuse_route_results(
            vec![
                Ok(RetrievalRouteResult {
                    route: route("te"),
                    hits: vec![hit("shared", 0, Some(0), 0.01)],
                    elapsed_ms: 1,
                }),
                Ok(RetrievalRouteResult {
                    route: route("me"),
                    hits: vec![hit("shared", 0, Some(0), 999.0)],
                    elapsed_ms: 1,
                }),
            ],
            10,
        );
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].provenance.len(), 2);
        assert_eq!(result.hits[0].provenance[0].raw_score, Some(0.01));
        assert_eq!(result.hits[0].provenance[1].raw_score, Some(999.0));
    }

    #[test]
    fn failed_route_does_not_discard_successful_routes() {
        let result = fuse_route_results(
            vec![
                Err(RetrievalRouteFailure {
                    route_id: "broken".to_string(),
                    profile_id: Some("broken-profile".to_string()),
                    dimension: Some(768),
                    error: "timeout".to_string(),
                    timed_out: true,
                    query_derivation: None,
                }),
                Ok(RetrievalRouteResult {
                    route: route("healthy"),
                    hits: vec![hit("resource", 0, None, 0.5)],
                    elapsed_ms: 2,
                }),
            ],
            10,
        );
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.failures.len(), 1);
        assert!(result.failures[0].timed_out);
    }

    #[test]
    fn strict_protocol_prevents_text_api_from_impersonating_image_embedding() {
        let capabilities = snapshot(0b11);
        let mislabeled = profile("bad", "multimodal", "text-embedding-v1");
        let plan = plan_retrieval(&capabilities, QueryModality::Image, &[mislabeled], 10);
        assert!(plan.routes.is_empty());
    }

    #[test]
    fn route_family_budget_is_stable_when_profiles_are_duplicated() {
        let capabilities = snapshot(0b11);
        let single = plan_retrieval(
            &capabilities,
            QueryModality::Text,
            &[
                profile("te-a", "text", "text-embedding-v1"),
                profile("me", "multimodal", "multimodal-embedding-v1"),
            ],
            10,
        );
        let duplicated = plan_retrieval(
            &capabilities,
            QueryModality::Text,
            &[
                profile("te-a", "text", "text-embedding-v1"),
                profile("te-b", "text", "text-embedding-v1"),
                profile("me", "multimodal", "multimodal-embedding-v1"),
            ],
            10,
        );

        let family_weight = |plan: &RetrievalPlan, kind| {
            plan.routes
                .iter()
                .filter(|route| route.kind == kind)
                .map(|route| route.weight)
                .sum::<f64>()
        };
        for kind in [
            RetrievalRouteKind::FullText,
            RetrievalRouteKind::TextEmbedding,
            RetrievalRouteKind::MultimodalText,
        ] {
            assert!((family_weight(&single, kind) - 1.0).abs() < f64::EPSILON);
            assert!((family_weight(&duplicated, kind) - 1.0).abs() < f64::EPSILON);
        }
        let duplicated_te_weights = duplicated
            .routes
            .iter()
            .filter(|route| route.kind == RetrievalRouteKind::TextEmbedding)
            .map(|route| route.weight)
            .collect::<Vec<_>>();
        assert_eq!(duplicated_te_weights, vec![0.5, 0.5]);
    }

    #[test]
    fn profile_circuit_breaker_opens_cools_down_and_allows_one_probe() {
        let mut breaker = ProfileCircuitBreaker::new(3, 100);
        breaker.record_failure(0);
        breaker.record_failure(1);
        assert_eq!(breaker.decision(2), ProfileCircuitDecision::Allow);

        breaker.record_failure(2);
        assert_eq!(
            breaker.decision(50),
            ProfileCircuitDecision::RejectOpen { retry_after_ms: 52 }
        );
        assert_eq!(
            breaker.decision(102),
            ProfileCircuitDecision::AllowHalfOpenProbe
        );
        assert_eq!(
            breaker.decision(102),
            ProfileCircuitDecision::RejectHalfOpen
        );

        breaker.record_failure(103);
        assert!(breaker.rejection_reason(150).is_some());
        assert_eq!(
            breaker.decision(203),
            ProfileCircuitDecision::AllowHalfOpenProbe
        );
        breaker.record_success();
        assert_eq!(breaker.decision(204), ProfileCircuitDecision::Allow);
        assert!(breaker.rejection_reason(204).is_none());
    }
}
