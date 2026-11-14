-- Fixture seed: mistakes @ schema V20260720 (one step before V20260721).
-- automation_definitions row must survive the trusted_profile_json column addition.

INSERT INTO mistakes (id, created_at, question_images, analysis_images, user_question, ocr_text,
                      tags, mistake_type, status, updated_at, chat_metadata)
VALUES
  ('mistake_nh_0001', '2026-07-20T12:00:00Z', '["img/nh1.png"]', '[]',
   '这道电磁学题的受力分析？', 'OCR：洛伦兹力方向……', '["物理","电磁学"]', 'concept', 'done',
   '2026-07-20T12:00:00Z', NULL);

INSERT INTO automation_definitions (id, name, schedule_json, prompt, enabled,
                                    created_at, updated_at, source_session_id,
                                    action_type, catch_up_policy)
VALUES ('auto_nh_0000001', '每日错题回顾', '{"kind":"daily","at":"20:00"}', '回顾今天的错题', 1,
        '2026-07-20T12:10:00Z', '2026-07-20T12:10:00Z', 'sess_nh0000001',
        'notify', 'run_once');
