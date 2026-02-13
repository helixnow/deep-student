-- SQL to add vector_generated column to kg_tags table
ALTER TABLE kg_tags ADD COLUMN vector_generated INTEGER NOT NULL DEFAULT 0; 