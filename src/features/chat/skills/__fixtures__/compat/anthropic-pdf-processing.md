---
name: pdf-processing
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
license: Apache-2.0
homepage: https://github.com/anthropics/skills/tree/main/skills/pdf
tags:
  - documents
  - pdf
  - extraction
compatibility: Requires pdftotext or equivalent PDF tooling; network optional
version: 1.0.0
author: anthropics
allowed-tools: Read Bash
---

# PDF Processing

Use the scripts in `scripts/` to extract text and tables from PDFs.

## Workflow

1. Inspect the PDF structure
2. Extract text or tables as needed
3. Return structured results to the user
