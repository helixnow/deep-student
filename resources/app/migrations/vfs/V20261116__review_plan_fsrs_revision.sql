-- Bind FSRS state to the plan revision that wrote it. An older client may
-- update the old scheduling columns and relay the FSRS columns unchanged.
-- An unbound state is rebuilt from the compatible schedule on the next review.
ALTER TABLE review_plans ADD COLUMN fsrs_plan_revision TEXT;
