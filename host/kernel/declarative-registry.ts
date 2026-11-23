/**
 * Portable Tier 1 Declarative Asset Registry & Parser (RFC-002 P3).
 *
 * Node-free on purpose so `host/kernel/runtime.ts` keeps its portable closure
 * across Desktop, Mobile, and WebUI runtimes. Filesystem-backed reading lives
 * in `host/kernel/declarative-loader.ts`.
 */
import { parse as parseYaml } from 'yaml';
import type { PluginManifest } from './manifest.ts';

export interface DeclarativeRubricDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  scoreDimensions: Array<{
    name: string;
    maxScore: number;
    description: string | null;
  }>;
  totalMaxScore: number;
}

export interface DeclarativeSkillAsset {
  pluginId: string;
  skillId: string;
  name: string;
  description: string;
  markdown: string;
  sourcePath: string;
}

export interface DeclarativeCardTemplateAsset {
  pluginId: string;
  id: string;
  name: string;
  description?: string;
  frontTemplate: string;
  backTemplate: string;
  fields: string[];
  tags?: string[];
}

export interface DeclarativeWorkflowAsset {
  pluginId: string;
  id: string;
  name: string;
  description?: string;
  trigger?: string;
  steps: Array<{
    id: string;
    title: string;
    prompt: string;
    toolHint?: string;
  }>;
}

export interface DeclarativeAssetRegistryService {
  listSkills(): DeclarativeSkillAsset[];
  listCardTemplates(): DeclarativeCardTemplateAsset[];
  listWorkflows(): DeclarativeWorkflowAsset[];
  listRubricIdsByPlugin(pluginId: string): string[];
}

export interface GradingRubricsLike {
  register(
    pluginId: string,
    mode: {
      id: string;
      name: string;
      description: string;
      systemPrompt: string;
      scoreDimensions: Array<{ name: string; maxScore: number; description: string | null }>;
      totalMaxScore: number;
      createdAt: string;
      updatedAt: string;
    },
  ): () => void;
}

export class DeclarativeAssetRegistry implements DeclarativeAssetRegistryService {
  private readonly skills = new Map<string, DeclarativeSkillAsset>();
  private readonly cardTemplates = new Map<string, DeclarativeCardTemplateAsset>();
  private readonly workflows = new Map<string, DeclarativeWorkflowAsset>();
  private readonly rubricsByPlugin = new Map<string, Set<string>>();

  addSkill(asset: DeclarativeSkillAsset): () => void {
    const key = `${asset.pluginId}::${asset.skillId}`;
    this.skills.set(key, asset);
    return () => {
      if (this.skills.get(key) === asset) this.skills.delete(key);
    };
  }

  addCardTemplate(asset: DeclarativeCardTemplateAsset): () => void {
    const key = `${asset.pluginId}::${asset.id}`;
    this.cardTemplates.set(key, asset);
    return () => {
      if (this.cardTemplates.get(key) === asset) this.cardTemplates.delete(key);
    };
  }

  addWorkflow(asset: DeclarativeWorkflowAsset): () => void {
    const key = `${asset.pluginId}::${asset.id}`;
    this.workflows.set(key, asset);
    return () => {
      if (this.workflows.get(key) === asset) this.workflows.delete(key);
    };
  }

  trackRubric(pluginId: string, modeId: string): () => void {
    let set = this.rubricsByPlugin.get(pluginId);
    if (!set) {
      set = new Set();
      this.rubricsByPlugin.set(pluginId, set);
    }
    set.add(modeId);
    return () => {
      const current = this.rubricsByPlugin.get(pluginId);
      current?.delete(modeId);
      if (current && current.size === 0) this.rubricsByPlugin.delete(pluginId);
    };
  }

  listSkills(): DeclarativeSkillAsset[] {
    return [...this.skills.values()].map(s => ({ ...s }));
  }

  listCardTemplates(): DeclarativeCardTemplateAsset[] {
    return [...this.cardTemplates.values()].map(t => ({ ...t, fields: [...t.fields] }));
  }

  listWorkflows(): DeclarativeWorkflowAsset[] {
    return [...this.workflows.values()].map(w => ({ ...w, steps: w.steps.map(s => ({ ...s })) }));
  }

  listRubricIdsByPlugin(pluginId: string): string[] {
    return [...(this.rubricsByPlugin.get(pluginId) ?? [])];
  }
}

function parseDataDocument(raw: string, relPath: string): Record<string, unknown> {
  const parsed = relPath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`DECLARATIVE_INVALID: "${relPath}" must parse to an object`);
  }
  return parsed as Record<string, unknown>;
}

function parseSkillFrontmatter(markdown: string, fallbackId: string): { skillId: string; name: string; description: string } {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (fmMatch) {
    try {
      const fm = parseYaml(fmMatch[1]!) as Record<string, unknown> | null;
      if (fm && typeof fm === 'object') {
        const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fallbackId;
        const skillId = typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : name;
        const description = typeof fm.description === 'string' ? fm.description.trim() : '';
        return { skillId, name, description };
      }
    } catch {
      // Fall through to heading extraction.
    }
  }
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return { skillId: fallbackId, name: heading || fallbackId, description: '' };
}

function normalizeRubric(doc: Record<string, unknown>, pluginId: string, relPath: string): DeclarativeRubricDefinition {
  const rawId = typeof doc.id === 'string' && doc.id.trim() ? doc.id.trim() : '';
  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : '';
  const systemPrompt = typeof doc.systemPrompt === 'string'
    ? doc.systemPrompt.trim()
    : typeof doc.system_prompt === 'string'
      ? doc.system_prompt.trim()
      : '';
  const rawDims = Array.isArray(doc.scoreDimensions)
    ? doc.scoreDimensions
    : Array.isArray(doc.dimensions)
      ? doc.dimensions
      : [];

  if (!rawId || !name || !systemPrompt || rawDims.length === 0) {
    throw new Error(`DECLARATIVE_RUBRIC_INVALID: "${relPath}" requires id, name, systemPrompt (or system_prompt), and non-empty scoreDimensions (or dimensions)`);
  }

  const scoreDimensions = rawDims.map((dim, idx) => {
    if (!dim || typeof dim !== 'object') {
      throw new Error(`DECLARATIVE_RUBRIC_INVALID: "${relPath}" dimension[${idx}] must be an object`);
    }
    const d = dim as Record<string, unknown>;
    const dimName = typeof d.name === 'string' ? d.name.trim() : '';
    const maxScore = Number(d.maxScore ?? d.max_score ?? d.max ?? 0);
    if (!dimName || !Number.isFinite(maxScore) || maxScore <= 0) {
      throw new Error(`DECLARATIVE_RUBRIC_INVALID: "${relPath}" dimension[${idx}] requires name and positive maxScore`);
    }
    const description = typeof d.description === 'string' && d.description.trim() ? d.description.trim() : null;
    return { name: dimName, maxScore, description };
  });

  const computedTotal = scoreDimensions.reduce((sum, d) => sum + d.maxScore, 0);
  const explicitTotal = Number(doc.totalMaxScore ?? doc.total_max_score ?? 0);
  const totalMaxScore = Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : computedTotal;
  const scopedId = rawId.includes(':') ? rawId : `${pluginId}:${rawId}`;
  const description = typeof doc.description === 'string' ? doc.description.trim() : '';

  return { id: scopedId, name, description, systemPrompt, scoreDimensions, totalMaxScore };
}

export interface MountDeclarativeDeps {
  registry: DeclarativeAssetRegistry;
  gradingRubrics?: GradingRubricsLike;
}

/**
 * Portable declarative asset mounter driven by a caller-supplied text reader.
 * Returns a composite disposer that cleanly removes every mounted contribution.
 */
export async function mountDeclarativeAssetsWithReader(
  manifest: PluginManifest,
  readRelativeText: (relPath: string) => Promise<string>,
  deps: MountDeclarativeDeps,
): Promise<() => void> {
  const decl = manifest.declarative;
  if (!decl) return () => {};

  const disposers: Array<() => void> = [];
  const rollback = () => {
    while (disposers.length) {
      try { disposers.pop()!(); } catch { /* best-effort cleanup */ }
    }
  };

  try {
    const nowIso = new Date().toISOString();

    for (const relPath of decl.rubrics ?? []) {
      const raw = await readRelativeText(relPath);
      const doc = parseDataDocument(raw, relPath);
      const rubric = normalizeRubric(doc, manifest.id, relPath);
      if (deps.gradingRubrics) {
        disposers.push(
          deps.gradingRubrics.register(manifest.id, {
            ...rubric,
            createdAt: nowIso,
            updatedAt: nowIso,
          }),
        );
      }
      disposers.push(deps.registry.trackRubric(manifest.id, rubric.id));
    }

    for (const relPath of decl.skills ?? []) {
      const markdown = await readRelativeText(relPath);
      const fallbackId = relPath.replace(/^\.\//, '').replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-');
      const meta = parseSkillFrontmatter(markdown, fallbackId);
      disposers.push(
        deps.registry.addSkill({
          pluginId: manifest.id,
          skillId: meta.skillId,
          name: meta.name,
          description: meta.description,
          markdown,
          sourcePath: relPath,
        }),
      );
    }

    for (const relPath of decl.cardTemplates ?? []) {
      const doc = parseDataDocument(await readRelativeText(relPath), relPath);
      const id = typeof doc.id === 'string' ? doc.id.trim() : '';
      const name = typeof doc.name === 'string' ? doc.name.trim() : '';
      const frontTemplate = typeof doc.frontTemplate === 'string'
        ? doc.frontTemplate
        : typeof doc.front === 'string'
          ? doc.front
          : '';
      const backTemplate = typeof doc.backTemplate === 'string'
        ? doc.backTemplate
        : typeof doc.back === 'string'
          ? doc.back
          : '';
      if (!id || !name || !frontTemplate || !backTemplate) {
        throw new Error(`DECLARATIVE_TEMPLATE_INVALID: "${relPath}" requires id, name, frontTemplate, and backTemplate`);
      }
      const fields = Array.isArray(doc.fields)
        ? doc.fields.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        : ['front', 'back'];
      const tags = Array.isArray(doc.tags)
        ? doc.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : undefined;
      disposers.push(
        deps.registry.addCardTemplate({
          pluginId: manifest.id,
          id,
          name,
          description: typeof doc.description === 'string' ? doc.description.trim() : undefined,
          frontTemplate,
          backTemplate,
          fields,
          tags,
        }),
      );
    }

    for (const relPath of decl.workflows ?? []) {
      const doc = parseDataDocument(await readRelativeText(relPath), relPath);
      const id = typeof doc.id === 'string' ? doc.id.trim() : '';
      const name = typeof doc.name === 'string' ? doc.name.trim() : '';
      const rawSteps = Array.isArray(doc.steps) ? doc.steps : [];
      if (!id || !name || rawSteps.length === 0) {
        throw new Error(`DECLARATIVE_WORKFLOW_INVALID: "${relPath}" requires id, name, and non-empty steps`);
      }
      const steps = rawSteps.map((step, idx) => {
        if (!step || typeof step !== 'object') {
          throw new Error(`DECLARATIVE_WORKFLOW_INVALID: "${relPath}" step[${idx}] must be an object`);
        }
        const s = step as Record<string, unknown>;
        const stepId = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `step-${idx + 1}`;
        const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim() : stepId;
        const prompt = typeof s.prompt === 'string' ? s.prompt.trim() : '';
        if (!prompt) {
          throw new Error(`DECLARATIVE_WORKFLOW_INVALID: "${relPath}" step[${idx}] requires non-empty prompt`);
        }
        return {
          id: stepId,
          title,
          prompt,
          ...(typeof s.toolHint === 'string' && s.toolHint.trim() ? { toolHint: s.toolHint.trim() } : {}),
        };
      });
      disposers.push(
        deps.registry.addWorkflow({
          pluginId: manifest.id,
          id,
          name,
          description: typeof doc.description === 'string' ? doc.description.trim() : undefined,
          trigger: typeof doc.trigger === 'string' ? doc.trigger.trim() : undefined,
          steps,
        }),
      );
    }
  } catch (error) {
    rollback();
    throw error;
  }

  return rollback;
}
