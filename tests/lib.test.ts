import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv } from '../src/lib/csv';
import { fetchPropertySpec, labelsMatch } from '../src/lib/wikidata';
import { groupFromTreeNumbers } from '../src/lib/meshTree';
import { buildMeshQuery, parseMeshQidBindings, parseEntity, fetchEntities, lookupMeshQids, resolveMeshBatch, computeLinks, labelLinks, seedMeshMap, clearMeshMapForTests, verifyProperties } from '../src/lib/wikidata';
import { RateLimiter, fetchJson } from '../src/lib/net';
import { bindingsToMap } from '../scripts/build-mesh-map.mjs';
import { classifyRuleBased, scoreProperties, OLLAMA_MAX_CANDIDATES, parseOllamaAnswer, classifyWithOllama, normalizeOllamaBase, DEFAULT_LLM_CONFIG } from '../src/lib/classifier';
import { WIKIDATA_BIOMEDICAL_PROPERTIES } from '../src/data/biomedicalOntology';
import { buildV1, buildV1Url, buildAuditCsv } from '../src/lib/quickstatements';
import { findReferences, buildPairQuery, parsePubmedXml, rankCandidates, matchVariants, splitSentences } from '../src/lib/pubmed';
import type { MeshEntityInfo, ProcessedRelationRecord } from '../src/types';

const realFetch = globalThis.fetch;
const mockFetch = (handler: (url: string, init?: RequestInit) => unknown) => {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const body = handler(String(url), init);
    return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) } as Response;
  }) as typeof fetch;
};

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

const E = 'http://www.wikidata.org/entity/';
const claim = (qid: string, extra: any = {}) => ({ mainsnak: { snaktype: 'value', datatype: 'wikibase-item', datavalue: { value: { id: qid } } }, rank: 'normal', ...extra });
const strClaim = (v: string) => ({ mainsnak: { snaktype: 'value', datatype: 'external-id', datavalue: { value: v } }, rank: 'normal' });
const rawEntity = (label: string, claims: any, aliases: string[] = []) => ({
  labels: { en: { value: label } }, descriptions: { en: { value: `${label} desc` } }, aliases: { en: aliases.map((value) => ({ value })) }, claims,
});

await t('parseEntity: labels, aliases, MeSH tree codes, links with references, deprecated and import-only handled', () => {
  const e = parseEntity('Q1', rawEntity('Mouth Neoplasms', {
    P672: [strClaim('C04.557.470.200'), strClaim('C07.465.530')],
    P486: [strClaim('D009062')],
    P2176: [
      claim('Q2', { references: [{ snaks: { P698: [{ datavalue: { value: '111' } }] } }, { snaks: { P143: [{}] } }] }),
      claim('Q3', { rank: 'deprecated' }),
    ],
    P279: [claim('Q2')],
  }, ['Oral cancer']));
  assert.equal(e.label, 'Mouth Neoplasms');
  assert.deepEqual(e.aliases, ['Oral cancer']);
  assert.deepEqual(e.treeNumbers, ['C04.557.470.200', 'C07.465.530']);
  assert.deepEqual(e.meshIds, ['D009062']);
  assert.deepEqual(e.links.get('Q2'), [{ pid: 'P2176', refCount: 1, pmids: ['111'] }, { pid: 'P279', refCount: 0, pmids: [] }]);
  assert.equal(e.links.has('Q3'), false);
});

await t('fetchEntities: 50 IDs per call, calls run in parallel, results merged', async () => {
  let calls = 0, active = 0, peak = 0;
  globalThis.fetch = (async (url: any) => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    const ids = new URL(String(url)).searchParams.get('ids')!.split('|');
    assert.ok(ids.length <= 50);
    active--;
    return { ok: true, status: 200, json: async () => ({ entities: Object.fromEntries(ids.map((i) => [i, rawEntity(`L${i}`, {})])) }) } as Response;
  }) as typeof fetch;
  const qids = Array.from({ length: 180 }, (_, i) => `Q${i + 1}`);
  const m = await fetchEntities(qids);
  assert.equal(m.size, 180);
  assert.equal(calls, 4);
  assert.ok(peak >= 2, `expected parallel requests, peak was ${peak}`);
});

await t('MeSH lookup: SPARQL is lean (no label service), cached results are not re-queried, absent IDs are remembered', async () => {
  clearMeshMapForTests();
  const q = buildMeshQuery(['D009068', 'bad"id', 'D010781']);
  assert.ok(q.includes('"D009068"') && !q.includes('bad') && !q.includes('SERVICE') && !q.includes('GROUP'));
  let sparql = 0;
  mockFetch((url, init) => {
    sparql++;
    assert.equal(url, 'https://query.wikidata.org/sparql');
    return { results: { bindings: [
      { mesh: { value: 'D009068' }, item: { value: E + 'Q1' } },
      { mesh: { value: 'D010781' }, item: { value: E + 'Q2' } }, { mesh: { value: 'D010781' }, item: { value: E + 'Q3' } },
    ] } };
  });
  const first = await lookupMeshQids(['D009068', 'D010781', 'D999999']);
  assert.deepEqual([first.get('D009068'), first.get('D010781'), first.get('D999999')], [['Q1'], ['Q2', 'Q3'], []]);
  await lookupMeshQids(['D009068', 'D010781', 'D999999']);
  assert.equal(sparql, 1, 'second lookup must be answered from memory');
  seedMeshMap({ D000001: 'Q77' });
  assert.deepEqual((await lookupMeshQids(['D000001'])).get('D000001'), ['Q77']);
  assert.equal(sparql, 1, 'seeded (prebuilt) IDs need no query');
  assert.deepEqual(parseMeshQidBindings([{ mesh: { value: 'D1' }, item: { value: E + 'Q5' } }]).get('D1'), ['Q5']);
});

await t('resolveMeshBatch: items, tree-based groups, aliases; ambiguous, not-found and qualifier cases', async () => {
  clearMeshMapForTests();
  mockFetch((url) => {
    if (url.startsWith('https://query.wikidata.org')) {
      return { results: { bindings: [
        { mesh: { value: 'D009062' }, item: { value: E + 'Q1' } },
        { mesh: { value: 'D010781' }, item: { value: E + 'Q2' } }, { mesh: { value: 'D010781' }, item: { value: E + 'Q3' } },
      ] } };
    }
    const ids = new URL(url).searchParams.get('ids')!.split('|');
    const all: any = {
      Q1: rawEntity('Mouth Neoplasms', { P672: [strClaim('C04.557.470.200')], P2176: [claim('Q2')] }, ['Oral cancer']),
      Q2: rawEntity('Photochemotherapy', { P672: [strClaim('E02.319.300')] }),
      Q3: rawEntity('Photochemotherapy (other)', {}),
    };
    return { entities: Object.fromEntries(ids.map((i) => [i, all[i]])) };
  });
  const { infos, entities } = await resolveMeshBatch(['D009062', 'D010781', 'D999999', 'Q000523']);
  assert.equal(infos.get('D009062')!.qid, 'Q1');
  assert.equal(infos.get('D009062')!.semanticGroup, 'Neoplastic Process');
  assert.deepEqual(infos.get('D009062')!.aliases, ['Oral cancer']);
  assert.equal(infos.get('D010781')!.resolution, 'ambiguous');
  assert.equal(infos.get('D999999')!.resolution, 'not-found');
  assert.equal(infos.get('Q000523')!.resolution, 'qualifier');
  assert.equal(entities.size, 3);
});

await t('computeLinks answers "does the relation exist, with which references" locally, both directions', async () => {
  const ents = new Map([
    ['Q1', parseEntity('Q1', rawEntity('A', { P2176: [claim('Q2', { references: [{ snaks: { P698: [{ datavalue: { value: '555' } }] } }] })] }))],
    ['Q2', parseEntity('Q2', rawEntity('B', { P2175: [claim('Q1')] }))],
    ['Q9', parseEntity('Q9', rawEntity('C', {}))],
  ]);
  const links = computeLinks([{ key: 'k', subjectQid: 'Q1', objectQid: 'Q2' }, { key: 'none', subjectQid: 'Q1', objectQid: 'Q9' }, { key: 'same', subjectQid: 'Q1', objectQid: 'Q1' }], ents);
  assert.deepEqual(links.get('k')!.map((l) => `${l.direction}:${l.pid}:${l.referenceCount}:${l.pmids}`), ['forward:P2176:1:555', 'reverse:P2175:0:']);
  assert.deepEqual(links.get('none'), []);
  assert.deepEqual(links.get('same'), []);
  await labelLinks(links);
  assert.equal(links.get('k')![0].label, 'drug or therapy used for treatment');
});

await t('build script: bindings -> compact table, ambiguous IDs become arrays, junk is dropped', () => {
  const E2 = 'http://www.wikidata.org/entity/';
  const m = bindingsToMap([
    { mesh: { value: 'D009062' }, item: { value: E2 + 'Q1' } },
    { mesh: { value: 'D010781' }, item: { value: E2 + 'Q2' } }, { mesh: { value: 'D010781' }, item: { value: E2 + 'Q3' } },
    { mesh: { value: 'D010781' }, item: { value: E2 + 'Q3' } },
    { mesh: { value: 'not an id' }, item: { value: E2 + 'Q4' } }, { mesh: { value: 'D000005' }, item: { value: E2 + 'P9' } },
  ]);
  assert.deepEqual(m, { D009062: 'Q1', D010781: ['Q2', 'Q3'] });
});

await t('rate limiter: starts are spaced but not serialised, priority wins, aborted jobs are dropped', async () => {
  const lim = new RateLimiter(25);
  const starts: Array<[string, number]> = [];
  const t0 = Date.now();
  const job = (name: string, ms = 120, o: any = {}) => lim.schedule(async () => { starts.push([name, Date.now() - t0]); await new Promise((r) => setTimeout(r, ms)); return name; }, o);
  const ac = new AbortController();
  const all = Promise.allSettled([job('a'), job('low'), job('high', 120, { priority: 5 }), job('dead', 120, { signal: ac.signal })]);
  ac.abort();
  const res = await all;
  assert.deepEqual(starts.map((x) => x[0]), ['high', 'a', 'low']); // all queued together: priority first, then FIFO
  assert.equal(res[3].status, 'rejected');
  assert.ok(starts[1][1] - starts[0][1] >= 20, 'starts must be spaced');
  assert.ok(starts[2][1] < 120 + 80, 'second start must not wait for the first request to finish');
});

await t('fetchJson times out with a readable message and retries once', async () => {
  let n = 0;
  globalThis.fetch = ((_u: any, init?: RequestInit) => { n++; return new Promise((_r, rej) => init!.signal!.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')))); }) as typeof fetch;
  await assert.rejects(fetchJson('https://example.org/slow', { timeoutMs: 30, retries: 1 }), /did not answer within/);
  assert.equal(n, 2);
});

await t('PubMed query: MeSH heading OR title/abstract names OR aliases; matching handles plurals and inverted headings', () => {
  const q = buildPairQuery({ label: 'Mouth Neoplasms', aliases: ['Oral cancer', 'x'] }, { label: 'Photochemotherapy' });
  assert.ok(q.startsWith('("Mouth Neoplasms"[MeSH Terms] OR "Mouth Neoplasms"[tiab] OR "Oral cancer"[tiab])'));
  assert.ok(q.endsWith('AND hasabstract') && !q.includes('"x"'));
  assert.ok(matchVariants({ label: 'Leukocytes, Mononuclear' }).includes('mononuclear leukocyte'));
  assert.ok(matchVariants({ label: 'Neoplasms' }).includes('neoplasm'));
  assert.deepEqual(splitSentences('One thing. Another thing! (Third) one.'), ['One thing.', 'Another thing!', '(Third) one.']);
});

const XML = `<PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID Version="1">111</PMID><Article><Journal><JournalIssue><PubDate><Year>2020</Year></PubDate></JournalIssue><Title>J Oral &amp; Maxillofac</Title></Journal>
<ArticleTitle>Treatment of oral cancer.</ArticleTitle><Abstract><AbstractText Label="BACKGROUND">Many patients are affected.</AbstractText><AbstractText>Photochemotherapy was used to treat mouth neoplasms in 12 patients.</AbstractText></Abstract>
<AuthorList><Author><LastName>Doe</LastName><Initials>J</Initials></Author><Author><LastName>Roe</LastName><Initials>R</Initials></Author></AuthorList></Article></MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID Version="1">222</PMID><Article><Journal><JournalIssue><PubDate><MedlineDate>2019 Jan-Feb</MedlineDate></PubDate></JournalIssue><Title>Other J</Title></Journal>
<ArticleTitle>Unrelated sentences.</ArticleTitle><Abstract><AbstractText>Mouth neoplasms are common. Photochemotherapy is a technique.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

await t('parsePubmedXml + ranking: sentence-with-relation beats sentence beats abstract-only', () => {
  const arts = parsePubmedXml(XML);
  assert.deepEqual(arts.map((a) => [a.pmid, a.year, a.journal]), [['111', '2020', 'J Oral & Maxillofac'], ['222', '2019', 'Other J']]);
  assert.equal(arts[0].authors, 'Doe J, Roe R');
  const subj = { label: 'Mouth Neoplasms' }, obj = { label: 'Photochemotherapy' };
  const ranked = rankCandidates([arts[1], arts[0]], subj, obj, 'P2176', 'q', 9);
  assert.deepEqual(ranked.map((r) => [r.pmid, r.matchLevel]), [['111', 'sentence-with-relation'], ['222', 'abstract']]);
  assert.match(ranked[0].evidence[0], /treat mouth neoplasms/);
  assert.equal(rankCandidates([arts[0]], subj, obj, undefined, 'q', 1)[0].matchLevel, 'sentence');
  assert.deepEqual(rankCandidates([arts[0]], { label: 'Zebrafish' }, obj, 'P2176', 'q', 1), []);
});

await t('findReferences: 4 pairs share one esearch, 3 groups share one efetch, pairs without a hit retry alone', async () => {
  const calls: Array<{ kind: string; retmax?: string; term?: string }> = [];
  mockFetch((url, init) => {
    const body = new URLSearchParams(String(init?.body));
    if (url.includes('esearch')) {
      const term = body.get('term')!, retmax = body.get('retmax')!;
      calls.push({ kind: 'esearch', retmax, term });
      // a single-pair search for Zebrafish finds nothing; combined searches always return the two papers
      return { esearchresult: { count: '31', idlist: retmax === '8' && term.includes('Zebrafish') ? [] : ['111', '222'] } };
    }
    calls.push({ kind: 'efetch' });
    assert.equal(init?.method, 'POST');
    return XML;
  });
  const reqs = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, subject: { label: 'Mouth Neoplasms' }, object: { label: i === 3 ? 'Zebrafish' : 'Photochemotherapy' }, pid: 'P2176' }));
  const results: any[] = [];
  await findReferences(reqs, { intervalMs: 1, onResult: (r) => results.push(r) });
  const grouped = calls.filter((c) => c.kind === 'esearch' && c.retmax !== '8');
  const single = calls.filter((c) => c.kind === 'esearch' && c.retmax === '8');
  assert.equal(grouped.length, 6, '24 of the 25 pairs travel in six groups of four');
  assert.ok(grouped[0].term!.includes(' OR '));
  assert.equal(single.length, 2, 'the odd 25th pair, plus the one pair without a hit (Zebrafish) searched alone');
  assert.equal(calls.filter((c) => c.kind === 'efetch').length, 3, '7 groups / 3 per chunk');
  assert.equal(results.length, 25);
  assert.equal(new Set(results.map((r) => r.id)).size, 25, 'each pair reported exactly once');
  const r0 = results.find((r) => r.id === 'r0');
  assert.equal(r0.best.pmid, '111');
  assert.equal(r0.candidates.length, 2);
  assert.equal(results.find((r) => r.id === 'r3').best, null, 'Zebrafish is in no abstract: attribution must not hand it a paper');
});

await t('findReferences: a failed search does not sink the others; a single pair reports its hit count', async () => {
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const u = String(_url), body = new URLSearchParams(String(init?.body));
    if (u.includes('esearch') && body.get('term')!.includes('Zebrafish')) return { ok: false, status: 400, json: async () => ({}), text: async () => '' } as Response;
    const out: any = u.includes('esearch') ? { esearchresult: { count: '12', idlist: ['111'] } } : XML;
    return { ok: true, status: 200, json: async () => out, text: async () => (typeof out === 'string' ? out : '') } as Response;
  }) as typeof fetch;
  const out: any[] = [];
  await findReferences([
    { id: 'good', subject: { label: 'Mouth Neoplasms' }, object: { label: 'Photochemotherapy' }, pid: 'P2176' },
    { id: 'bad', subject: { label: 'Zebrafish' }, object: { label: 'Photochemotherapy' } },
  ], { intervalMs: 1, groupSize: 1, onResult: (r) => out.push(r) });
  assert.equal(out.find((r) => r.id === 'good').best.hitCount, 12);
  assert.ok('error' in out.find((r) => r.id === 'bad'));
});
globalThis.fetch = realFetch;

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


await t('verifyProperties flags a label that does not match Wikidata', async () => {
  mockFetch(() => ({ entities: { P2176: { labels: { en: { value: 'drug or therapy used for treatment' } } }, P923: { labels: { en: { value: 'something else' } } } } }));
  const props = WIKIDATA_BIOMEDICAL_PROPERTIES.filter((p) => ['P2176', 'P923'].includes(p.pid));
  const r = await verifyProperties(props);
  assert.equal(r.find((x) => x.pid === 'P2176')!.ok, true);
  assert.equal(r.find((x) => x.pid === 'P923')!.ok, false);
});

await t('verifyProperties respects the 50-ID API limit and never reads an API error as "all wrong"', async () => {
  const sizes: number[] = [];
  mockFetch((url) => {
    const ids = new URL(url).searchParams.get('ids')!.split('|');
    sizes.push(ids.length);
    if (ids.length > 50) return { error: { code: 'toomanyvalues', info: 'Too many values supplied' } };
    return { entities: Object.fromEntries(ids.map((id) => [id, { labels: { en: { value: WIKIDATA_BIOMEDICAL_PROPERTIES.find((p) => p.pid === id)!.label } } }])) };
  });
  const all = await verifyProperties(WIKIDATA_BIOMEDICAL_PROPERTIES);
  assert.ok(WIKIDATA_BIOMEDICAL_PROPERTIES.length > 50, 'catalogue must exceed one request to exercise chunking');
  assert.ok(sizes.length >= 2 && sizes.every((n) => n <= 50), JSON.stringify(sizes));
  assert.ok(all.every((x) => x.ok));
  mockFetch(() => ({ error: { code: 'x', info: 'boom' } }));
  await assert.rejects(verifyProperties(WIKIDATA_BIOMEDICAL_PROPERTIES), /boom/);
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
    pubmedReference: { pmid: '999', title: 't', journal: 'j', pubDate: '', authors: '', queryUsed: '', matchLevel: 'sentence', hitCount: 1, evidence: [] },
    pubmedState: 'found', status: 'approved', updatedAt: '', ...over,
  });
  const recs = [
    base('ok', {}),
    base('pending', { status: 'pending' }),
    base('unresolved', { object: ent({ qid: null, resolution: 'not-found' }) }),
    base('noref', { pubmedReference: null, pubmedState: 'none' }),
    base('dup', { wikidataVerification: { state: 'checked', existing: [{ pid: 'P2176', label: 'x', direction: 'forward', referenceCount: 0, pmids: [] }] } }),
    base('cited', { wikidataVerification: { state: 'checked', existing: [{ pid: 'P2176', label: 'x', direction: 'forward', referenceCount: 1, pmids: ['999'] }] } }),
  ];
  const d = new Date('2026-10-02T12:00:00Z');
  const strict = buildV1(recs, { requireReference: true, includeExactDuplicates: false, retrieved: d });
  assert.equal(strict, 'Q10\tP2176\tQ20\tS698\t"999"\tS813\t+2026-10-02T00:00:00Z/11');
  const loose = buildV1(recs, { requireReference: false, includeExactDuplicates: true, retrieved: d }).split('\n');
  assert.equal(loose.length, 3, 'duplicate without our PMID is kept; one already citing our PMID is dropped');
  assert.ok(loose.includes('Q10\tP2176\tQ20'));
  assert.ok(buildV1Url(strict).startsWith('https://quickstatements.toolforge.org/#/v1=Q10%7CP2176%7CQ20%7CS698'));
  assert.equal(buildAuditCsv(recs, { requireReference: true, includeExactDuplicates: false }).split('\n').length, 2);
});

console.log(`\n${n} tests passed`);
