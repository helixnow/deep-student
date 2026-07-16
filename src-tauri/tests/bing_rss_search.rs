use deep_student_lib::tools::web_search::{do_search, SearchInput, ToolConfig};

#[tokio::test]
#[ignore = "requires access to the public Bing RSS endpoint"]
async fn bing_rss_returns_search_citations_without_api_key() {
    let mut config = ToolConfig::default();
    config.timeout_ms = Some(10_000);

    let result = do_search(
        &config,
        SearchInput {
            query: "Deep Student AI".into(),
            top_k: 3,
            engine: Some("bing_rss".into()),
            site: None,
            time_range: None,
            start: None,
            force_engine: None,
        },
    )
    .await;

    assert!(result.ok, "search failed: {:?}", result.error);
    assert_eq!(
        result
            .usage
            .as_ref()
            .and_then(|usage| usage.get("provider"))
            .and_then(|provider| provider.as_str()),
        Some("bing_rss")
    );
    assert!(
        result.citations.is_some_and(|citations| !citations.is_empty()),
        "Bing RSS returned no citations"
    );
}
