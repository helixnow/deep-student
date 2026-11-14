# L15-review-analytics 测试去向（`host/plugins/review`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L15-review-analytics：128 行（真实测试 128）· pending 7 · ported 121
<!-- END GENERATED:testmap:header -->

> 注（WP-113，生成区外）：上方表头 “pending 7 · ported 121” 已过时；按下方行实际计数为
> **123 ported / 5 pending**（共 128 行）。表头由 scaffold 重建，本 lane 不手改生成区。

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::new_good_enters_learning_ten_minutes` | test | L5537 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::again_on_review_relearns_after_ten_minutes` | test | L5557 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::hard_and_easy_adjust_intervals` | test | L5581 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::preview_intervals_returns_four_ratings` | test | L5613 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_with_same_client_op_id_is_idempotent` | test | L5652 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::malformed_client_op_id_is_rejected_without_rating` | test | L5694 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_client_op_id_rejects_card_mismatch` | test | L5715 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_client_op_id_rejects_reuse_after_undo` | test | L5743 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_cas_rejects_stale_expected_last_review` | test | L5769 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::mastery_bias_advances_low_score_and_caps_high_interval` | test | L5791 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_with_mastery_bias_persists_advanced_due` | test | L5831 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::committed_review_remains_in_mastery_outbox_until_marked` | test | L5928 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::undo_still_works_after_mastery_outbox_mark_synced` | test | L5946 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::undo_of_unsynced_review_remains_a_durable_revert_pending` | test | L5962 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::params_version_marks_fsrs_rs_scheduler` | test | L5980 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::review_day_bounds_follow_user_timezone` | test | L5985 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::untagged_cards_fall_back_to_document_name_for_mastery_concepts` | test | L6063 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::scheduler_config_partial_update_preserves_unknown_keys` | test | L6144 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::desired_retention_config_flows_into_enqueue_rating_and_preview` | test | L6223 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::stats_expose_quota_hidden_backlog` | test | L6289 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::review_statistics_aggregate_logs_limits_and_forecast` | test | L6317 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::retention_counts_only_first_review_per_card_per_day` | test | L6349 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::memory_overview_lists_recent_cards_and_average_retrievability` | test | L6385 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::memory_overview_without_reviews_has_no_average` | test | L6480 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::card_memory_history_returns_reviews_in_order` | test | L6497 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::reset_card_progress_clears_history_and_rebuilds_new_state` | test | L6546 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::session_enqueue_succeeds_then_skips_existing_state` | test | L6608 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::enqueue_result_and_event_cards_distinguish_new_from_skipped_states` | test | L6651 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::enqueue_rolls_back_when_review_card_snapshot_is_invalid` | test | L6767 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::session_enqueue_rolls_back_mixed_owner_batch` | test | L6799 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::document_selector_reloads_more_than_one_hundred_live_cards` | test | L6819 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::document_selector_ignores_soft_deleted_cards_during_transaction_reload` | test | L6851 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::document_selector_excludes_diagnostic_cards` | test | L6881 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::explicit_card_ids_reject_diagnostic_card_atomically` | test | L6914 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_rejects_card_that_became_diagnostic_without_mutating_state_or_logs` | test | L6970 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::due_and_stats_hide_card_that_became_diagnostic_after_enqueue` | test | L7074 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::soft_deleted_card_is_hidden_from_agent_crud_and_fsrs` | test | L7150 | pending |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::soft_deleted_document_task_is_hidden_and_cannot_be_recovered_or_mutated` | test | L7327 | pending |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::document_selector_rechecks_all_task_owners_before_writing` | test | L7542 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::stats_report_every_fsrs_bucket_and_reviews_today` | test | L7562 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::undo_snapshot_migration_is_registered_and_idempotent` | test | L7687 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_captures_complete_snapshot_and_undo_restores_every_field` | test | L7712 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::consecutive_ratings_only_allow_the_latest_log_to_be_undone` | test | L7804 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::undo_rejects_a_post_rating_suspension_without_overwriting_it` | test | L7848 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::undo_rejects_wrong_null_damaged_and_state_stale_inputs_without_writes` | test | L7883 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::suspend_and_unsuspend_are_atomic_idempotent_and_control_due_visibility` | test | L7962 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::agent_review_state_batch_read_distinguishes_unenqueued_and_latest_review` | test | L8032 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::agent_review_access_hides_mixed_owner_and_tombstoned_cards` | test | L8100 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::agent_suspension_is_versioned_idempotent_and_stale_safe` | test | L8198 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::agent_undo_restores_snapshot_and_publishes_a_new_version` | test | L8259 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::agent_undo_conflicts_on_stale_tokens_and_blocks_invalid_snapshots` | test | L8312 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::agent_review_mutations_block_diagnostic_cards_without_writes` | test | L8405 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::due_and_enqueue_serialize_complete_template_metadata_with_legacy_defaults` | test | L8474 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::chatanki_versioned_delete_cas_cleans_fsrs_without_cleanup_trigger_and_conflict_preserves_it` | test | L8571 | pending |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::migration_recovery_replays_tail_when_all_alter_columns_exist` | test | L8792 | ported:host/plugins/review/tests/fsrs-cross-domain.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::migration_recovery_replays_tail_when_only_some_alter_columns_exist` | test | L9017 | ported:host/plugins/review/tests/fsrs-cross-domain.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::deletion_paths_and_tombstones_do_not_leave_schedulable_ghosts` | test | L9049 | ported:host/plugins/review/tests/fsrs-cross-domain.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::library_scope_handles_null_and_foreign_sources_while_session_scope_rejects_them` | test | L9131 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::library_enqueue_content_cas_is_all_or_nothing` | test | L9229 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::library_undo_requires_both_current_review_version_and_latest_log` | test | L9291 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::scheduler_config_validates_and_round_trips_scheduling_fields` | test | L9425 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rate_follows_configured_learning_steps_and_undo_restores_step` | test | L9476 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::changing_parameters_recomputes_memory_states_without_moving_due` | test | L9530 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::memory_state_upgrade_runs_once_per_scheduler_version` | test | L9581 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::optimizer_reports_not_enough_data_for_a_tiny_history` | test | L9606 | ported:host/plugins/review/tests/fsrs-optimize.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::optimizer_trains_on_cross_day_history_and_keeps_due_dates` | test | L9630 | ported:host/plugins/review/tests/fsrs-optimize.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::review_statistics_report_true_retention_periods_distributions_and_study_time` | test | L9694 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::rating_buries_new_and_review_siblings_of_the_same_note` | test | L9804 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::sibling_burying_can_be_disabled` | test | L9860 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::manual_bury_hides_a_card_until_the_next_logical_day` | test | L9884 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::review_order_and_new_review_mix_follow_configuration` | test | L9910 | ported:host/plugins/review/tests/fsrs-review.test.ts |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::legacy_null_anki_json_fields_do_not_break_library_reads_or_enqueue` | test | L10090 | pending |
| `crates/dstu-anki/src/fsrs_review_service.rs::tests::agent_library_delete_conflicts_when_user_rates_after_preflight` | test | L10166 | pending |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::new_card_follows_default_learning_steps` | test | L551 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::last_learning_step_good_graduates_with_fsrs_interval` | test | L567 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::single_step_hard_is_one_and_a_half_times_capped_at_one_extra_day` | test | L594 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::single_learning_step_good_on_new_card_graduates` | test | L601 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::review_again_enters_relearning_and_counts_a_lapse` | test | L614 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::empty_relearning_steps_reschedule_lapse_in_days` | test | L624 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::relearning_good_graduates_back_to_review` | test | L636 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::review_intervals_are_strictly_increasing` | test | L656 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::maximum_interval_caps_every_passing_answer` | test | L683 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::review_on_due_day_counts_full_logical_days` | test | L698 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::same_logical_day_reviews_use_short_term_stability` | test | L718 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::rollover_hour_moves_the_day_boundary` | test | L727 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::learning_step_crossing_rollover_is_due_at_next_logical_day_start` | test | L749 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::fuzz_matches_anki_ranges` | test | L766 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::fuzz_factor_is_deterministic_and_bounded` | test | L779 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::fuzz_does_not_regress_below_elapsed_days` | test | L790 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::sanitize_steps_drops_invalid_entries` | test | L801 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::forgetting_curve_constants_follow_fsrs6_decay` | test | L809 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/fsrs_scheduler.rs::tests::missing_memory_on_learning_card_reinitializes_like_new` | test | L819 | ported:host/plugins/review/tests/fsrs-scheduler.test.ts |
| `crates/dstu-learning/src/mastery/bias.rs::tests::low_mastery_advances_due_by_assertable_fraction` | test | L136 | ported:host/plugins/review/tests/bias.test.ts |
| `crates/dstu-learning/src/mastery/bias.rs::tests::high_mastery_is_not_advanced` | test | L148 | ported:host/plugins/review/tests/bias.test.ts |
| `crates/dstu-learning/src/mastery/bias.rs::tests::bias_has_hard_cap_not_unbounded` | test | L161 | ported:host/plugins/review/tests/bias.test.ts |
| `crates/dstu-learning/src/mastery/bias.rs::tests::short_learning_steps_unbiased` | test | L170 | ported:host/plugins/review/tests/bias.test.ts |
| `crates/dstu-learning/src/mastery/bias.rs::tests::neutral_score_no_bias` | test | L181 | ported:host/plugins/review/tests/bias.test.ts |
| `crates/dstu-learning/src/mastery/bias.rs::tests::due_learning_cards_keep_priority_over_low_mastery_new` | test | L186 | ported:host/plugins/review/tests/bias.test.ts |
| `crates/dstu-learning/src/mastery/bias.rs::tests::low_mastery_priority_still_applies_within_review_cards` | test | L201 | ported:host/plugins/review/tests/bias.test.ts |
| `crates/dstu-learning/src/study_loop/media_source.rs::tests::clock_round_trips_and_switches_to_hours` | test | L231 | ported:host/plugins/review/tests/media-source.test.ts |
| `crates/dstu-learning/src/study_loop/media_source.rs::tests::parses_line_timestamps_and_ranges` | test | L243 | ported:host/plugins/review/tests/media-source.test.ts |
| `crates/dstu-learning/src/study_loop/media_source.rs::tests::finds_first_media_citation` | test | L257 | ported:host/plugins/review/tests/media-source.test.ts |
| `crates/dstu-learning/src/study_loop/media_source.rs::tests::finds_citation_seconds_for_one_resource` | test | L268 | ported:host/plugins/review/tests/media-source.test.ts |
| `crates/dstu-learning/src/study_loop/media_source.rs::tests::non_transcript_text_is_left_alone` | test | L276 | ported:host/plugins/review/tests/media-source.test.ts |
| `crates/dstu-learning/src/study_loop/media_source.rs::tests::chunks_by_600_seconds_with_anchor_and_recap` | test | L282 | ported:host/plugins/review/tests/media-source.test.ts |
| `crates/dstu-learning/src/study_loop/media_source.rs::tests::continuation_lines_stay_in_current_chunk` | test | L311 | ported:host/plugins/review/tests/media-source.test.ts |
| `crates/dstu-learning/src/study_loop/media_source.rs::tests::media_detection_reads_files_type_and_mime` | test | L319 | ported:host/plugins/review/tests/media-source.test.ts |
| `crates/dstu-learning/src/study_loop/study_time.rs::tests::migration_is_idempotent` | test | L197 | ported:host/plugins/review/tests/study-time.test.ts |
| `crates/dstu-learning/src/study_loop/study_time.rs::tests::add_accumulates_per_day_and_caps_at_one_day` | test | L203 | ported:host/plugins/review/tests/study-time.test.ts |
| `crates/dstu-learning/src/study_loop/study_time.rs::tests::range_is_inclusive_sorted_and_skips_empty_days` | test | L226 | ported:host/plugins/review/tests/study-time.test.ts |
| `crates/dstu-learning/src/study_loop/study_time.rs::tests::validation_rejects_bad_seconds_and_far_dates` | test | L258 | ported:host/plugins/review/tests/study-time.test.ts |
| `src/cmd/fsrs_review.rs::tests::changed_payload_keeps_anki_and_state_ids_distinct` | test | L616 | ported:host/plugins/review/tests/fsrs-events.test.ts |
| `src/cmd/fsrs_review.rs::tests::changed_payload_falls_back_to_requested_anki_ids_without_states` | test | L635 | ported:host/plugins/review/tests/fsrs-events.test.ts |
| `src/cmd/fsrs_review.rs::tests::changed_payload_is_suppressed_without_a_write` | test | L647 | ported:host/plugins/review/tests/fsrs-events.test.ts |
| `src/cmd/fsrs_review.rs::tests::enqueue_changed_payload_contains_only_new_state_with_card_content` | test | L656 | ported:host/plugins/review/tests/fsrs-events.test.ts |
| `src/fsrs_review_service/tests.rs::e2e_vfs_mastery_score_biases_due_and_respects_three_day_cap` | test | L38 | ported:host/plugins/review/tests/e2e-mastery-bias.test.ts |
| `src/mastery/service/tests.rs::e2e_submit_wrong_thrice_lowers_score_and_upserts_weak_point_then_recovers` | test | L115 | ported:host/plugins/review/tests/e2e-mastery-bias.test.ts |
| `src/mastery/service/tests.rs::anti_farm_same_item_rapid_corrects_gain_less_than_independent` | test | L334 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/mastery/service/tests.rs::fsrs_rating_signals_are_differentiated` | test | L399 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/mastery/service/tests.rs::fsrs_review_log_compensation_is_idempotent` | test | L454 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/mastery/service/tests.rs::qbank_verdict_correction_false_to_true_recomputes_state` | test | L498 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/mastery/service/tests.rs::qbank_verdict_correction_is_idempotent_and_supports_reflip` | test | L584 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/mastery/service/tests.rs::remote_tombstones_rebuild_zero_state_and_remove_weak_point` | test | L659 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/mastery/service/tests.rs::legacy_null_signal_rating_falls_back_to_0_35` | test | L704 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/mastery/service/tests.rs::mastery_due_bias_low_high_and_cap_on_real_sqlite_scores` | test | L736 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/mastery/service/tests.rs::overview_includes_today_priority_review` | test | L796 | ported:host/plugins/review/tests/mastery.test.ts |
| `src/review_plan_service/tests.rs::test_create_review_plan_rejects_exam_question_mismatch` | test | L29 | ported:host/plugins/review/tests/review-plan.test.ts |
| `src/review_plan_service/tests.rs::review_writes_mastery_once_and_practice_advance_does_not_double_count` | test | L94 | ported:host/plugins/review/tests/review-plan.test.ts |
<!-- END GENERATED:testmap:rows -->
