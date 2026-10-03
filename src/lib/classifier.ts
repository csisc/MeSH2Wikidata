import { WIKIDATA_BIOMEDICAL_PROPERTIES } from '../data/biomedicalOntology';
import { LlmConfig, LlmPrediction, MeshEntityInfo, SemanticGroup, WikidataPropertySpec } from '../types';

const DISEASE: SemanticGroup[] = ['Disease & Syndrome', 'Neoplastic Process'];
const INTERVENTION: SemanticGroup[] = ['Pharmacologic Substance', 'Therapeutic Procedure'];
const ANATOMY: SemanticGroup[] = ['Anatomical Structure', 'Cell & Tissue'];

export const RULE_BASED_MODEL_ID = 'Rule-based domain/range scorer (no language model)';

/**
 * Deterministic scorer: domain/range fit of the two MeSH semantic groups against each
 * candidate property. It is NOT a language model. It is the instant default and the
 * fallback when the optional local Ollama model is unavailable.
 */
export function scoreProperties(
  subject: MeshEntityInfo,
  object: MeshEntityInfo,
  pmi: number,
  properties: WikidataPropertySpec[] = WIKIDATA_BIOMEDICAL_PROPERTIES
): Array<{ property: WikidataPropertySpec; score: number }> {
  const sg = subject.semanticGroup;
  const og = object.semanticGroup;
  const known = !!sg && !!og;

  const scored = properties.map((prop) => {
    let score = 0.15;
    const domainMatch = !!sg && prop.domainGroups.includes(sg);
    const rangeMatch = !!og && prop.rangeGroups.includes(og);
    if (domainMatch && rangeMatch) score += 0.58;
    else if (domainMatch || rangeMatch) score += 0.28;

    // Narrow properties beat broad ones of equal fit; structural properties (instance of, part of...) lose ties.
    const breadth = (prop.domainGroups.length + prop.rangeGroups.length) / 24;
    score += 0.06 * (1 - Math.min(1, breadth));
    if (prop.generic) score -= 0.12;

    if (sg && og) {
      const sDis = DISEASE.includes(sg);
      const sInt = INTERVENTION.includes(sg);
      const oDis = DISEASE.includes(og);
      const oInt = INTERVENTION.includes(og);
      if (sDis && oInt && prop.pid === 'P2176') score += 0.22;
      if (sInt && oDis && prop.pid === 'P2175') score += 0.22;
      if (og === 'Diagnostic & Lab Procedure' && prop.pid === 'P923') score += 0.2;
      if (ANATOMY.includes(og) && sDis && prop.pid === 'P927') score += 0.21;
      if (og === 'Gene, Protein & Receptor' && sDis && prop.pid === 'P2293') score += 0.21;
      if (sg === 'Gene, Protein & Receptor' && og === 'Gene, Protein & Receptor' && prop.pid === 'P129') score += 0.24;
      if (og === 'Biological Function' && prop.pid === 'P682') score += 0.19;
      if (og === 'Organism & Model' && prop.pid === 'P703') score += 0.23;
      if (sg === 'Environmental & Chemical' && prop.pid === 'P1542') score += 0.21;
      if (og === 'Epidemiology & Healthcare' && prop.pid === 'P2579') score += 0.18;
      if (sg === og && prop.pid === 'P279') score += 0.16;
      if (sg === 'Anatomical Structure' && og === 'Anatomical Structure' && prop.pid === 'P361') score += 0.1;
    }

    const pmiBoost = Math.min(0.08, (pmi - 2.0) * 0.02);
    score += Math.max(0, pmiBoost);
    // Without both semantic groups (unresolved or unclassified MeSH ID) the fit is a guess.
    score = Math.max(0, Math.min(known ? 0.98 : 0.4, score));
    return { property: prop, score: Number(score.toFixed(3)) };
  });

  // Stable sort: ties keep the order of the property list (specific categories first).
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Top two scores closer than this are reported as ambiguous and capped below the default bulk-approve threshold. */
export const AMBIGUITY_MARGIN = 0.04;
export const AMBIGUOUS_CONFIDENCE_CAP = 0.6;

export function classifyRuleBased(
  subject: MeshEntityInfo,
  object: MeshEntityInfo,
  pmi: number,
  properties: WikidataPropertySpec[] = WIKIDATA_BIOMEDICAL_PROPERTIES
): LlmPrediction {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const sg = subject.semanticGroup;
  const og = object.semanticGroup;
  const known = !!sg && !!og;
  const scored = scoreProperties(subject, object, pmi, properties);
  const top = scored[0];
  const second = scored[1];
  const ambiguous = known && !!second && top.score - second.score < AMBIGUITY_MARGIN;
  const confidence = ambiguous ? Math.min(top.score, AMBIGUOUS_CONFIDENCE_CAP) : top.score;

  let reasoning = known
    ? `Subject "${subject.label}" [${sg}] and object "${object.label}" [${og}] (PMI ${pmi.toFixed(2)}): domain/range fit selects ${top.property.pid} (${top.property.label}) with score ${(top.score * 100).toFixed(1)}%.`
    : `At least one of the two MeSH descriptors is unresolved or has no recognised tree number, so ${top.property.pid} (${top.property.label}) is only a weak default. Choose the property manually.`;
  if (ambiguous) {
    reasoning += ` Ambiguous: ${second.property.pid} (${second.property.label}) fits almost equally well, because the category pair alone cannot tell them apart. Read the labels and decide.`;
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    recommendedProperty: top.property,
    confidence,
    reasoning,
    alternatives: scored.slice(1, 4),
    modelId: RULE_BASED_MODEL_ID,
    latencyMs: Math.max(1, Math.round(t1 - t0)),
    engine: 'rule-based',
  };
}

/* ------------------------------------------------------------------ */
/* Optional local language model (Ollama)                              */
/* ------------------------------------------------------------------ */

export function normalizeOllamaBase(url: string): string {
  return url.trim().replace(/\/api\/.*$/, '').replace(/\/+$/, '');
}

export function buildOllamaMessages(
  subject: MeshEntityInfo,
  object: MeshEntityInfo,
  pmi: number,
  candidates: WikidataPropertySpec[]
) {
  const ent = (e: MeshEntityInfo) => ({
    mesh_descriptor_id: e.meshId,
    wikidata_item: e.qid,
    label: e.label,
    description: e.description,
    mesh_tree_numbers: e.treeNumbers.slice(0, 4),
    semantic_group: e.semanticGroup,
  });
  const system =
    'You are a careful biomedical knowledge-graph curator for Wikidata. ' +
    'Given a subject and an object that frequently co-occur in the literature, choose the single Wikidata property ' +
    'whose meaning correctly links subject to object (subject -> property -> object), choosing only from the candidate list. ' +
    'If no candidate expresses a true, specific relationship, answer NONE. ' +
    'Respond with JSON only: {"pid": "P..." | "NONE", "confidence": number between 0 and 1, "reason": "one sentence"}.';
  const user = JSON.stringify(
    {
      subject: ent(subject),
      object: ent(object),
      pointwise_mutual_information: pmi,
      candidates: candidates.map((p) => ({
        pid: p.pid,
        label: p.label,
        description: p.description,
        typical_subject_groups: p.domainGroups,
        typical_object_groups: p.rangeGroups,
      })),
    },
    null,
    1
  );
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function parseOllamaAnswer(
  content: string,
  candidates: WikidataPropertySpec[]
): { pid: string | null; confidence: number; reason: string } {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model did not return JSON');
  const obj = JSON.parse(content.slice(start, end + 1));
  const pidRaw = String(obj.pid ?? '').trim().toUpperCase();
  const confidence = Math.max(0, Math.min(1, Number(obj.confidence)));
  const reason = String(obj.reason ?? '').slice(0, 400);
  if (pidRaw === 'NONE') return { pid: null, confidence: Number.isFinite(confidence) ? confidence : 0, reason };
  if (!candidates.some((c) => c.pid === pidRaw)) throw new Error(`model returned unknown property "${pidRaw}"`);
  return { pid: pidRaw, confidence: Number.isFinite(confidence) ? confidence : 0, reason };
}

export const OLLAMA_MAX_CANDIDATES = 15;

export async function classifyWithOllama(
  cfg: LlmConfig,
  subject: MeshEntityInfo,
  object: MeshEntityInfo,
  pmi: number,
  signal?: AbortSignal,
  properties: WikidataPropertySpec[] = WIKIDATA_BIOMEDICAL_PROPERTIES
): Promise<LlmPrediction> {
  const base = classifyRuleBased(subject, object, pmi, properties);
  // Small local models cope badly with 50+ options: offer the best-fitting ones (all, if categories are unknown).
  const known = !!subject.semanticGroup && !!object.semanticGroup;
  const candidatesAll = known
    ? scoreProperties(subject, object, pmi, properties).slice(0, OLLAMA_MAX_CANDIDATES).map((x) => x.property)
    : properties;
  const t0 = Date.now();
  const res = await fetch(`${normalizeOllamaBase(cfg.ollamaUrl)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: cfg.ollamaModel,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
      messages: buildOllamaMessages(subject, object, pmi, candidatesAll),
    }),
  });
  if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);
  const data = await res.json();
  const answer = parseOllamaAnswer(String(data?.message?.content ?? ''), candidatesAll);
  const latencyMs = Date.now() - t0;

  if (!answer.pid) {
    return {
      ...base,
      confidence: Math.min(base.confidence, 0.3),
      reasoning: `${cfg.ollamaModel} found no suitable candidate property${answer.reason ? `: ${answer.reason}` : '.'} Rule-based default shown; consider rejecting.`,
      modelId: cfg.ollamaModel,
      latencyMs,
      engine: 'ollama',
    };
  }
  const chosen = candidatesAll.find((p) => p.pid === answer.pid)!;
  const alternatives = [base.recommendedProperty, ...base.alternatives.map((a) => a.property)]
    .filter((p) => p.pid !== chosen.pid)
    .slice(0, 3)
    .map((property) => ({ property, score: base.alternatives.find((a) => a.property.pid === property.pid)?.score ?? base.confidence }));
  return {
    recommendedProperty: chosen,
    confidence: answer.confidence,
    reasoning: `${cfg.ollamaModel}: ${answer.reason || 'no explanation given'} (confidence is self-reported by the model).`,
    alternatives,
    modelId: cfg.ollamaModel,
    latencyMs,
    engine: 'ollama',
  };
}

/* ------------------------------------------------------------------ */
/* Persisted configuration                                             */
/* ------------------------------------------------------------------ */

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  mode: 'rule-based',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.1:8b',
  minConfidence: 0.65,
  ncbiApiKey: '',
};

const STORAGE_KEY = 'mesh2wikidata.config.v1';

export function loadConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LLM_CONFIG;
    return { ...DEFAULT_LLM_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_LLM_CONFIG;
  }
}

export function saveConfig(cfg: LlmConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* storage unavailable: keep in-memory config only */
  }
}
