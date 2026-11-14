
            CREATE TABLE IF NOT EXISTS upload_seq (
                instance_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                last_seq INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, device_id)
            );
            CREATE TABLE IF NOT EXISTS consume_cursor (
                instance_id TEXT NOT NULL,
                uploader_device_id TEXT NOT NULL,
                last_seq INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, uploader_device_id)
            );
            CREATE TABLE IF NOT EXISTS legacy_processed_key (
                instance_id TEXT NOT NULL,
                object_key TEXT NOT NULL,
                processed_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, object_key)
            );
            CREATE TABLE IF NOT EXISTS tombstone_watermark (
                instance_id TEXT NOT NULL,
                source_device_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                last_applied_offset INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (instance_id, source_device_id, kind)
            );
            CREATE TABLE IF NOT EXISTS instance_binding (
                instance_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                endpoint_hint TEXT NOT NULL,
                bound_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_history (
                old_device_id TEXT NOT NULL,
                new_device_id TEXT NOT NULL,
                rotated_at TEXT NOT NULL,
                reason TEXT NOT NULL,
                PRIMARY KEY (old_device_id, new_device_id)
            );
            
