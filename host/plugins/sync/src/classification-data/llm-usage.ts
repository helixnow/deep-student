import type { TableClassification } from '../classification.ts';

export const entries: TableClassification[] = [
  {
        database: "llm_usage",
        table_name: "llm_usage_logs",
        primary_key: "id",
        category: "RowSync",
        conflict_policy: "Lww",
        business_unique_keys: "",
        has_json_blobs: false,
        merge_notes:
          "Usage logs with GENERATED columns (date_key, hour_key STORED)",
      },
  {
        database: "llm_usage",
        table_name: "llm_usage_daily",
        primary_key: "date,caller_type,model,provider",
        category: "DerivedRebuild",
        conflict_policy: "NoConflict",
        business_unique_keys: "",
        has_json_blobs: false,
        merge_notes: "Pre-aggregated; fully rebuildable from llm_usage_logs",
      },
];
