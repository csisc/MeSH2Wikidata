#!/usr/bin/env node
/**
 * Build-time helper: downloads the complete MeSH descriptor ID (P486) -> Wikidata item table once,
 * so the browser never has to run a SPARQL lookup for it. Output: public/data/mesh2qid.json
 *   { "D009062": "Q123", "D010781": ["Q1", "Q2"], ... }   (arrays only where several items share an ID)
 *
 * Run by the GitHub Actions workflow before the build. If the query service is unavailable the script
 * exits 0 without writing anything and the app falls back to live lookups.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const QUERY = 'SELECT ?mesh ?item WHERE { ?item wdt:P486 ?mesh . }';

export function bindingsToMap(bindings) {
  const out = {};
  for (const b of bindings) {
    const mesh = b.mesh?.value;
    const qid = (b.item?.value || '').split('/').pop();
    if (!/^[A-Z]\d{6,9}$/.test(mesh || '') || !/^Q\d+$/.test(qid || '')) continue;
    const cur = out[mesh];
    if (!cur) out[mesh] = qid;
    else if (Array.isArray(cur)) {
      if (!cur.includes(qid)) cur.push(qid);
    } else if (cur !== qid) out[mesh] = [cur, qid];
  }
  return out;
}

async function main() {
  const dest = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/mesh2qid.json');
  const res = await fetch('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'User-Agent': 'MeSH2Wikidata-linker build script (https://github.com/csisc/MeSH2Wikidata)',
    },
    body: new URLSearchParams({ query: QUERY }).toString(),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Wikidata Query Service answered HTTP ${res.status}`);
  const map = bindingsToMap((await res.json()).results.bindings);
  const n = Object.keys(map).length;
  if (n < 1000) throw new Error(`only ${n} MeSH IDs returned; refusing to write a suspiciously small table`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(map));
  console.log(`Wrote ${n} MeSH descriptor IDs to ${dest}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.warn(`MeSH map not built (${e.message}); the app will resolve MeSH IDs live.`);
  });
}
