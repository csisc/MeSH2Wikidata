import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv } from '../src/lib/csv';
import { fetchPropertySpec, labelsMatch } from '../src/lib/wikidata';
import { groupFromTreeNumbers } from '../src/lib/meshTree';
import { buildMeshQuery, parseMeshBindings, buildLinksQuery, parseLinksBindings, resolveMeshIds, findExistingLinks, verifyProperties } from '../src/lib/wikidata';
import { classifyRuleBased, scoreProperties, OLLAMA_MAX_CANDIDATES, parseOllamaAnswer, classifyWithOllama, normalizeOllamaBase, DEFAULT_LLM_CONFIG } from '../src/lib/classifier';
import { WIKIDATA_BIOMEDICAL_PROPERTIES } from '../src/data/biomedicalOntology';
import { buildV1, buildV1Url, buildAuditCsv } from '../src/lib/quickstatements';
import { findPubMedReference, buildPubMedQuery } from '../src/lib/pubmed';
import type { MeshEntityInfo, ProcessedRelationRecord } from '../src/types';

let n = 0;
const t = async (name: string, fn: () => void | Promise<void>) => { await fn(); n++; console.log('ok -', name); };

const ent = (over: Partial<MeshEntityInfo>): MeshEntityInfo => ({
  meshId: 'D000000', qid: 'Q1', label: 'x', description: '', semanticGroup: null, treeNumbers: [], resolution: 'resolved', ...over,
});

await t('parses the real 835k-row CSV, counting malformed rows instead of hiding them', () => {
  const { rows, skipped } = parseCsv(readFileSync('public/data/missing_rels.csv', 'utf8'));
  assert.equal(rows.length, 835027);
  assert.equal(skipped, 84);
  assert.deepEqual([rows[0].subjectMeshId, rows[0].objectMeshId, rows[0].pmi], ['D011634', 'D015201', 2.01]);
});

await t('tree numbers -> semantic groups', () => {
  assert.equal(groupFromTreeNumbers(['C04.557.470']), 'Neoplastic Process');
  assert.equal(groupFromTreeNumbers(['C23.550', 'C08.381']), 'Disease & Syndrome');
  assert.equal(groupFromTreeNumbers(['D12.776.157']), 'Gene, Protein & Receptor');
  assert.equal(groupFromTreeNumbers(['E02.319']), 'Therapeutic Procedure');
  assert.equal(groupFromTreeNumbers([]), null);
});

await t('MeSH query only embeds well-formed IDs and parses hits, ambiguity, misses and qualifiers', () => {
  const q = buildMeshQuery(['D009068', 'D1"; DROP', 'D010781']);
  assert.ok(q.includes('"D009068"') && q.includes('"D010781"') && !q.includes('DROP'));
  const b = [
    { mesh: { value: 'D009068' }, item: { value: 'http://www.wikidata.org/entity/Q1' }, itemLabel: { value: 'Movement' }, itemDescription: { value: 'd' }, trees: { value: 'G11.427|G11.5' } },
    { mesh: { value: 'D010781' }, item: { value: 'http://www.wikidata.org/entity/Q2' }, itemLabel: { value: 'Photochemotherapy' }, trees: { value: 'E02.319.300' } },
    { mesh: { value: 'D010781' }, item: { value: 'http://www.wikidata.org/entity/Q3' }, itemLabel: { value: 'Q3' }, trees: { value: '' } },
  ];
  const m = parseMeshBindings(['D009068', 'D010781', 'D999999', 'Q000523'], b);
  assert.equal(m.get('D009068')!.qid, 'Q1');
  assert.equal(m.get('D009068')!.semanticGroup, 'Biological Function');
  assert.equal(m.get('D010781')!.resolution, 'ambiguous');
  assert.deepEqual(m.get('D010781')!.candidateQids, ['Q2', 'Q3']);
  assert.equal(m.get('D999999')!.resolution, 'not-found');
  assert.equal(m.get('D999999')!.qid, null);
  assert.equal(m.get('Q000523')!.resolution, 'qualifier');
});

await t('existing-link query/parse keeps direction and ignores unrelated pairs', () => {
  const pairs = [{ key: 'a', subjectQid: 'Q1', objectQid: 'Q2' }];
  assert.ok(buildLinksQuery(pairs).includes('(wd:Q1 wd:Q2)'));
  const res = parseLinksBindings(pairs, [
    { s: { value: 'http://www.wikidata.org/entity/Q1' }, o: { value: 'http://www.wikidata.org/entity/Q2' }, p: { value: 'http://www.wikidata.org/prop/direct/P2176' }, propLabel: { value: 'drug or therapy used for treatment' }, dir: { value: 'forward' } },
    { s: { value: 'http://www.wikidata.org/entity/Q1' }, o: { value: 'http://www.wikidata.org/entity/Q2' }, p: { value: 'http://www.wikidata.org/prop/direct/P2175' }, dir: { value: 'reverse' } },
    { s: { value: 'http://www.wikidata.org/entity/Q9' }, o: { value: 'http://www.wikidata.org/entity/Q2' }, p: { value: 'http://www.wikidata.org/prop/direct/P1' }, dir: { value: 'forward' } },
  ]);
  assert.deepEqual(res.get('a')!.map((l) => `${l.direction}:${l.pid}`), ['forward:P2176', 'reverse:P2175']);
});

await t('rule-based classifier: disease->drug picks P2176, unknown groups are capped and flagged', () => {
  const dis = ent({ semanticGroup: 'Disease & Syndrome' });
  const drug = ent({ semanticGroup: 'Pharmacologic Substance' });
  assert.equal(classifyRuleBased(dis, drug, 3).recommendedProperty.pid, 'P2176');
  assert.equal(classifyRuleBased(drug, dis, 3).recommendedProperty.pid, 'P2175');
  const weak = classifyRuleBased(ent({}), drug, 3);
  assert.ok(weak.confidence <= 0.4);
  assert.match(weak.reasoning, /unresolved/);
  assert.equal(weak.engine, 'rule-based');
});

await t('ollama answer parsing rejects hallucinated properties and accepts NONE', () => {
  const props = WIKIDATA_BIOMEDICAL_PROPERTIES;
  assert.deepEqual(parseOllamaAnswer('{"pid":"p2176","confidence":0.8,"reason":"r"}', props), { pid: 'P2176', confidence: 0.8, reason: 'r' });
  assert.throws(() => parseOllamaAnswer('{"pid":"P99999999","confidence":1}', props), /unknown property/);
  assert.equal(parseOllamaAnswer('{"pid":"NONE","confidence":0.2}', props).pid, null);
  assert.throws(() => parseOllamaAnswer('no json', props));
  assert.equal(normalizeOllamaBase('http://localhost:11434/api/generate/'), 'http://localhost:11434');
});

const realFetch = globalThis.fetch;
const mockFetch = (handler: (url: string, init?: RequestInit) => unknown) => {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const body = handler(String(url), init);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
};

await t('resolveMeshIds POSTs one SPARQL query and maps the answer', async () => {
  let calls = 0; let sent = '';
  mockFetch((url, init) => {
    calls++; sent = String(init?.body);
    assert.equal(url, 'https://query.wikidata.org/sparql');
    assert.equal(init?.method, 'POST');
    return { results: { bindings: [{ mesh: { value: 'D009068' }, item: { value: 'http://www.wikidata.org/entity/Q1' }, itemLabel: { value: 'Movement' }, trees: { value: 'G11' } }] } };
  });
  const m = await resolveMeshIds(['D009068', 'D009068', 'Q000523']);
  assert.equal(calls, 1);
  assert.ok(decodeURIComponent(sent).includes('"D009068"'));
  assert.equal(m.get('D009068')!.qid, 'Q1');
  assert.equal(m.get('Q000523')!.resolution, 'qualifier');
});

await t('findExistingLinks skips self-pairs and returns empty lists for clean pairs', async () => {
  mockFetch(() => ({ results: { bindings: [] } }));
  const r = await findExistingLinks([{ key: 'k', subjectQid: 'Q1', objectQid: 'Q2' }, { key: 'same', subjectQid: 'Q5', objectQid: 'Q5' }]);
  assert.deepEqual(r.get('k'), []);
  assert.deepEqual(r.get('same'), []);
});

await t('verifyProperties flags a label that does not match Wikidata', async () => {
  mockFetch(() => ({ entities: { P2176: { labels: { en: { value: 'drug or therapy used for treatment' } } }, P923: { labels: { en: { value: 'something else' } } } } }));
  const props = WIKIDATA_BIOMEDICAL_PROPERTIES.filter((p) => ['P2176', 'P923'].includes(p.pid));
  const r = await verifyProperties(props);
  assert.equal(r.find((x) => x.pid === 'P2176')!.ok, true);
  assert.equal(r.find((x) => x.pid === 'P923')!.ok, false);
});

await t('PubMed: relation-specific query first, falls back to co-indexed, returns null when nothing', async () => {
  const seen: string[] = [];
  mockFetch((url) => {
    if (url.includes('esearch')) {
      const term = new URL(url).searchParams.get('term')!;
      seen.push(term);
      return { esearchresult: term.includes('therapy[sh]') ? { count: '0', idlist: [] } : { count: '42', idlist: ['123'] } };
    }
    return { result: { '123': { title: 'A paper.', fulljournalname: 'J', pubdate: '2020', authors: [{ name: 'A B' }] } } };
  });
  const ref = await findPubMedReference({ subjectLabel: 'Mouth Neoplasms', objectLabel: 'Photochemotherapy', pid: 'P2176' });
  assert.equal(seen.length, 2);
  assert.equal(ref!.pmid, '123');
  assert.equal(ref!.matchLevel, 'co-indexed');
  assert.equal(ref!.hitCount, 42);
  mockFetch(() => ({ esearchresult: { count: '0', idlist: [] } }));
  assert.equal(await findPubMedReference({ subjectLabel: 'a', objectLabel: 'b' }), null);
  assert.equal(buildPubMedQuery('Leukocytes, Mononuclear (D007962)', 'B'), '"Leukocytes, Mononuclear"[MeSH Terms] AND "B"[MeSH Terms]');
});

await t('ollama classification uses the model answer and keeps rule-based alternatives', async () => {
  mockFetch((url, init) => {
    assert.equal(url, 'http://localhost:11434/api/chat');
    assert.equal(JSON.parse(String(init?.body)).format, 'json');
    return { message: { content: '{"pid":"P2293","confidence":0.7,"reason":"gene linked to disease"}' } };
  });
  const p = await classifyWithOllama({ ...DEFAULT_LLM_CONFIG, mode: 'ollama' }, ent({ semanticGroup: 'Disease & Syndrome' }), ent({ semanticGroup: 'Gene, Protein & Receptor' }), 3);
  assert.equal(p.recommendedProperty.pid, 'P2293');
  assert.equal(p.engine, 'ollama');
  assert.ok(p.alternatives.every((a) => a.property.pid !== 'P2293'));
});
globalThis.fetch = realFetch;

await t('property catalogue: unique IDs, valid shape, inverse pairs exist, enough coverage', () => {
  const props = WIKIDATA_BIOMEDICAL_PROPERTIES;
  const ids = props.map((x) => x.pid);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(props.length >= 50, `only ${props.length} properties`);
  for (const x of props) {
    assert.match(x.pid, /^P\d+$/);
    assert.ok(x.label && x.description && x.exampleUsage && x.category, x.pid);
    assert.ok(x.domainGroups.length > 0 && x.rangeGroups.length > 0, x.pid);
    if (x.inversePid) assert.equal(props.find((y) => y.pid === x.inversePid)?.inversePid, x.pid, `${x.pid} inverse`);
  }
});

await t('label matching is lenient about case/punctuation but not about meaning', () => {
  assert.ok(labelsMatch('Has part(s)', 'has part(s)'));
  assert.ok(labelsMatch('has part', 'has part(s)'));
  assert.ok(!labelsMatch('endorsed by', 'medical examination'));
  assert.ok(!labelsMatch(null, 'x'));
});

await t('scorer: specific beats generic, symmetric inverses follow direction, ambiguity is capped', () => {
  const gene = ent({ semanticGroup: 'Gene, Protein & Receptor' });
  const dis = ent({ semanticGroup: 'Disease & Syndrome' });
  const org = ent({ semanticGroup: 'Organism & Model' });
  const anat = ent({ semanticGroup: 'Anatomical Structure' });
  const top = (a: MeshEntityInfo, b: MeshEntityInfo) => scoreProperties(a, b, 3).slice(0, 3).map((x) => x.property.pid);
  assert.equal(top(dis, gene)[0], 'P2293');
  assert.equal(top(org, org)[0], 'P171');
  assert.equal(top(anat, anat)[0] === 'P279' || top(anat, anat)[0] === 'P361', false, 'generic must not win over anatomy-specific');
  const amb = classifyRuleBased(dis, dis, 3);
  assert.ok(amb.confidence <= 0.6 && /Ambiguous/.test(amb.reasoning), `${amb.recommendedProperty.pid} ${amb.confidence}`);
  const clear = classifyRuleBased(dis, ent({ semanticGroup: 'Pharmacologic Substance' }), 3);
  assert.ok(clear.confidence > 0.9 && !/Ambiguous/.test(clear.reasoning));
});

await t('ollama prompt is limited to the best-fitting candidates', async () => {
  let sent: any;
  globalThis.fetch = (async (_u: any, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return { ok: true, status: 200, json: async () => ({ message: { content: '{"pid":"NONE","confidence":0.1,"reason":"x"}' } }) } as Response;
  }) as typeof fetch;
  await classifyWithOllama({ ...DEFAULT_LLM_CONFIG, mode: 'ollama' }, ent({ semanticGroup: 'Disease & Syndrome' }), ent({ semanticGroup: 'Anatomical Structure' }), 3);
  assert.equal(JSON.parse(sent.messages[1].content).candidates.length, OLLAMA_MAX_CANDIDATES);
});

await t('custom property lookup accepts item properties and rejects other datatypes / unknown IDs', async () => {
  globalThis.fetch = (async (url: any) => {
    const id = new URL(String(url)).searchParams.get('ids')!;
    const entities: any = {
      P1050: { datatype: 'wikibase-item', labels: { en: { value: 'medical condition' } }, descriptions: { en: { value: 'd' } } },
      P569: { datatype: 'time', labels: { en: { value: 'date of birth' } } },
      P9: { missing: '' },
    };
    return { ok: true, status: 200, json: async () => ({ entities: { [id]: entities[id] } }) } as Response;
  }) as typeof fetch;
  const spec = await fetchPropertySpec(' p1050 ');
  assert.deepEqual([spec.pid, spec.label, spec.custom], ['P1050', 'medical condition', true]);
  await assert.rejects(fetchPropertySpec('P569'), /not items/);
  await assert.rejects(fetchPropertySpec('P9'), /does not exist/);
  await assert.rejects(fetchPropertySpec('banana'), /such as P2176/);
});
globalThis.fetch = realFetch;

await t('QuickStatements V1: needs approval + QIDs, honours reference and duplicate options, dated today', () => {
  const prop = WIKIDATA_BIOMEDICAL_PROPERTIES.find((p) => p.pid === 'P2176')!;
  const base = (id: string, over: Partial<ProcessedRelationRecord>): ProcessedRelationRecord => ({
    id, rowIndex: 1, tupleRaw: '', subjectMeshId: 'D1', objectMeshId: 'D2', pmi: 2.5,
    subject: ent({ qid: 'Q10', label: 'S' }), object: ent({ qid: 'Q20', label: 'O' }),
    selectedProperty: prop, llmPrediction: classifyRuleBased(ent({}), ent({}), 2),
    wikidataVerification: { state: 'checked', existing: [] },
    pubmedReference: { pmid: '999', title: 't', journal: 'j', pubDate: '', authors: '', queryUsed: '', matchLevel: 'co-indexed', hitCount: 1 },
    pubmedState: 'found', status: 'approved', updatedAt: '', ...over,
  });
  const recs = [
    base('ok', {}),
    base('pending', { status: 'pending' }),
    base('unresolved', { object: ent({ qid: null, resolution: 'not-found' }) }),
    base('noref', { pubmedReference: null, pubmedState: 'none' }),
    base('dup', { wikidataVerification: { state: 'checked', existing: [{ pid: 'P2176', label: 'x', direction: 'forward' }] } }),
  ];
  const d = new Date('2026-10-02T12:00:00Z');
  const strict = buildV1(recs, { requireReference: true, includeExactDuplicates: false, retrieved: d });
  assert.equal(strict, 'Q10\tP2176\tQ20\tS698\t"999"\tS813\t+2026-10-02T00:00:00Z/11');
  const loose = buildV1(recs, { requireReference: false, includeExactDuplicates: true, retrieved: d }).split('\n');
  assert.equal(loose.length, 3);
  assert.ok(loose.includes('Q10\tP2176\tQ20'));
  assert.ok(buildV1Url(strict).startsWith('https://quickstatements.toolforge.org/#/v1=Q10%7CP2176%7CQ20%7CS698'));
  assert.equal(buildAuditCsv(recs, { requireReference: true, includeExactDuplicates: false }).split('\n').length, 2);
});

console.log(`\n${n} tests passed`);
