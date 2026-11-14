
        CREATE TABLE IF NOT EXISTS __audit_log (
            id TEXT PRIMARY KEY NOT NULL,
            timestamp TEXT NOT NULL,
            operation_type TEXT NOT NULL,
            operation_data TEXT NOT NULL,
            target TEXT NOT NULL,
            status TEXT NOT NULL,
            duration_ms INTEGER,
            details TEXT,
            error_message TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON __audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_log_operation_type ON __audit_log(operation_type);
        CREATE INDEX IF NOT EXISTS idx_audit_log_status ON __audit_log(status);
    
