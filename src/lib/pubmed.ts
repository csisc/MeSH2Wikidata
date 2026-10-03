import { PubMedReference } from '../types';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/** Extra PubMed constraints that make a hit more likely to speak about the chosen relation. */
export const RELATION_HINTS: Record<string, string> = {
  P2176: '(therapy[sh] OR drug therapy[sh] OR therapeutic use[sh])',
  P2175: '(therapy[sh] OR drug therapy[sh] OR therapeutic use[sh])',
  P2293: '(genetics[sh])',
  P828: '(etiology[sh])',
  P780: '(diagnosis[sh] OR complications[sh])',
  P923: '(diagnosis[sh] OR diagnostic use[sh])',
};

export function cleanTerm(label: string): string {
  return label.replace(/\s*\([A-Z]\d+\)$/, '').replace(/"/g, '').trim();
}

export function buildTextQuery(subjectLabel: string, objectLabel: string): string {
  return `"${cleanTerm(subjectLabel)}"[Title/Abstract] AND "${cleanTerm(objectLabel)}"[Title/Abstract]`;
}

export function buildPubMedQuery(subjectLabel: string, objectLabel: string, hint?: string): string {
  const base = `"${cleanTerm(subjectLabel)}"[MeSH Terms] AND "${cleanTerm(objectLabel)}"[MeSH Terms]`;
  return hint ? `${base} AND ${hint}` : base;
}

/* Minimal serial scheduler honouring NCBI's 3 requests/second (10 with an API key). */
const throttles = new Map<number, <T>(fn: () => Promise<T>) => Promise<T>>();
function throttleFor(intervalMs: number) {
  let t = throttles.get(intervalMs);
  if (!t) {
    let chain: Promise<unknown> = Promise.resolve();
    let last = 0;
    t = <T,>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        const wait = Math.max(0, last + intervalMs - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        return fn();
      });
      chain = run.catch(() => undefined);
      return run;
    };
    throttles.set(intervalMs, t);
  }
  return t;
}

async function eutils(path: string, params: Record<string, string>, apiKey: string, signal?: AbortSignal) {
  const qs = new URLSearchParams({ retmode: 'json', tool: 'mesh2wikidata-linker', ...params });
  if (apiKey) qs.set('api_key', apiKey);
  const throttle = throttleFor(apiKey ? 110 : 360);
  return throttle(async () => {
    const res = await fetch(`${EUTILS}/${path}?${qs.toString()}`, { signal });
    if (!res.ok) throw new Error(res.status === 429 ? 'NCBI rate limit hit (HTTP 429)' : `NCBI E-utilities answered HTTP ${res.status}`);
    return res.json();
  });
}

async function searchOnce(query: string, apiKey: string, signal?: AbortSignal) {
  const data = await eutils('esearch.fcgi', { db: 'pubmed', term: query, retmax: '1', sort: 'relevance' }, apiKey, signal);
  const ids: string[] = data?.esearchresult?.idlist ?? [];
  const count = parseInt(data?.esearchresult?.count ?? '0', 10) || 0;
  return { pmid: ids[0] as string | undefined, count };
}

export async function findPubMedReference(opts: {
  subjectLabel: string;
  objectLabel: string;
  pid?: string;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<PubMedReference | null> {
  const apiKey = opts.apiKey ?? '';
  const hint = opts.pid ? RELATION_HINTS[opts.pid] : undefined;
  const attempts: Array<{ query: string; level: PubMedReference['matchLevel'] }> = [];
  if (hint) attempts.push({ query: buildPubMedQuery(opts.subjectLabel, opts.objectLabel, hint), level: 'relation-specific' });
  attempts.push({ query: buildPubMedQuery(opts.subjectLabel, opts.objectLabel), level: 'co-indexed' });
  // Wikidata labels sometimes differ from the MeSH heading; fall back to a plain text match.
  attempts.push({ query: buildTextQuery(opts.subjectLabel, opts.objectLabel), level: 'text-mention' });

  for (const a of attempts) {
    const { pmid, count } = await searchOnce(a.query, apiKey, opts.signal);
    if (!pmid) continue;
    const sum = await eutils('esummary.fcgi', { db: 'pubmed', id: pmid }, apiKey, opts.signal);
    const doc = sum?.result?.[pmid];
    if (!doc?.title) continue;
    const authors: string =
      Array.isArray(doc.authors) && doc.authors.length > 0
        ? `${doc.authors.slice(0, 3).map((x: { name: string }) => x.name).join(', ')}${doc.authors.length > 3 ? ' et al.' : ''}`
        : '';
    return {
      pmid,
      title: String(doc.title).replace(/\.$/, ''),
      journal: doc.fulljournalname || doc.source || '',
      pubDate: doc.pubdate || '',
      authors,
      queryUsed: a.query,
      matchLevel: a.level,
      hitCount: count,
    };
  }
  return null;
}
