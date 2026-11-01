// 同步引擎的 app 侧单测：依赖 app 的 memory（`LearnerProfile`）与 app 组合根
// （`crate::extensions::register_extensions` 注册的 `SyncFieldMerger`），无法随
// `data_governance::sync` 进入 dstu-sync。

// 拆分前位于 `data_governance::sync::field_merge::tests`；函数名与断言不变，
// 开头先接线扩展点（与拆分前直接调用 memory 的行为一致）。
#[cfg(test)]
mod field_merge_app_tests {
    use crate::data_governance::sync::field_merge::merge_field;
    use serde_json::json;

    #[test]
    fn regression_j8c_resources_data_merges_learner_profiles() {
        crate::extensions::register_extensions();
        use crate::memory::learner_profile::LearnerProfile;

        let mut local = LearnerProfile {
            version: 3,
            updated_at: "2026-07-19T10:00:00+00:00".to_string(),
            ..Default::default()
        };
        local
            .goals
            .push(crate::memory::learner_profile::LearningGoal {
                goal: "本地目标".to_string(),
                deadline: None,
            });
        let mut remote = LearnerProfile {
            version: 4,
            updated_at: "2026-07-19T11:00:00+00:00".to_string(),
            ..Default::default()
        };
        remote
            .goals
            .push(crate::memory::learner_profile::LearningGoal {
                goal: "远端目标".to_string(),
                deadline: None,
            });

        let (result, changed, conflict) = merge_field(
            "resources",
            "data",
            Some(&json!(local.to_json())),
            Some(&json!(remote.to_json())),
        );
        assert!(changed);
        assert!(!conflict);
        let merged = LearnerProfile::from_json(result.as_str().unwrap()).unwrap();
        assert_eq!(merged.version, 5);
        assert!(merged.goals.iter().any(|g| g.goal == "本地目标"));
        assert!(merged.goals.iter().any(|g| g.goal == "远端目标"));
    }
}
