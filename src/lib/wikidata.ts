import { ExistingLink, MeshEntityInfo, WikidataPropertySpec } from '../types';
import { groupFromTreeNumbers } from './meshTree';
import { fetchJson, mapPool } from './net';
import { WIKIDATA_BIOMEDICAL_PROPERTIES } from '../data/biomedicalOntology';

export const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

const MESH_ID_RE = /^[A-Z]\d{6,9}$/;
const QID_RE = /^Q\d+$/;
const PID_RE = /^P\d+$/;

/** wbgetentities accepts at most 50 IDs per request (500 for bots). */
const WBGETENTITIES_MAX = 50;

/* ------------------------------------------------------------------ */
/* Entities from the Wikibase action API                               */
/*                                                                     */
/* One wbgetentities call returns label, aliases, description, MeSH    */
/* tree codes and all statements of up to 50 items. That is enough to  */
/* resolve the items AND to decide locally whether a relation already  */
/* exists and whether it carries references: no SPARQL needed for      */
/* either, and the 50-ID chunks are fetched in parallel.               */
/* ------------------------------------------------------------------ */

export interface WdLink {
  pid: string;
  /** references other than "imported from" */
  refCount: number;
  pmids: string[];
}

export interface WdEntity {
  qid: string;
  label: string;
  description: string;
  aliases: string[];
  meshIds: string[];
  treeNumbers: string[];
  /** statements pointing at another item: object QID -> statements */
  links: Map<string, WdLink[]>;
}

const IMPORT_ONLY = new Set(['P143', 'P4656']);

export function parseEntity(qid: string, raw: any): WdEntity {
  const links = new Map<string, WdLink[]>();
  const meshIds: string[] = [];
  const treeNumbers: string[] = [];
  for (const [pid, list] of Object.entries<any[]>(raw?.claims ?? {})) {
    for (const c of list) {
      if (c?.rank === 'deprecated') continue;
      const ms = c?.mainsnak;
      if (!ms || ms.snaktype !== 'value') continue;
      const v = ms.datavalue?.value;
      if (pid === 'P672' && typeof v === 'string') {
        treeNumbers.push(v);
        continue;
      }
      if (pid === 'P486' && typeof v === 'string') {
        meshIds.push(v);
        continue;
      }
      if (ms.datatype === 'wikibase-item' && typeof v?.id === 'string') {
        let refCount = 0;
        const pmids: string[] = [];
        for (const ref of c.references ?? []) {
          const snaks: Record<string, any[]> = ref?.snaks ?? {};
          if (Object.keys(snaks).some((k) => !IMPORT_ONLY.has(k))) refCount++;
          for (const sn of snaks.P698 ?? []) {
            const pv = sn?.datavalue?.value;
            if (typeof pv === 'string') pmids.push(pv);
          }
        }
        const arr = links.get(v.id) ?? [];
        arr.push({ pid, refCount, pmids });
        links.set(v.id, arr);
      }
    }
  }
  return {
    qid,
    label: raw?.labels?.en?.value ?? '',
    description: raw?.descriptions?.en?.value ?? '',
    aliases: (raw?.aliases?.en ?? []).map((a: { value: string }) => a.value),
    meshIds,
    treeNumbers,
    links,
  };
}

export async function fetchEntities(
  qids: string[],
  signal?: AbortSignal,
  concurrency = 4
): Promise<Map<string, WdEntity>> {
  const unique = Array.from(new Set(qids.filter((q) => QID_RE.test(q))));
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += WBGETENTITIES_MAX) chunks.push(unique.slice(i, i + WBGETENTITIES_MAX));
  const out = new Map<string, WdEntity>();
  await mapPool(chunks, concurrency, async (chunk) => {
    const url =
      `${WIKIDATA_API}?action=wbgetentities&format=json&origin=*&languages=en` +
      `&props=labels|aliases|descriptions|claims&ids=${chunk.join('|')}`;
    const json = await fetchJson(url, { timeoutMs: 30000 }, signal);
    if (json?.error) throw new Error(`Wikidata API error: ${json.error.info ?? json.error.code}`);
    for (const [id, raw] of Object.entries<any>(json?.entities ?? {})) {
      if (raw?.missing !== undefined) continue;
      out.set(id, parseEntity(id, raw));
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* MeSH descriptor ID (P486) -> item                                   */
/*                                                                     */
/* Lookup order: in-memory map (seeded from the prebuilt              */
/* ./data/mesh2qid.json and from the browser's localStorage) and then */
/* one lean SPARQL query for the remaining IDs.                        */
/* ------------------------------------------------------------------ */

const meshMap = new Map<string, string[]>();
const meshAbsent = new Set<string>();
const MESH_STORAGE_KEY = 'mesh2wikidata.meshmap.v1';

export function seedMeshMap(obj: Record<string, string | string[]>): number {
  let n = 0;
  for (const [id, v] of Object.entries(obj)) {
    const qids = (Array.isArray(v) ? v : [v]).filter((q) => QID_RE.test(q));
    if (MESH_ID_RE.test(id) && qids.length) {
      meshMap.set(id, qids);
      n++;
    }
  }
  return n;
}

export function clearMeshMapForTests(): void {
  meshMap.clear();
  meshAbsent.clear();
}

export function loadPersistedMeshMap(): number {
  try {
    const raw = localStorage.getItem(MESH_STORAGE_KEY);
    return raw ? seedMeshMap(JSON.parse(raw)) : 0;
  } catch {
    return 0;
  }
}

function persistMeshMap(): void {
  try {
    const obj: Record<string, string | string[]> = {};
    for (const [id, q] of meshMap) obj[id] = q.length === 1 ? q[0] : q;
    localStorage.setItem(MESH_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* storage full or unavailable: the in-memory map still works */
  }
}

/** Optional prebuilt table written at build time by scripts/build-mesh-map.mjs; absent => ignored. */
export async function loadPrebuiltMeshMap(url = './data/mesh2qid.json'): Promise<number> {
  try {
    const json = await fetchJson<Record<string, string | string[]>>(url, { timeoutMs: 15000, retries: 0 });
    return seedMeshMap(json);
  } catch {
    return 0;
  }
}

export function buildMeshQuery(meshIds: string[]): string {
  const values = meshIds
    .filter((id) => MESH_ID_RE.test(id))
    .map((id) => `"${id}"`)
    .join(' ');
  return `SELECT ?mesh ?item WHERE { VALUES ?mesh { ${values} } ?item wdt:P486 ?mesh . }`;
}

export function parseMeshQidBindings(bindings: Array<Record<string, { value: string } | undefined>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of bindings) {
    const mesh = b.mesh?.value;
    const qid = (b.item?.value || '').split('/').pop() || '';
    if (!mesh || !QID_RE.test(qid)) continue;
    const list = out.get(mesh) ?? [];
    if (!list.includes(qid)) list.push(qid);
    out.set(mesh, list);
  }
  return out;
}

export async function lookupMeshQids(meshIds: string[], signal?: AbortSignal): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const need: string[] = [];
  for (const id of new Set(meshIds)) {
    if (!MESH_ID_RE.test(id)) {
      found.set(id, []);
    } else if (meshMap.has(id)) {
      found.set(id, meshMap.get(id)!);
    } else if (meshAbsent.has(id)) {
      found.set(id, []);
    } else {
      need.push(id);
    }
  }
  const chunks: string[][] = [];
  for (let i = 0; i < need.length; i += 400) chunks.push(need.slice(i, i + 400));
  await mapPool(chunks, 2, async (chunk) => {
    const json = await fetchJson(
      SPARQL_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
        body: new URLSearchParams({ query: buildMeshQuery(chunk) }).toString(),
        timeoutMs: 25000,
      },
      signal
    );
    const byId = parseMeshQidBindings(json?.results?.bindings ?? []);
    for (const id of chunk) {
      const qids = byId.get(id) ?? [];
      if (qids.length) meshMap.set(id, qids);
      else meshAbsent.add(id);
      found.set(id, qids);
    }
  });
  if (need.length) persistMeshMap();
  return found;
}

function unresolved(id: string, resolution: MeshEntityInfo['resolution'], description: string): MeshEntityInfo {
  return { meshId: id, qid: null, label: id, description, semanticGroup: null, treeNumbers: [], aliases: [], resolution };
}

/** MeSH IDs -> display info (label, aliases, tree numbers) plus the full entities for the local checks. */
export async function resolveMeshBatch(
  meshIds: string[],
  signal?: AbortSignal
): Promise<{ infos: Map<string, MeshEntityInfo>; entities: Map<string, WdEntity> }> {
  const unique = Array.from(new Set(meshIds));
  const descriptors = unique.filter((id) => !id.startsWith('Q'));
  const qidsByMesh = await lookupMeshQids(descriptors, signal);
  const allQids = Array.from(new Set(Array.from(qidsByMesh.values()).flat()));
  const entities = await fetchEntities(allQids, signal);

  const infos = new Map<string, MeshEntityInfo>();
  for (const id of unique) {
    if (id.startsWith('Q')) {
      infos.set(id, unresolved(id, 'qualifier', 'MeSH qualifier (subheading), not a descriptor: cannot be a statement object.'));
      continue;
    }
    const qids = (qidsByMesh.get(id) ?? []).filter((q) => entities.has(q));
    if (qids.length === 0) {
      infos.set(id, unresolved(id, 'not-found', 'No Wikidata item has this MeSH descriptor ID (P486).'));
      continue;
    }
    const ent = entities.get(qids[0])!;
    infos.set(id, {
      meshId: id,
      qid: ent.qid,
      label: ent.label || id,
      description: ent.description,
      semanticGroup: groupFromTreeNumbers(ent.treeNumbers),
      treeNumbers: ent.treeNumbers,
      aliases: ent.aliases,
      resolution: qids.length > 1 ? 'ambiguous' : 'resolved',
      candidateQids: qids.length > 1 ? qids : undefined,
    });
  }
  return { infos, entities };
}

/* ------------------------------------------------------------------ */
/* Existing statements between two items: computed locally            */
/* ------------------------------------------------------------------ */

export interface QidPair {
  key: string;
  subjectQid: string;
  objectQid: string;
}

export function computeLinks(pairs: QidPair[], entities: Map<string, WdEntity>): Map<string, ExistingLink[]> {
  const out = new Map<string, ExistingLink[]>();
  for (const p of pairs) {
    const list: ExistingLink[] = [];
    const collect = (from: string, to: string, direction: ExistingLink['direction']) => {
      const byPid = new Map<string, ExistingLink>();
      for (const l of entities.get(from)?.links.get(to) ?? []) {
        const e = byPid.get(l.pid) ?? { pid: l.pid, label: l.pid, direction, referenceCount: 0, pmids: [] };
        e.referenceCount += l.refCount;
        for (const pm of l.pmids) if (!e.pmids.includes(pm)) e.pmids.push(pm);
        byPid.set(l.pid, e);
      }
      list.push(...byPid.values());
    };
    if (p.subjectQid !== p.objectQid) {
      collect(p.subjectQid, p.objectQid, 'forward');
      collect(p.objectQid, p.subjectQid, 'reverse');
    }
    out.set(p.key, list);
  }
  return out;
}

const propLabelCache = new Map<string, string>();

/** Fill in property labels (catalogue first, then one wbgetentities call for the rest). */
export async function labelLinks(links: Map<string, ExistingLink[]>, signal?: AbortSignal): Promise<void> {
  const known = new Map(WIKIDATA_BIOMEDICAL_PROPERTIES.map((p) => [p.pid, p.label]));
  const missing = new Set<string>();
  for (const list of links.values()) for (const l of list) if (!propLabelCache.has(l.pid) && !known.has(l.pid)) missing.add(l.pid);
  const ids = Array.from(missing).filter((p) => PID_RE.test(p));
  for (let i = 0; i < ids.length; i += WBGETENTITIES_MAX) {
    try {
      const json = await fetchJson(
        `${WIKIDATA_API}?action=wbgetentities&format=json&origin=*&props=labels&languages=en&ids=${ids.slice(i, i + WBGETENTITIES_MAX).join('|')}`,
        { timeoutMs: 10000 },
        signal
      );
      for (const [id, ent] of Object.entries<any>(json?.entities ?? {})) {
        if (ent?.labels?.en?.value) propLabelCache.set(id, ent.labels.en.value);
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      /* labels are cosmetic: keep the bare property IDs */
    }
  }
  for (const list of links.values()) for (const l of list) l.label = propLabelCache.get(l.pid) ?? known.get(l.pid) ?? l.pid;
}

/* ------------------------------------------------------------------ */
/* Property catalogue check and one-off property lookup                */
/* ------------------------------------------------------------------ */

export interface PropertyCheck {
  pid: string;
  configuredLabel: string;
  wikidataLabel: string | null;
  wikidataDescription: string | null;
  ok: boolean;
}

export async function verifyProperties(props: WikidataPropertySpec[], signal?: AbortSignal): Promise<PropertyCheck[]> {
  const ids = props.map((p) => p.pid).filter((p) => PID_RE.test(p));
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += WBGETENTITIES_MAX) chunks.push(ids.slice(i, i + WBGETENTITIES_MAX));
  const entities: Record<string, any> = {};
  await mapPool(chunks, 3, async (chunk) => {
    const json = await fetchJson(
      `${WIKIDATA_API}?action=wbgetentities&format=json&origin=*&props=labels|descriptions&languages=en&ids=${chunk.join('|')}`,
      { timeoutMs: 15000 },
      signal
    );
    // An API-level error must never be read as "every property is wrong".
    if (json?.error) throw new Error(`Wikidata API error: ${json.error.info ?? json.error.code}`);
    if (!json?.entities) throw new Error('Wikidata API returned no entities');
    Object.assign(entities, json.entities);
  });
  return props.map((p) => {
    const ent = entities[p.pid];
    const label: string | null = ent?.labels?.en?.value ?? null;
    const desc: string | null = ent?.descriptions?.en?.value ?? null;
    return { pid: p.pid, configuredLabel: p.label, wikidataLabel: label, wikidataDescription: desc, ok: labelsMatch(label, p.label) };
  });
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Same label, ignoring case/punctuation, or one contained in the other ("has part(s)" vs "has part"). */
export function labelsMatch(wikidataLabel: string | null, configured: string): boolean {
  if (!wikidataLabel) return false;
  const a = norm(wikidataLabel);
  const b = norm(configured);
  return a === b || (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a)));
}

/**
 * Look up an arbitrary property ID for use as a one-off override. Only item-valued properties
 * can link two MeSH items, so other datatypes are rejected.
 */
export async function fetchPropertySpec(pid: string, signal?: AbortSignal): Promise<WikidataPropertySpec> {
  const id = pid.trim().toUpperCase();
  if (!PID_RE.test(id)) throw new Error('Enter a property ID such as P2176.');
  const json = await fetchJson(
    `${WIKIDATA_API}?action=wbgetentities&format=json&origin=*&props=labels|descriptions|datatype&languages=en&ids=${id}`,
    { timeoutMs: 15000 },
    signal
  );
  const ent = json?.entities?.[id];
  if (!ent || ent.missing !== undefined) throw new Error(`${id} does not exist on Wikidata.`);
  if (ent.datatype !== 'wikibase-item') {
    throw new Error(`${id} (${ent.labels?.en?.value ?? 'no label'}) takes ${ent.datatype} values, not items, so it cannot link two MeSH items.`);
  }
  return {
    pid: id,
    label: ent.labels?.en?.value ?? id,
    description: ent.descriptions?.en?.value ?? '',
    domainGroups: [],
    rangeGroups: [],
    exampleUsage: '',
    category: 'Added by curator',
    custom: true,
  };
}
