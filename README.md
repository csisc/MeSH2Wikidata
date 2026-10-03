# MeSH-to-Wikidata Linker

A curation tool that turns pairs of MeSH descriptors with high Pointwise Mutual Information
(`public/data/missing_rels.csv`) into reviewed Wikidata statements, exported as QuickStatements.
It runs entirely in the browser and needs no server.

## What it does for each batch of 100 rows

| Step | How | Source |
|---|---|---|
| MeSH descriptor ID → Wikidata item | **P486** lookup: browser cache and the prebuilt `mesh2qid.json` first, otherwise one lean SPARQL query for the missing IDs | Wikidata Query Service |
| Labels, aliases, MeSH tree codes (**P672**) and all statements of those items | one `wbgetentities` call per 50 items, several in parallel | Wikibase API |
| Does the relation already exist, with which references? | decided **locally** from the statements just fetched (both directions, any property, deprecated ones ignored, reference count and PubMed IDs) | – |
| Property suggestion | rule-based domain/range scorer (default), or a **local LLM through Ollama** that must pick from the best-fitting candidates or answer `NONE` | your machine |
| Reference | PubMed: 4 pairs share one search, 3 such groups share one abstract download; each abstract is then checked sentence by sentence for *both* items of the pair (names, aliases, MeSH heading), and a sentence containing a word typical for the property ranks first | NCBI E-utilities |
| Export | QuickStatements V1 with `S698` (PubMed ID) and `S813` (retrieved) | – |

### Why it is fast

* The first batch appears while the 25 MB CSV is still being read (streamed parse); the rest is parsed in the background.
* Wikidata work is a handful of parallel requests and the duplicate/reference check needs no SPARQL at all.
* The next batch is resolved in the background while you review the current one, so paging is instant.
* The local model and PubMed run concurrently with each other; results appear row by row, the selected row first.
* Every request has a timeout (and one retry), so a slow server shows an error instead of hanging.
* PubMed allows 3 requests/second, or 10 with a free [NCBI API key](https://www.ncbi.nlm.nih.gov/account/settings/):
  paste it under *Property Classifier*. 100 pairs take about 35 requests, i.e. roughly 12 s without and 4 s with a key.
* `scripts/build-mesh-map.mjs` (run by the deploy workflow, optional) downloads the whole MeSH→Wikidata table at build
  time, so the browser needs no ID lookup at all.

Nothing is faked: a MeSH ID with no Wikidata item (or a qualifier such as `Q000523`) is shown as unresolved and
cannot be approved; failed network calls are shown as errors, never replaced by placeholder data.

## Things a curator must know

* A PubMed hit always names both items in its title/abstract; the inspector shows the matching sentence(s) and says
  whether they also contain a word typical for the chosen property. That is evidence to read, not proof: check it
  before approving. Other candidate papers can be selected with one click.
* The duplicate check is derived from the *currently selected* property: changing the property updates it.
* The "Approve novel" bulk action skips rows that are unresolved, already in Wikidata, not yet checked, or below the
  confidence threshold set under *Property Classifier*.
* The curated list has 52 item-valued properties in seven groups (treatment & clinical, disease mechanisms, genes &
  molecular biology, anatomy & cells, organisms, chemistry & pharmacology, general/structural). It lives in
  `src/data/biomedicalOntology.ts`; add a property by appending one `p(...)` line.
* At startup every ID is compared with its live Wikidata label. A mismatch or missing property is **switched off**
  and reported in the banner and under *Property Classifier*, so a wrong ID can never reach an export.
* For anything not in the list, type a property ID under *Other property ID* in the inspector. The app checks that it
  exists and takes item values, and marks the row as hand-added.
* Where the category pair cannot separate two properties (for example disease → disease: symptom, cause or subclass),
  the rule-based scorer marks the row *ambiguous* and keeps its confidence below the bulk-approve threshold.

## Local LLM (optional)

```bash
ollama pull llama3.1:8b
OLLAMA_ORIGINS="http://localhost:3000" ollama serve   # or your GitHub Pages origin
```

Select *Local LLM through Ollama* under *Property Classifier*. If the server is unreachable the queue falls back to the
rule-based scorer and shows a warning. An NCBI API key (optional) raises the PubMed limit from 3 to 10 requests/second.

## Development

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # unit tests for the data layer (mocked network)
npm run build
```

## Hosting on GitHub Pages

1. Push this folder to a GitHub repository (branch `main`).
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` runs the tests, builds and publishes the site at
   `https://<user>.github.io/<repo>/` (see the *Deploy to GitHub Pages* run under the **Actions** tab).

Notes:

* The build uses relative asset paths (`base: './'`), so it works under any repository name or custom domain.
* The 25 MB dataset is served as a static file from `public/data/missing_rels.csv`; GitHub accepts files up to 100 MB.
* Run `npm install` once locally and commit the generated `package-lock.json`, so the workflow installs exactly the
  versions you tested (it falls back to `npm install` when no lock file exists).
* The page only calls Wikidata, NCBI and, optionally, your own Ollama server. The Wikidata and NCBI services allow
  browser (CORS) requests; for Ollama see above. Chrome and Firefox allow an HTTPS page to call `http://localhost`,
  Safari may block it: use Chrome/Firefox for the local-LLM mode.
* Curation decisions live in the browser tab only. Export your batch before closing the page.
