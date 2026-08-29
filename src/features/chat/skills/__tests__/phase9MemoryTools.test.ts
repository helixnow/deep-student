import { describe, expect, it } from "vitest";

import { vfsMemorySkill } from "../builtin-tools/vfs-memory";

function tool(name: string) {
  const matches =
    vfsMemorySkill.embeddedTools?.filter((entry) => entry.name === name) ?? [];
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("phase 9 memory tool contracts", () => {
  it("keeps progressive disclosure closed over the complete memory tool set", () => {
    expect(vfsMemorySkill.allowedTools).toEqual(
      vfsMemorySkill.embeddedTools?.map((entry) => entry.name),
    );
    expect(new Set(vfsMemorySkill.allowedTools).size).toBe(16);
    for (const name of [
      "builtin-memory_search",
      "builtin-memory_batch_move",
      "builtin-memory_add_relation",
      "builtin-memory_remove_relation",
      "builtin-memory_update_tags",
      "builtin-memory_export_all",
    ]) {
      tool(name);
    }
  });

  it("requires an exact OCC map and caps batch moves at 20", () => {
    const schema = tool("builtin-memory_batch_move").inputSchema as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      "note_ids",
      "target_folder_path",
      "expected_updated_at_by_id",
    ]);
    expect(schema.properties.note_ids.maxItems).toBe(20);
    expect(schema.properties.note_ids.uniqueItems).toBe(true);
    expect(schema.properties.expected_updated_at_by_id.minProperties).toBe(1);
    expect(
      schema.properties.expected_updated_at_by_id.additionalProperties
        .minLength,
    ).toBe(1);
  });

  it("keeps memory listing within the global 20-item page contract", () => {
    const listTool = tool("builtin-memory_list");
    const schema = listTool.inputSchema as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.limit).toMatchObject({
      minimum: 1,
      maximum: 20,
      default: 20,
    });
    for (const field of [
      "items",
      "count",
      "limit",
      "offset",
      "has_more",
      "next_offset",
    ]) {
      expect(listTool.description).toContain(field);
    }
  });

  it("requires both endpoint versions for every relation mutation", () => {
    for (const name of [
      "builtin-memory_add_relation",
      "builtin-memory_remove_relation",
    ]) {
      const schema = tool(name).inputSchema as any;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual([
        "note_id_a",
        "note_id_b",
        "expected_updated_at_a",
        "expected_updated_at_b",
      ]);
      expect(schema.properties.expected_updated_at_a.minLength).toBe(1);
      expect(schema.properties.expected_updated_at_b.minLength).toBe(1);
    }
  });

  it("bounds tags and makes their replacement OCC explicit", () => {
    const schema = tool("builtin-memory_update_tags").inputSchema as any;
    expect(schema.required).toEqual(["note_id", "tags", "expected_updated_at"]);
    expect(schema.properties.tags.maxItems).toBe(50);
    expect(schema.properties.tags.uniqueItems).toBe(true);
    expect(schema.properties.tags.items.maxLength).toBe(200);
    expect(tool("builtin-memory_update_tags").description).toContain(
      "系统标签",
    );
  });

  it("keeps privacy export high-risk, paginated and content-bounded", () => {
    const exportTool = tool("builtin-memory_export_all");
    const schema = exportTool.inputSchema as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.page.minimum).toBe(1);
    expect(schema.properties.page_size.maximum).toBe(20);
    expect(exportTool.description).toContain("High");
    expect(vfsMemorySkill.content).toContain("memory://changed");
    expect(vfsMemorySkill.content).toContain("OCC");
    expect(vfsMemorySkill.content).toMatch(
      /超过 2000 字符.*content_truncated=true/,
    );
  });
});
