import { PubMedReference } from '../types';
import { fetchJson, fetchText, RateLimiter } from './net';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/* NCBI allows 3 requests/second (10 with an API key). Request starts are spaced, not serialised. */
export const ncbiLimiter = new RateLimiter(360);

/**
 * Words that, in a sentence naming both items, suggest the sentence speaks about this relation.
 * Matched as lower-case substrings so that "treat" covers treated/treatment.
 */
export const RELATION_KEYWORDS: Record<string, string[]> = {
  P2175: ['treat', 'therap', 'drug', 'administ', 'efficacy'],
  P2176: ['treat', 'therap', 'drug', 'administ', 'efficacy'],
  P780: ['symptom', 'sign', 'manifest', 'present', 'characteri'],
  P828: ['cause', 'etiolog', 'induc', 'due to', 'result'],
  P1542: ['effect', 'induc', 'result', 'lead'],
  P5642: ['risk', 'associat', 'predispos'],
  P1909: ['adverse', 'side effect', 'toxic'],
  P769: ['interact'],
  P2293: ['gene', 'mutation', 'variant', 'polymorphism', 'associat'],
  P923: ['diagnos', 'detect', 'screen', 'test'],
  P927: ['locali', 'express', 'found in', 'located'],
  P129: ['bind', 'interact'],
  P682: ['regulat', 'participat', 'involved', 'mediat'],
  P703: ['found in', 'isolated', 'species'],
};

export interface TermSet {
  label: string;
  aliases?: string[];
}

export function cleanTerm(label: string): string {
  return label.replace(/\s*\([A-Z]\d+\)$/, '').replace(/["\\]/g, '').trim();
}

function names(t: TermSet): string[] {
  const all = [t.label, ...(t.aliases ?? []).slice(0, 3)].map(cleanTerm).filter((n) => n.length >= 3);
  return Array.from(new Set(all.map((n) => n.toLowerCase()))).map((l) => all.find((n) => n.toLowerCase() === l)!);
}

/** ("Label"[MeSH Terms] OR "Label"[tiab] OR "alias"[tiab] ...): works even when the Wikidata label is not the MeSH heading. */
export function termClause(t: TermSet): string {
  const ns = names(t);
  if (ns.length === 0) return '';
  const parts = [`"${ns[0]}"[MeSH Terms]`, ...ns.map((n) => `"${n}"[tiab]`)];
  return `(${parts.join(' OR ')})`;
}

export function buildPairQuery(subject: TermSet, object: TermSet): string {
  return `${termClause(subject)} AND ${termClause(object)} AND hasabstract`;
}

/** Lower-case match variants: plural/singular and inverted MeSH headings ("Leukocytes, Mononuclear"). */
export function matchVariants(t: TermSet): string[] {
  const v = new Set<string>();
  for (const n of names(t)) {
    const l = n.toLowerCase();
    v.add(l.length > 4 ? l.replace(/s$/, '') : l);
    const m = l.match(/^([^,]+),\s*([^,]+)$/);
    if (m) {
      const swapped = `${m[2]} ${m[1]}`;
      v.add(swapped.length > 4 ? swapped.replace(/s$/, '') : swapped);
    }
  }
  return Array.from(v);
}

const hit = (text: string, variants: string[]) => {
  const l = text.toLowerCase();
  return variants.some((x) => l.includes(x));
};

export function splitSentences(t: string): string[] {
  return t.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).map((s) => s.trim()).filter(Boolean);
}

/* ---- efetch XML (regex based so that it also runs under Node for the tests) ---- */

export interface ArticleInfo {
  pmid: string;
  title: string;
  abstract: string;
  journal: string;
  year: string;
  authors: string;
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
const text = (s: string) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function parsePubmedXml(xml: string): ArticleInfo[] {
  const out: ArticleInfo[] = [];
  for (const m of xml.matchAll(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/g)) {
    const a = m[0];
    const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(a)?.[1];
    if (!pmid) continue;
    const authors = [...a.matchAll(/<Author\b[\s\S]*?<\/Author>/g)]
      .map((x) => {
        const last = /<LastName>([\s\S]*?)<\/LastName>/.exec(x[0])?.[1];
        const ini = /<Initials>([\s\S]*?)<\/Initials>/.exec(x[0])?.[1];
        return last ? text(`${last} ${ini ?? ''}`) : '';
      })
      .filter(Boolean);
    const medline = /<PubDate>[\s\S]*?<MedlineDate>([\s\S]*?)<\/MedlineDate>/.exec(a)?.[1];
    out.push({
      pmid,
      title: text(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/.exec(a)?.[1] ?? ''),
      abstract: [...a.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((x) => text(x[1])).join(' '),
      journal: text(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/.exec(a)?.[1] ?? ''),
      year: /<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/.exec(a)?.[1] ?? (medline ? text(medline).slice(0, 4) : ''),
      authors: authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''),
    });
  }
  return out;
}

/* ---- ranking of one pair's candidate papers ---- */

const LEVEL_RANK: Record<PubMedReference['matchLevel'], number> = { 'sentence-with-relation': 3, sentence: 2, abstract: 1 };

export function rankCandidates(
  articles: ArticleInfo[],
  subject: TermSet,
  object: TermSet,
  pid: string | undefined,
  queryUsed: string,
  hitCount: number
): PubMedReference[] {
  const sv = matchVariants(subject);
  const ov = matchVariants(object);
  const kws = (pid && RELATION_KEYWORDS[pid]) || [];
  const scored = articles.map((art, order) => {
    const sentences = splitSentences(`${art.title}. ${art.abstract}`);
    const both = sentences.filter((s) => hit(s, sv) && hit(s, ov));
    const rel = kws.length ? both.filter((s) => hit(s, kws)) : [];
    const whole = `${art.title} ${art.abstract}`;
    const level: PubMedReference['matchLevel'] | null = rel.length
      ? 'sentence-with-relation'
      : both.length
      ? 'sentence'
      : hit(whole, sv) && hit(whole, ov)
      ? 'abstract'
      : null;
    const evidence = (rel.length ? rel : both.length ? both : sentences.filter((s) => hit(s, sv) || hit(s, ov))).slice(0, 2);
    return { art, order, level, evidence };
  });
  return scored
    .filter((x): x is typeof x & { level: PubMedReference['matchLevel'] } => x.level !== null)
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.order - b.order)
    .map(({ art, level, evidence }) => ({
      pmid: art.pmid,
      title: art.title,
      journal: art.journal,
      pubDate: art.year,
      authors: art.authors,
      queryUsed,
      matchLevel: level,
      hitCount,
      evidence,
    }));
}

/* ---- the search itself ---- */

export interface PairRequest {
  id: string;
  subject: TermSet;
  object: TermSet;
  pid?: string;
}

export type PairResult =
  | { id: string; best: PubMedReference | null; candidates: PubMedReference[] }
  | { id: string; error: string };

export interface FindOptions {
  apiKey?: string;
  signal?: AbortSignal;
  /** called as soon as a pair is finished, so results appear progressively */
  onResult: (r: PairResult) => void;
  /** pairs sharing one combined esearch (default 4; 1 = one search per pair) */
  groupSize?: number;
  /** groups whose abstracts are fetched in one efetch call (default 3) */
  chunkGroups?: number;
  /** override the request spacing (tests) */
  intervalMs?: number;
  /** base priority; single-row refreshes use a high one so they jump the queue */
  priority?: number;
}

const chunked = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const pairClause = (r: PairRequest) => `${termClause(r.subject)} AND ${termClause(r.object)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * NCBI limits the call rate (3/s, 10/s with a key), so the cost is the NUMBER of calls:
 *  - 4 pairs share one esearch: (pair1) OR (pair2) OR ... AND hasabstract
 *  - the abstracts of 3 such groups come back in ONE efetch
 *  - every abstract is then checked sentence by sentence, per pair, so a hit only counts if it
 *    really names both items of THAT pair (the OR query is only used to collect candidates)
 *  - a pair for which the shared search yields nothing is searched on its own afterwards
 *    (lower priority), so recall is the same as with one search per pair
 */
export async function findReferences(requests: PairRequest[], opts: FindOptions): Promise<void> {
  ncbiLimiter.intervalMs = opts.intervalMs ?? (opts.apiKey ? 110 : 360);
  const keyParam: Record<string, string> = opts.apiKey ? { api_key: opts.apiKey } : {};
  const base = opts.priority ?? 0;
  const groupSize = Math.max(1, opts.groupSize ?? 4);
  const form = (o: Record<string, string>) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tool: 'mesh2wikidata-linker', ...keyParam, ...o }).toString(),
  });

  const esearch = (term: string, retmax: number, priority: number) =>
    ncbiLimiter.schedule(
      async () => {
        const js = await fetchJson(`${EUTILS}/esearch.fcgi`, { ...form({ db: 'pubmed', retmode: 'json', retmax: String(retmax), sort: 'relevance', term }), timeoutMs: 15000 }, opts.signal);
        return { ids: (js?.esearchresult?.idlist ?? []) as string[], count: parseInt(js?.esearchresult?.count ?? '0', 10) || 0 };
      },
      { priority, signal: opts.signal }
    );

  const efetch = async (pmids: string[], priority: number): Promise<Map<string, ArticleInfo>> => {
    if (pmids.length === 0) return new Map();
    const xml = await ncbiLimiter.schedule(
      () => fetchText(`${EUTILS}/efetch.fcgi`, { ...form({ db: 'pubmed', retmode: 'xml', id: pmids.join(',') }), timeoutMs: 25000 }, opts.signal),
      { priority, signal: opts.signal }
    );
    return new Map(parsePubmedXml(xml).map((a) => [a.pmid, a]));
  };

  const finish = (req: PairRequest, ids: string[], articles: Map<string, ArticleInfo>, count: number) => {
    const found = ids.map((id) => articles.get(id)).filter((a): a is ArticleInfo => !!a);
    return rankCandidates(found, req.subject, req.object, req.pid, buildPairQuery(req.subject, req.object), count).slice(0, 5);
  };

  const groups = chunked(requests, groupSize);
  await Promise.all(
    chunked(groups, Math.max(1, opts.chunkGroups ?? 3)).map(async (chunk, ci) => {
      // phase 1: one combined search per group
      const searched = await Promise.all(
        chunk.map(async (reqs) => {
          try {
            const term = reqs.length === 1 ? `${pairClause(reqs[0])} AND hasabstract` : `(${reqs.map((r) => `(${pairClause(r)})`).join(' OR ')}) AND hasabstract`;
            const { ids, count } = await esearch(term, reqs.length === 1 ? 8 : 15 * reqs.length, base + 1000 - ci);
            return { reqs, ids, count: reqs.length === 1 ? count : 0, error: undefined as string | undefined };
          } catch (e) {
            if (opts.signal?.aborted) throw e;
            return { reqs, ids: [] as string[], count: 0, error: errText(e) };
          }
        })
      );

      let articles = new Map<string, ArticleInfo>();
      let fetchError: string | undefined;
      try {
        articles = await efetch(Array.from(new Set(searched.flatMap((g) => g.ids))), base + 5000 - ci);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        fetchError = errText(e);
      }

      // phase 2: per-pair attribution; pairs without a hit are searched on their own
      const retry: PairRequest[] = [];
      for (const g of searched) {
        for (const req of g.reqs) {
          if (g.ids.length > 0 && fetchError) {
            opts.onResult({ id: req.id, error: fetchError });
            continue;
          }
          const ranked = g.ids.length > 0 ? finish(req, g.ids, articles, g.count) : [];
          if (ranked.length > 0) opts.onResult({ id: req.id, best: ranked[0], candidates: ranked });
          else if (g.reqs.length === 1 && !g.error) opts.onResult({ id: req.id, best: null, candidates: [] });
          else retry.push(req);
        }
      }
      if (retry.length === 0) return;

      const single = await Promise.all(
        retry.map(async (req) => {
          try {
            const { ids, count } = await esearch(`${pairClause(req)} AND hasabstract`, 8, base - 5000 - ci);
            return { req, ids, count, error: undefined as string | undefined };
          } catch (e) {
            if (opts.signal?.aborted) throw e;
            return { req, ids: [] as string[], count: 0, error: errText(e) };
          }
        })
      );
      let more = new Map<string, ArticleInfo>();
      let moreError: string | undefined;
      try {
        more = await efetch(Array.from(new Set(single.flatMap((x) => x.ids))), base - 4000 - ci);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        moreError = errText(e);
      }
      for (const x of single) {
        if (x.error) opts.onResult({ id: x.req.id, error: x.error });
        else if (x.ids.length > 0 && moreError) opts.onResult({ id: x.req.id, error: moreError });
        else {
          const ranked = x.ids.length > 0 ? finish(x.req, x.ids, more, x.count) : [];
          opts.onResult({ id: x.req.id, best: ranked[0] ?? null, candidates: ranked });
        }
      }
    })
  );
}
