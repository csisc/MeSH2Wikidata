# MeSH-to-Wikidata Linker

A curation tool that turns pairs of MeSH descriptors with high Pointwise Mutual Information
(`public/data/missing_rels.csv`) into reviewed Wikidata statements, exported as QuickStatements.
It runs entirely in the browser and needs no server.

## What it does for each batch of 100 rows

| Step | How | Source |
|---|---|---|
| MeSH descriptor ID → Wikidata item | one SPARQL query on **P486** (MeSH descriptor ID); label, description and MeSH tree numbers (**P672**) come back with it | Wikidata Query Service |
| Existing statements | one SPARQL query for every non-deprecated statement between the two items, in both directions, any property, with its reference count and PubMed IDs; a relation that already exists *and* already cites the PubMed paper is not exported again | Wikidata Query Service |
| Property suggestion | rule-based domain/range scorer (default), or a **local LLM through Ollama** that must pick from the candidate list or answer `NONE` | your machine |
| Reference | PubMed search: papers indexed with both MeSH terms (with a subheading hint for the chosen property first), then a title/abstract fallback; the inspector says which kind of match it is | NCBI E-utilities |
| Export | QuickStatements V1 with `S698` (PubMed ID) and `S813` (retrieved) | – |

Nothing is faked: a MeSH ID with no Wikidata item (or a qualifier such as `Q000523`) is shown as unresolved and
cannot be approved; failed network calls are shown as errors, never replaced by placeholder data.

## Things a curator must know

* A PubMed hit means the two MeSH terms are indexed together in that paper. For properties without a subheading hint
  this shows co-occurrence only, so read the paper before approving. The inspector says which kind of match it is.
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
