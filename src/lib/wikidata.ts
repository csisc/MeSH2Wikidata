import { ExistingLink, MeshEntityInfo, WikidataPropertySpec } from '../types';
import { groupFromTreeNumbers } from './meshTree';

export const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

type Binding = Record<string, { value: string } | undefined>;

const MESH_ID_RE = /^[A-Z]\d{6,9}$/;
const QID_RE = /^Q\d+$/;
const PID_RE = /^P\d+$/;

async function runSparql(query: string, signal?: AbortSignal): Promise<Binding[]> {
  const res = await fetch(SPARQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
    },
    body: new URLSearchParams({ query }).toString(),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Wikidata SPARQL endpoint answered HTTP ${res.status}`);
  }
  const json = await res.json();
  return (json?.results?.bindings ?? []) as Binding[];
}

function lastSegment(uri: string | undefined): string {
  return (uri || '').split('/').pop() || '';
}

/* ------------------------------------------------------------------ */
/* 1. MeSH descriptor ID (P486) -> Wikidata item                        */
/* ------------------------------------------------------------------ */

export function buildMeshQuery(meshIds: string[]): string {
  const values = meshIds
    .filter((id) => MESH_ID_RE.test(id))
    .map((id) => `"${id}"`)
    .join(' ');
  return `SELECT ?mesh ?item ?itemLabel ?itemDescription (GROUP_CONCAT(DISTINCT ?tree; SEPARATOR="|") AS ?trees) WHERE {
  VALUES ?mesh { ${values} }
  ?item wdt:P486 ?mesh .
  OPTIONAL { ?item wdt:P672 ?tree . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}
GROUP BY ?mesh ?item ?itemLabel ?itemDescription`;
}

export function parseMeshBindings(meshIds: string[], bindings: Binding[]): Map<string, MeshEntityInfo> {
  const byMesh = new Map<string, Array<{ qid: string; label: string; description: string; trees: string[] }>>();
  for (const b of bindings) {
    const mesh = b.mesh?.value;
    const qid = lastSegment(b.item?.value);
    if (!mesh || !QID_RE.test(qid)) continue;
    const rawLabel = b.itemLabel?.value || '';
    const list = byMesh.get(mesh) ?? [];
    list.push({
      qid,
      label: rawLabel && rawLabel !== qid ? rawLabel : mesh,
      description: b.itemDescription?.value || '',
      trees: (b.trees?.value || '').split('|').filter(Boolean),
    });
    byMesh.set(mesh, list);
  }

  const out = new Map<string, MeshEntityInfo>();
  for (const id of meshIds) {
    if (id.startsWith('Q')) {
      out.set(id, {
        meshId: id,
        qid: null,
        label: id,
        description: 'MeSH qualifier (subheading), not a descriptor: cannot be a statement object.',
        semanticGroup: null,
        treeNumbers: [],
        resolution: 'qualifier',
      });
      continue;
    }
    const hits = byMesh.get(id);
    if (!hits || hits.length === 0) {
      out.set(id, {
        meshId: id,
        qid: null,
        label: id,
        description: 'No Wikidata item has this MeSH descriptor ID (P486).',
        semanticGroup: null,
        treeNumbers: [],
        resolution: 'not-found',
      });
      continue;
    }
    const first = hits[0];
    out.set(id, {
      meshId: id,
      qid: first.qid,
      label: first.label,
      description: first.description,
      semanticGroup: groupFromTreeNumbers(first.trees),
      treeNumbers: first.trees,
      resolution: hits.length > 1 ? 'ambiguous' : 'resolved',
      candidateQids: hits.length > 1 ? hits.map((h) => h.qid) : undefined,
    });
  }
  return out;
}

export async function resolveMeshIds(
  meshIds: string[],
  signal?: AbortSignal
): Promise<Map<string, MeshEntityInfo>> {
  const unique = Array.from(new Set(meshIds));
  const lookup = unique.filter((id) => MESH_ID_RE.test(id) && !id.startsWith('Q'));
  const bindings: Binding[] = [];
  for (let i = 0; i < lookup.length; i += 200) {
    bindings.push(...(await runSparql(buildMeshQuery(lookup.slice(i, i + 200)), signal)));
  }
  return parseMeshBindings(unique, bindings);
}

/* ------------------------------------------------------------------ */
/* 2. Existing statements between two items                            */
/* ------------------------------------------------------------------ */

export interface QidPair {
  key: string;
  subjectQid: string;
  objectQid: string;
}

export function buildLinksQuery(pairs: QidPair[]): string {
  const values = pairs
    .filter((p) => QID_RE.test(p.subjectQid) && QID_RE.test(p.objectQid))
    .map((p) => `(wd:${p.subjectQid} wd:${p.objectQid})`)
    .join(' ');
  return `SELECT ?s ?o ?p ?propLabel ?dir WHERE {
  VALUES (?s ?o) { ${values} }
  { ?s ?p ?o . BIND("forward" AS ?dir) }
  UNION
  { ?o ?p ?s . BIND("reverse" AS ?dir) }
  FILTER(STRSTARTS(STR(?p), "http://www.wikidata.org/prop/direct/"))
  ?prop wikibase:directClaim ?p .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

export function parseLinksBindings(pairs: QidPair[], bindings: Binding[]): Map<string, ExistingLink[]> {
  const byPair = new Map<string, ExistingLink[]>(pairs.map((p) => [p.key, []]));
  const keyOf = new Map(pairs.map((p) => [`${p.subjectQid}>${p.objectQid}`, p.key]));
  for (const b of bindings) {
    const s = lastSegment(b.s?.value);
    const o = lastSegment(b.o?.value);
    const pid = lastSegment(b.p?.value);
    const key = keyOf.get(`${s}>${o}`);
    if (!key || !PID_RE.test(pid)) continue;
    const direction = b.dir?.value === 'reverse' ? 'reverse' : 'forward';
    const list = byPair.get(key)!;
    if (!list.some((l) => l.pid === pid && l.direction === direction)) {
      list.push({ pid, label: b.propLabel?.value || pid, direction });
    }
  }
  return byPair;
}

export async function findExistingLinks(
  pairs: QidPair[],
  signal?: AbortSignal
): Promise<Map<string, ExistingLink[]>> {
  const usable = pairs.filter((p) => p.subjectQid !== p.objectQid);
  const result = new Map<string, ExistingLink[]>(pairs.map((p) => [p.key, []]));
  for (let i = 0; i < usable.length; i += 100) {
    const chunk = usable.slice(i, i + 100);
    const bindings = await runSparql(buildLinksQuery(chunk), signal);
    for (const [k, v] of parseLinksBindings(chunk, bindings)) result.set(k, v);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 3. Check that the configured property IDs mean what we think        */
/* ------------------------------------------------------------------ */

export interface PropertyCheck {
  pid: string;
  configuredLabel: string;
  wikidataLabel: string | null;
  wikidataDescription: string | null;
  ok: boolean;
}

export async function verifyProperties(
  props: WikidataPropertySpec[],
  signal?: AbortSignal
): Promise<PropertyCheck[]> {
  const ids = props.map((p) => p.pid).filter((p) => PID_RE.test(p));
  const url =
    `${WIKIDATA_API}?action=wbgetentities&format=json&origin=*&props=labels|descriptions&languages=en` +
    `&ids=${ids.join('|')}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Wikidata API answered HTTP ${res.status}`);
  const json = await res.json();
  return props.map((p) => {
    const ent = json?.entities?.[p.pid];
    const label: string | null = ent?.labels?.en?.value ?? null;
    const desc: string | null = ent?.descriptions?.en?.value ?? null;
    return {
      pid: p.pid,
      configuredLabel: p.label,
      wikidataLabel: label,
      wikidataDescription: desc,
      ok: !!label && label.trim().toLowerCase() === p.label.trim().toLowerCase(),
    };
  });
}
