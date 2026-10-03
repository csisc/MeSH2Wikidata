import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  Check,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  CheckCheck,
  RotateCcw,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import {
  DatasetInfoResponse,
  LlmConfig,
  MeshEntityInfo,
  ProcessedRelationRecord,
  WikidataPropertySpec,
} from './types';
import { WIKIDATA_BIOMEDICAL_PROPERTIES } from './data/biomedicalOntology';
import { classifyRuleBased, classifyWithOllama, loadConfig, saveConfig } from './lib/classifier';
import { parseCsv, ParsedCsv, RawCsvRow } from './lib/csv';
import { fetchPropertySpec, findExistingLinks, PropertyCheck, resolveMeshIds, verifyProperties } from './lib/wikidata';
import { findPubMedReference } from './lib/pubmed';
import { canApprove, existingExact, isExactDuplicate } from './lib/quickstatements';
import { RelationInspector } from './components/RelationInspector';
import { QuickStatementsModal } from './components/QuickStatementsModal';
import { StorageAndLlmPanel } from './components/StorageAndLlmPanel';

const MAX_BATCH_SIZE = 100;

/** Only used when ./data/missing_rels.csv cannot be fetched (e.g. opened from file://). */
const SAMPLE_CSV = `Tuple,PMI
"('D009068', 'D000222')",2.55
"('D009068', 'D001480')",2.09
"('D010781', 'D012680')",2.78
"('D010781', 'D007089')",5.79
"('D007963', 'D008815')",3.32
"('D004333', 'D000577')",2.16
`;

const pendingEntity = (meshId: string): MeshEntityInfo => ({
  meshId,
  qid: null,
  label: meshId,
  description: 'Resolving through Wikidata...',
  semanticGroup: null,
  treeNumbers: [],
  resolution: 'pending',
});

const isResolved = (e: MeshEntityInfo) => e.resolution === 'resolved' || e.resolution === 'ambiguous';
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const keyOf = (r: RawCsvRow) => `${r.subjectMeshId}_${r.objectMeshId}`;

function QidLink({ entity }: { entity: MeshEntityInfo }) {
  if (entity.qid) {
    return (
      <a
        href={`https://www.wikidata.org/wiki/${entity.qid}`}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-blue-600 hover:underline"
        title={entity.resolution === 'ambiguous' ? `Several items share this MeSH ID: ${(entity.candidateQids ?? []).join(', ')}` : undefined}
      >
        {entity.qid}
        {entity.resolution === 'ambiguous' ? ' ⚠' : ''}
      </a>
    );
  }
  const text: Record<string, string> = {
    pending: 'resolving…',
    'not-found': 'no Wikidata item',
    qualifier: 'qualifier, not a descriptor',
    error: 'lookup failed',
  };
  return <span className="text-rose-700">{text[entity.resolution] ?? 'unresolved'}</span>;
}

interface PipelineState {
  label: string;
  done: number;
  total: number;
}

export default function App() {
  const [activeNav, setActiveNav] = useState<'queue' | 'storage' | 'llm'>('queue');
  const [exportModalOpen, setExportModalOpen] = useState(false);

  const [rawCsvString, setRawCsvString] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv>(() => parseCsv(SAMPLE_CSV));
  const [csvSource, setCsvSource] = useState<'sample' | 'bundled' | 'upload'>('sample');
  const [currentBatchIndex, setCurrentBatchIndex] = useState(0);
  const [csvLoading, setCsvLoading] = useState(true);

  const [config, setConfigState] = useState<LlmConfig>(() => loadConfig());
  const configRef = useRef(config);
  const updateConfig = useCallback((cfg: LlmConfig) => {
    configRef.current = cfg;
    setConfigState(cfg);
    saveConfig(cfg);
  }, []);

  // The ref is the source of truth (async pipeline code reads it between awaits);
  // React state only mirrors it for rendering.
  const recordsRef = useRef<Map<string, ProcessedRelationRecord>>(new Map());
  const [processedRelations, setProcessedRelations] = useState<Map<string, ProcessedRelationRecord>>(recordsRef.current);
  const commit = useCallback((fn: (m: Map<string, ProcessedRelationRecord>) => void) => {
    const copy = new Map(recordsRef.current);
    fn(copy);
    recordsRef.current = copy;
    setProcessedRelations(copy);
  }, []);
  const meshCache = useRef(new Map<string, MeshEntityInfo>());

  // Candidate properties: the curated list minus any whose ID fails the live Wikidata label check.
  const [propChecks, setPropChecks] = useState<PropertyCheck[]>([]);
  const [propsReady, setPropsReady] = useState(false);
  const [propertyWarnings, setPropertyWarnings] = useState<string[]>([]);
  // If (nearly) everything fails the check, the check itself is broken: keep the curated list rather than
  // switching the whole catalogue off.
  const excludedPids = useMemo(() => {
    const bad = propChecks.filter((c) => !c.ok).map((c) => c.pid);
    return propChecks.length > 0 && bad.length > propChecks.length / 2 ? [] : bad;
  }, [propChecks]);
  const activeProps = useMemo(
    () => WIKIDATA_BIOMEDICAL_PROPERTIES.filter((x) => !excludedPids.includes(x.pid)),
    [excludedPids]
  );
  const propsRef = useRef<WikidataPropertySpec[]>(WIKIDATA_BIOMEDICAL_PROPERTIES);
  propsRef.current = activeProps;
  const customProps = useRef(new Map<string, WikidataPropertySpec>());

  const runPropertyCheck = useCallback(async (): Promise<PropertyCheck[]> => {
    const res = await verifyProperties(WIKIDATA_BIOMEDICAL_PROPERTIES);
    setPropChecks(res);
    return res;
  }, []);

  useEffect(() => {
    let cancelled = false;
    runPropertyCheck()
      .then((res) => {
        const bad = res.filter((c) => !c.ok);
        if (!cancelled && bad.length > res.length / 2) {
          setPropertyWarnings([
            `${bad.length} of ${res.length} property IDs failed the Wikidata label check, which looks like a problem with the check, not with the IDs. Using the curated list unchanged; open Property Classifier to inspect.`,
          ]);
        } else if (!cancelled && bad.length > 0) {
          setPropertyWarnings([
            `${bad.length} configured property ID(s) do not match their Wikidata label and were switched off: ${bad.map((b) => b.pid).join(', ')}. See Property Classifier.`,
          ]);
        }
      })
      .catch((e) => {
        if (!cancelled) setPropertyWarnings([`Property IDs could not be verified against Wikidata (${errMsg(e)}); using the curated list as is.`]);
      })
      .finally(() => !cancelled && setPropsReady(true));
    return () => {
      cancelled = true;
    };
  }, [runPropertyCheck]);

  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [pipelineErrors, setPipelineErrors] = useState<string[]>([]);
  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [hideDuplicates, setHideDuplicates] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);

  const rows = parsed.rows;

  // Load the bundled CSV once (it is served as a static file next to the app).
  useEffect(() => {
    let cancelled = false;
    fetch('./data/missing_rels.csv')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        const p = parseCsv(text);
        if (p.rows.length > 0) {
          setRawCsvString(text);
          setParsed(p);
          setCsvSource('bundled');
        }
      })
      .catch(() => {
        if (!cancelled) setPipelineErrors(['Could not load ./data/missing_rels.csv; showing a 6-row sample. Upload your CSV on the Pipeline Storage tab.']);
      })
      .finally(() => !cancelled && setCsvLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback(
    (id: string, fn: (r: ProcessedRelationRecord) => ProcessedRelationRecord) => {
      if (!recordsRef.current.has(id)) return;
      commit((m) => m.set(id, fn(m.get(id)!)));
    },
    [commit]
  );

  const makeRecord = useCallback((row: RawCsvRow): ProcessedRelationRecord => {
    const subject = meshCache.current.get(row.subjectMeshId) ?? pendingEntity(row.subjectMeshId);
    const object = meshCache.current.get(row.objectMeshId) ?? pendingEntity(row.objectMeshId);
    const prediction = classifyRuleBased(subject, object, row.pmi, propsRef.current);
    const unresolved = (e: MeshEntityInfo) => e.resolution !== 'pending' && !e.qid;
    return {
      id: keyOf(row),
      rowIndex: row.rowIndex,
      tupleRaw: row.tupleRaw,
      subjectMeshId: row.subjectMeshId,
      objectMeshId: row.objectMeshId,
      pmi: row.pmi,
      subject,
      object,
      selectedProperty: prediction.recommendedProperty,
      llmPrediction: prediction,
      wikidataVerification: { state: unresolved(subject) || unresolved(object) ? 'skipped' : 'pending', existing: [] },
      pubmedReference: null,
      pubmedState: 'idle',
      status: 'pending',
      updatedAt: new Date().toISOString(),
    };
  }, []);

  /**
   * Real enrichment pipeline for one batch of <=100 rows:
   *  1. one SPARQL query maps all MeSH descriptor IDs to Wikidata items (P486)
   *  2. one SPARQL query finds existing statements between each resolved pair
   *  3. optional local LLM (Ollama) picks the property, row by row
   *  4. PubMed E-utilities search finds a reference, row by row (rate limited)
   */
  const loadBatch = useCallback(
    async (batchIdx: number, allRows: RawCsvRow[], force = false) => {
      const runId = ++runRef.current;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const stale = () => runRef.current !== runId || ac.signal.aborted;

      const slice = allRows.slice(batchIdx * MAX_BATCH_SIZE, (batchIdx + 1) * MAX_BATCH_SIZE);
      if (slice.length === 0) return;
      setPipelineErrors((prev) => prev.filter((m) => m.startsWith('Could not load ./data')));

      // Drop failed lookups from the cache when the curator asks for a re-run.
      if (force) {
        for (const [id, e] of meshCache.current) if (e.resolution === 'error') meshCache.current.delete(id);
      }

      commit((copy) => {
        for (const r of slice) {
          const existing = copy.get(keyOf(r));
          if (!existing || (force && existing.status === 'pending' && !isResolved(existing.subject) && !isResolved(existing.object))) {
            copy.set(keyOf(r), existing ? { ...makeRecord(r), status: existing.status } : makeRecord(r));
          }
        }
      });
      setSelectedRelationId((prev) => (prev && slice.some((r) => keyOf(r) === prev) ? prev : keyOf(slice[0])));

      const errors: string[] = [];
      const fail = (m: string) => {
        errors.push(m);
        setPipelineErrors((prev) => [...prev.filter((x) => x !== m), m]);
      };

      try {
        // 1. MeSH -> Wikidata -------------------------------------------------
        const need = Array.from(
          new Set(slice.flatMap((r) => [r.subjectMeshId, r.objectMeshId]).filter((id) => !meshCache.current.has(id)))
        );
        if (need.length > 0) {
          setPipeline({ label: `Resolving ${need.length} MeSH descriptors through Wikidata (P486)`, done: 0, total: 1 });
          try {
            const resolved = await resolveMeshIds(need, ac.signal);
            if (stale()) return;
            for (const [id, e] of resolved) meshCache.current.set(id, e);
          } catch (e) {
            if (isAbort(e) || stale()) return;
            fail(`MeSH to Wikidata lookup failed: ${errMsg(e)}. Use "Re-run checks" to retry.`);
            for (const id of need) {
              meshCache.current.set(id, { ...pendingEntity(id), resolution: 'error', description: `Lookup failed: ${errMsg(e)}` });
            }
          }
        }
        commit((copy) => {
          for (const r of slice) {
            const rec = copy.get(keyOf(r));
            if (!rec) continue;
            const subject = meshCache.current.get(r.subjectMeshId) ?? rec.subject;
            const object = meshCache.current.get(r.objectMeshId) ?? rec.object;
            if (rec.subject === subject && rec.object === object) continue;
            const prediction = classifyRuleBased(subject, object, rec.pmi, propsRef.current);
            const keepProperty = rec.selectedProperty.pid !== rec.llmPrediction.recommendedProperty.pid;
            const bad = (e: MeshEntityInfo) => e.resolution !== 'pending' && !e.qid;
            copy.set(rec.id, {
              ...rec,
              subject,
              object,
              llmPrediction: prediction,
              selectedProperty: keepProperty ? rec.selectedProperty : prediction.recommendedProperty,
              wikidataVerification:
                bad(subject) || bad(object)
                  ? { state: 'skipped', existing: [] }
                  : rec.wikidataVerification.state === 'checked'
                  ? rec.wikidataVerification
                  : { state: 'pending', existing: [] },
            });
          }
        });

        // 2. Existing statements ---------------------------------------------
        const toCheck = slice
          .map((r) => recordsRef.current.get(keyOf(r)))
          .filter((r): r is ProcessedRelationRecord => !!r && !!r.subject.qid && !!r.object.qid && r.wikidataVerification.state !== 'checked');
        if (toCheck.length > 0) {
          setPipeline({ label: `Checking ${toCheck.length} pairs for existing Wikidata statements`, done: 0, total: 1 });
          try {
            const links = await findExistingLinks(
              toCheck.map((r) => ({ key: r.id, subjectQid: r.subject.qid!, objectQid: r.object.qid! })),
              ac.signal
            );
            if (stale()) return;
            const checkedAt = new Date().toISOString();
            commit((copy) => {
              for (const r of toCheck) {
                const rec = copy.get(r.id);
                if (rec) copy.set(r.id, { ...rec, wikidataVerification: { state: 'checked', existing: links.get(r.id) ?? [], checkedAt } });
              }
            });
          } catch (e) {
            if (isAbort(e) || stale()) return;
            fail(`Wikidata duplicate check failed: ${errMsg(e)}. Rows stay unchecked; use "Re-run checks" to retry.`);
            commit((copy) => {
              for (const r of toCheck) {
                const rec = copy.get(r.id);
                if (rec) copy.set(r.id, { ...rec, wikidataVerification: { state: 'error', existing: [], error: errMsg(e) } });
              }
            });
          }
        }

        // 3. Optional local LLM ------------------------------------------------
        const cfg = configRef.current;
        if (cfg.mode === 'ollama') {
          const todo = slice
            .map((r) => recordsRef.current.get(keyOf(r)))
            .filter((r): r is ProcessedRelationRecord => !!r && r.llmPrediction.engine === 'rule-based' && r.status === 'pending' && isResolved(r.subject) && isResolved(r.object));
          for (let i = 0; i < todo.length; i++) {
            if (stale()) return;
            setPipeline({ label: `Asking ${cfg.ollamaModel} to choose properties`, done: i, total: todo.length });
            const rec = todo[i];
            try {
              const pred = await classifyWithOllama(cfg, rec.subject, rec.object, rec.pmi, ac.signal, propsRef.current);
              if (stale()) return;
              patch(rec.id, (cur) => ({
                ...cur,
                llmPrediction: pred,
                selectedProperty: cur.selectedProperty.pid === cur.llmPrediction.recommendedProperty.pid ? pred.recommendedProperty : cur.selectedProperty,
              }));
            } catch (e) {
              if (isAbort(e) || stale()) return;
              fail(`Local model unavailable (${errMsg(e)}). Falling back to the rule-based scorer for this batch. Is Ollama running with OLLAMA_ORIGINS set for this site?`);
              break;
            }
          }
        }

        // 4. PubMed references ---------------------------------------------------
        const refRows = slice
          .map((r) => recordsRef.current.get(keyOf(r)))
          .filter((r): r is ProcessedRelationRecord => !!r && isResolved(r.subject) && isResolved(r.object) && (r.pubmedState === 'idle' || (force && r.pubmedState === 'error')) && !((existingExact(r)?.referenceCount ?? 0) > 0));
        for (let i = 0; i < refRows.length; i++) {
          if (stale()) return;
          setPipeline({ label: 'Searching PubMed for references', done: i, total: refRows.length });
          const rec = recordsRef.current.get(refRows[i].id) ?? refRows[i];
          patch(rec.id, (c) => ({ ...c, pubmedState: 'loading' }));
          try {
            const ref = await findPubMedReference({
              subjectLabel: rec.subject.label,
              objectLabel: rec.object.label,
              pid: rec.selectedProperty.pid,
              apiKey: configRef.current.ncbiApiKey,
              signal: ac.signal,
            });
            if (stale()) return;
            patch(rec.id, (c) => ({ ...c, pubmedReference: ref, pubmedState: ref ? 'found' : 'none', pubmedError: undefined }));
          } catch (e) {
            if (isAbort(e) || stale()) return;
            patch(rec.id, (c) => ({ ...c, pubmedState: 'error', pubmedError: errMsg(e) }));
            fail(`PubMed search error: ${errMsg(e)}`);
            if (/429/.test(errMsg(e))) break;
          }
        }
      } finally {
        if (runRef.current === runId) setPipeline(null);
      }
    },
    [makeRecord, patch, commit]
  );

  useEffect(() => {
    if (!csvLoading && propsReady && rows.length > 0) loadBatch(currentBatchIndex, rows);
    return () => abortRef.current?.abort();
  }, [currentBatchIndex, rows, csvLoading, propsReady, loadBatch]);

  const currentBatchRelations = useMemo(() => {
    const slice = rows.slice(currentBatchIndex * MAX_BATCH_SIZE, (currentBatchIndex + 1) * MAX_BATCH_SIZE);
    return slice.map((r) => processedRelations.get(keyOf(r))).filter((r): r is ProcessedRelationRecord => !!r);
  }, [currentBatchIndex, rows, processedRelations]);

  const totalBatches = Math.max(1, Math.ceil(rows.length / MAX_BATCH_SIZE));
  const loadingBatch = csvLoading;

  const handleDecision = useCallback(
    (id: string, status: 'approved' | 'rejected' | 'pending') => {
      patch(id, (item) => (status === 'approved' && !canApprove(item) ? item : { ...item, status, updatedAt: new Date().toISOString() }));
    },
    [patch]
  );

  const handlePropertyChange = useCallback(
    (id: string, pid: string) => {
      patch(id, (item) => {
        const prop =
          propsRef.current.find((x) => x.pid === pid) ??
          customProps.current.get(pid) ??
          item.llmPrediction.alternatives.find((a) => a.property.pid === pid)?.property;
        return prop ? { ...item, selectedProperty: prop, updatedAt: new Date().toISOString() } : item;
      });
    },
    [patch]
  );

  /** One-off override with any item-valued Wikidata property; throws a readable message when invalid. */
  const handleCustomProperty = useCallback(
    async (id: string, pid: string) => {
      const spec = await fetchPropertySpec(pid);
      customProps.current.set(spec.pid, spec);
      patch(id, (item) => ({ ...item, selectedProperty: spec, updatedAt: new Date().toISOString() }));
    },
    [patch]
  );

  const optionsFor = (rel: ProcessedRelationRecord): WikidataPropertySpec[] =>
    activeProps.some((x) => x.pid === rel.selectedProperty.pid) ? activeProps : [rel.selectedProperty, ...activeProps];

  // Manual PubMed refresh for one row, using the property currently selected.
  const handleRefreshPubMed = useCallback(
    async (id: string) => {
      const item = recordsRef.current.get(id);
      if (!item) return;
      patch(id, (c) => ({ ...c, pubmedState: 'loading', pubmedError: undefined }));
      try {
        const ref = await findPubMedReference({
          subjectLabel: item.subject.label,
          objectLabel: item.object.label,
          pid: item.selectedProperty.pid,
          apiKey: configRef.current.ncbiApiKey,
        });
        patch(id, (c) => ({ ...c, pubmedReference: ref, pubmedState: ref ? 'found' : 'none' }));
      } catch (e) {
        patch(id, (c) => ({ ...c, pubmedState: 'error', pubmedError: errMsg(e) }));
      }
    },
    [patch]
  );

  const handleBulkDecision = (status: 'approved' | 'pending') => {
    commit((copy) => {
      for (const rel of currentBatchRelations) {
        if (status === 'approved') {
          if (rel.status !== 'pending') continue;
          if (!canApprove(rel) || isExactDuplicate(rel)) continue;
          if (rel.wikidataVerification.state !== 'checked') continue;
          if (rel.llmPrediction.confidence < configRef.current.minConfidence) continue;
        }
        copy.set(rel.id, { ...rel, status, updatedAt: new Date().toISOString() });
      }
    });
  };

  const handleUploadCsv = async (csvContent: string) => {
    const p = parseCsv(csvContent);
    if (p.rows.length === 0) throw new Error('No valid "(\'D…\', \'D…\')",PMI rows found in the CSV.');
    setRawCsvString(csvContent);
    setParsed(p);
    setCsvSource('upload');
    commit((m) => m.clear());
    setCurrentBatchIndex(0);
  };

  const handleRerun = () => loadBatch(currentBatchIndex, rows, true);

  const filteredRelations = useMemo(() => {
    return currentBatchRelations.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (hideDuplicates && isExactDuplicate(r)) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const match =
          r.subjectMeshId.toLowerCase().includes(q) ||
          r.objectMeshId.toLowerCase().includes(q) ||
          r.subject.label.toLowerCase().includes(q) ||
          r.object.label.toLowerCase().includes(q) ||
          (r.subject.qid ?? '').toLowerCase().includes(q) ||
          (r.object.qid ?? '').toLowerCase().includes(q) ||
          r.selectedProperty.pid.toLowerCase().includes(q) ||
          r.selectedProperty.label.toLowerCase().includes(q) ||
          (r.pubmedReference?.pmid ?? '').includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [currentBatchRelations, statusFilter, hideDuplicates, searchQuery]);

  const selectedRelation: ProcessedRelationRecord | null = useMemo(
    () => (selectedRelationId ? processedRelations.get(selectedRelationId) || null : null),
    [processedRelations, selectedRelationId]
  );

  const batchCounts = useMemo(() => {
    let pending = 0, approved = 0, rejected = 0, duplicates = 0, unresolved = 0;
    for (const r of currentBatchRelations) {
      if (r.status === 'pending') pending++;
      else if (r.status === 'approved') approved++;
      else rejected++;
      if (isExactDuplicate(r)) duplicates++;
      if (!canApprove(r) && r.subject.resolution !== 'pending' && r.object.resolution !== 'pending') unresolved++;
    }
    return { total: currentBatchRelations.length, pending, approved, rejected, duplicates, unresolved };
  }, [currentBatchRelations]);

  const allApprovedRelations = useMemo(
    () => Array.from(processedRelations.values()).filter((r) => r.status === 'approved'),
    [processedRelations]
  );

  const datasetInfo: DatasetInfoResponse = useMemo(() => {
    let approvedCount = 0, rejectedCount = 0, pendingCount = 0, duplicateCount = 0;
    for (const r of processedRelations.values()) {
      if (r.status === 'approved') approvedCount++;
      else if (r.status === 'rejected') rejectedCount++;
      else pendingCount++;
      if (isExactDuplicate(r)) duplicateCount++;
    }
    return {
      fileName: csvSource === 'upload' ? 'uploaded CSV' : 'missing_rels.csv',
      storagePath: csvSource === 'bundled' ? './data/missing_rels.csv' : csvSource === 'upload' ? '(browser memory)' : '(built-in 6-row sample)',
      totalRows: rows.length,
      skippedRows: parsed.skipped,
      maxBatchSize: MAX_BATCH_SIZE,
      totalBatches,
      processedTotal: processedRelations.size,
      stats: { approvedCount, rejectedCount, pendingCount, duplicateCount },
      availableProperties: WIKIDATA_BIOMEDICAL_PROPERTIES,
      excludedPids,
    };
  }, [rows.length, parsed.skipped, csvSource, totalBatches, processedRelations, excludedPids]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeNav !== 'queue' || exportModalOpen || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return;
      if (!selectedRelation) return;
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        handleDecision(selectedRelation.id, selectedRelation.status === 'approved' ? 'pending' : 'approved');
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleDecision(selectedRelation.id, selectedRelation.status === 'rejected' ? 'pending' : 'rejected');
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = filteredRelations.findIndex((item) => item.id === selectedRelation.id);
        if (idx !== -1) {
          const nextIdx = e.key === 'ArrowDown' ? Math.min(filteredRelations.length - 1, idx + 1) : Math.max(0, idx - 1);
          setSelectedRelationId(filteredRelations[nextIdx].id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeNav, exportModalOpen, selectedRelation, filteredRelations, handleDecision]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between px-6 py-3.5 bg-white border-b border-slate-200 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#queue"
          onClick={(e) => {
            e.preventDefault();
            setActiveNav('queue');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 font-display"
        >
          MeSH-to-Wikidata Linker
        </a>

        {/* Zone 2: 4 clean text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a
            href="#queue"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('queue');
            }}
            className={`transition-colors whitespace-nowrap ${
              activeNav === 'queue'
                ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-blue-600'
                : 'hover:text-slate-900'
            }`}
          >
            Pending Queue
          </a>
          <a
            href="#storage"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('storage');
            }}
            className={`transition-colors whitespace-nowrap ${
              activeNav === 'storage'
                ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-blue-600'
                : 'hover:text-slate-900'
            }`}
          >
            Pipeline Storage
          </a>
          <a
            href="#llm"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('llm');
            }}
            className={`transition-colors whitespace-nowrap ${
              activeNav === 'llm'
                ? 'text-slate-900 underline underline-offset-8 decoration-2 decoration-blue-600'
                : 'hover:text-slate-900'
            }`}
          >
            Property Classifier
          </a>
          <a
            href="#export"
            onClick={(e) => {
              e.preventDefault();
              setExportModalOpen(true);
            }}
            className="hover:text-slate-900 transition-colors whitespace-nowrap"
          >
            QuickStatements Export
          </a>
        </nav>

        {/* Zone 3: Primary action */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setExportModalOpen(true)}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer"
          >
            Export QuickStatements ({datasetInfo.stats.approvedCount})
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      {activeNav !== 'queue' ? (
        <main className="flex-1">
          <StorageAndLlmPanel
            activeSection={activeNav}
            datasetInfo={datasetInfo}
            onUploadCsv={handleUploadCsv}
            onReturnToQueue={() => setActiveNav('queue')}
            rawCsvString={rawCsvString}
            config={config}
            onConfigChange={updateConfig}
            propertyChecks={propChecks}
            onVerifyProperties={runPropertyCheck}
          />
        </main>
      ) : (
        <main className="flex-1 flex flex-col">
          {/* Batch Workload & Telemetry Control Bar (Strict 100-relation batch limit) */}
          <div className="bg-white border-b border-slate-200 px-6 py-3 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
              <span className="font-semibold text-slate-900">
                Source: <span className="font-mono">missing_rels.csv</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                Batch {currentBatchIndex + 1} of {totalBatches} (Rows{' '}
                {currentBatchIndex * MAX_BATCH_SIZE + 1}–
                {Math.min((currentBatchIndex + 1) * MAX_BATCH_SIZE, rows.length)} of{' '}
                {rows.length})
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-blue-700 font-medium">
                Workload Cap: 100 relations / batch
              </span>
            </div>

            {/* Batch Pagination Controls */}
            <div className="flex items-center gap-2">
              <label htmlFor="batch-selector" className="text-xs text-slate-500">
                Active Batch (100 max):
              </label>
              <select
                id="batch-selector"
                value={currentBatchIndex}
                onChange={(e) => setCurrentBatchIndex(parseInt(e.target.value, 10))}
                className="text-xs font-mono bg-slate-50 border border-slate-300 rounded px-2.5 py-1.5 text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {Array.from({ length: totalBatches }).map((_, idx) => {
                  const start = idx * 100 + 1;
                  const end = Math.min((idx + 1) * 100, rows.length);
                  return (
                    <option key={idx} value={idx}>
                      Batch {idx + 1} (Rows {start}–{end})
                    </option>
                  );
                })}
              </select>

              <button
                type="button"
                disabled={currentBatchIndex <= 0 || loadingBatch}
                onClick={() => setCurrentBatchIndex((prev) => Math.max(0, prev - 1))}
                className="p-1.5 border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                title="Previous 100 relations"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                disabled={currentBatchIndex >= totalBatches - 1 || loadingBatch}
                onClick={() => setCurrentBatchIndex((prev) => Math.min(totalBatches - 1, prev + 1))}
                className="p-1.5 border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                title="Next 100 relations"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Live pipeline status & errors */}
          {(pipeline || pipelineErrors.length > 0 || propertyWarnings.length > 0 || batchCounts.unresolved > 0) && (
            <div className="px-6 py-2 bg-white border-b border-slate-200 space-y-1 text-xs">
              {pipeline && (
                <p className="text-blue-700 font-medium tabular-nums">
                  ⟳ {pipeline.label}
                  {pipeline.total > 1 ? ` (${pipeline.done}/${pipeline.total})` : '…'}
                </p>
              )}
              {[...propertyWarnings, ...pipelineErrors].map((m) => (
                <p key={m} className="text-amber-800 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{m}</span>
                </p>
              ))}
              {batchCounts.unresolved > 0 && (
                <p className="text-slate-600">
                  {batchCounts.unresolved} row(s) in this batch have a MeSH ID without a Wikidata item (or a qualifier); they cannot be approved or exported.
                </p>
              )}
            </div>
          )}

          {/* Filter & Single-Click Bulk Actions Bar */}
          <div className="bg-slate-100/80 border-b border-slate-200 px-6 py-2.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              {/* Interactive Status Filter Segmented Controls */}
              <div className="flex items-center gap-1 p-1 bg-slate-200/80 rounded-md">
                <button
                  type="button"
                  onClick={() => setStatusFilter('all')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    statusFilter === 'all'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All in Batch ({batchCounts.total})
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('pending')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    statusFilter === 'pending'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Pending ({batchCounts.pending})
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('approved')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    statusFilter === 'approved'
                      ? 'bg-white text-emerald-800 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Approved ({batchCounts.approved})
                </button>
                <button
                  type="button"
                  onClick={() => setStatusFilter('rejected')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer tabular-nums ${
                    statusFilter === 'rejected'
                      ? 'bg-white text-rose-800 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Rejected ({batchCounts.rejected})
                </button>
              </div>

              {/* Search Input */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter MeSH ID, QID, label, PMID..."
                  className="pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md w-60 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              {/* Duplicate Filter Toggle */}
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={hideDuplicates}
                  onChange={(e) => setHideDuplicates(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                />
                <span>
                  Hide Existing Wikidata Duplicates ({batchCounts.duplicates})
                </span>
              </label>
            </div>

            {/* Batch Bulk Curation Buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRerun}
                disabled={!!pipeline}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap cursor-pointer"
                title="Retry failed Wikidata, PubMed or local-model calls for this batch"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${pipeline ? 'animate-spin' : ''}`} />
                <span>Re-run checks</span>
              </button>
              <button
                type="button"
                onClick={() => handleBulkDecision('approved')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-300 rounded-md hover:bg-emerald-100 transition-colors whitespace-nowrap cursor-pointer"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>Approve novel ≥ {(config.minConfidence * 100).toFixed(0)}% confidence</span>
              </button>
              <button
                type="button"
                onClick={() => handleBulkDecision('pending')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Batch</span>
              </button>
            </div>
          </div>

          {/* Asymmetric Split Console: Main 100-Relation Curation Table + Right Evidence Inspector */}
          <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
            {/* Left/Center Data Grid */}
            <div className="flex-1 overflow-x-auto overflow-y-auto max-h-[calc(100vh-165px)] bg-white">
              {loadingBatch ? (
                <div className="p-8 space-y-3">
                  {Array.from({ length: 10 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="h-10 bg-slate-100 animate-pulse rounded border border-slate-200"
                    />
                  ))}
                </div>
              ) : filteredRelations.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-sm font-semibold text-slate-800">
                    No relations match the current filter criteria
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Try clearing the search query or switching the status filter back to "All in Batch".
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setStatusFilter('all');
                      setHideDuplicates(false);
                      setSearchQuery('');
                    }}
                    className="mt-4 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md cursor-pointer"
                  >
                    Reset Filters
                  </button>
                </div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600">
                    <tr>
                      <th className="py-2.5 px-3 w-12 text-right font-mono">#</th>
                      <th className="py-2.5 px-3">Subject (MeSH → Wikidata)</th>
                      <th className="py-2.5 px-3">Property (classifier)</th>
                      <th className="py-2.5 px-3">Object (MeSH → Wikidata)</th>
                      <th className="py-2.5 px-3 text-right">PMI</th>
                      <th className="py-2.5 px-3">Wikidata Check</th>
                      <th className="py-2.5 px-3">PubMed Ref</th>
                      <th className="py-2.5 px-4 text-right">Single-Click Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs">
                    {filteredRelations.map((rel) => {
                      const isSelected = rel.id === selectedRelationId;
                      return (
                        <tr
                          key={rel.id}
                          onClick={() => setSelectedRelationId(rel.id)}
                          className={`transition-colors cursor-pointer ${
                            isSelected
                              ? 'bg-blue-50/70'
                              : rel.status === 'approved'
                              ? 'bg-emerald-50/25 hover:bg-slate-50'
                              : rel.status === 'rejected'
                              ? 'bg-rose-50/20 opacity-75 hover:bg-slate-50'
                              : 'hover:bg-slate-50'
                          }`}
                        >
                          {/* Row Number */}
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-400">
                            {rel.rowIndex}
                          </td>

                          {/* Subject Entity */}
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-slate-900 leading-snug">
                              {rel.subject.label}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                              <span>{rel.subjectMeshId}</span>
                              <span aria-hidden="true"> → </span>
                              <QidLink entity={rel.subject} />
                              <span aria-hidden="true"> · </span>
                              <span className="font-sans">{rel.subject.semanticGroup ?? 'unclassified'}</span>
                            </div>
                          </td>

                          {/* Offline LLM Property with Inline Override */}
                          <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                            <select
                              aria-label={`Wikidata property for row ${rel.rowIndex}`}
                              value={rel.selectedProperty.pid}
                              onChange={(e) => handlePropertyChange(rel.id, e.target.value)}
                              className="text-xs bg-white border border-slate-200 hover:border-slate-300 rounded px-2 py-1 text-slate-900 font-medium max-w-[215px] truncate focus:outline-none focus:ring-1 focus:ring-blue-600"
                            >
                              {optionsFor(rel).map((p) => (
                                <option key={p.pid} value={p.pid}>
                                  {p.pid} ({p.label})
                                </option>
                              ))}
                            </select>
                            <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                              {rel.llmPrediction.engine === 'ollama' ? 'LLM' : 'Rule'} score {(rel.llmPrediction.confidence * 100).toFixed(0)}%
                            </div>
                          </td>

                          {/* Object Entity */}
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-slate-900 leading-snug">
                              {rel.object.label}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                              <span>{rel.objectMeshId}</span>
                              <span aria-hidden="true"> → </span>
                              <QidLink entity={rel.object} />
                              <span aria-hidden="true"> · </span>
                              <span className="font-sans">{rel.object.semanticGroup ?? 'unclassified'}</span>
                            </div>
                          </td>

                          {/* Pointwise Mutual Information (PMI) */}
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                            {rel.pmi.toFixed(2)}
                          </td>

                          {/* Wikidata Duplication Check */}
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            {rel.wikidataVerification.state === 'pending' ? (
                              <span className="text-slate-500">… checking</span>
                            ) : rel.wikidataVerification.state === 'error' ? (
                              <span className="text-amber-700 font-medium" title={rel.wikidataVerification.error}>⚠ check failed</span>
                            ) : rel.wikidataVerification.state === 'skipped' ? (
                              <span className="text-slate-400">— unresolved</span>
                            ) : isExactDuplicate(rel) ? (
                              <span className="text-amber-700 font-medium" title={(existingExact(rel)?.referenceCount ?? 0) > 0 ? `This statement already exists in Wikidata with ${existingExact(rel)!.referenceCount} reference(s)${existingExact(rel)!.pmids.length ? ` (PMID ${existingExact(rel)!.pmids.join(", ")})` : ""}` : "This statement already exists in Wikidata but has no reference"}>
                                ▲ Exists ({rel.selectedProperty.pid}){(existingExact(rel)?.referenceCount ?? 0) > 0 ? ` · ${existingExact(rel)!.referenceCount} ref` : ' · no ref'}
                              </span>
                            ) : rel.wikidataVerification.existing.length > 0 ? (
                              <span
                                className="text-emerald-700 font-medium"
                                title={rel.wikidataVerification.existing.map((e) => `${e.direction === 'reverse' ? 'reverse ' : ''}${e.pid} ${e.label}`).join('; ')}
                              >
                                ● Novel · linked via {rel.wikidataVerification.existing[0].pid}
                              </span>
                            ) : (
                              <span className="text-emerald-700 font-medium">● Novel</span>
                            )}
                          </td>

                          {/* PubMed Reference */}
                          <td className="py-2.5 px-3 whitespace-nowrap font-mono tabular-nums">
                            {rel.pubmedReference ? (
                              <a
                                href={`https://pubmed.ncbi.nlm.nih.gov/${rel.pubmedReference.pmid}/`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-blue-600 hover:underline inline-flex items-center gap-0.5"
                                title={`${rel.pubmedReference.title} (${rel.pubmedReference.matchLevel}, ${rel.pubmedReference.hitCount} hits)`}
                              >
                                <span>PMID:{rel.pubmedReference.pmid}</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : rel.pubmedState === 'loading' ? (
                              <span className="text-slate-500 font-sans">… searching</span>
                            ) : rel.pubmedState === 'none' ? (
                              <span className="text-slate-400 font-sans">none found</span>
                            ) : rel.pubmedState === 'error' ? (
                              <span className="text-amber-700 font-sans" title={rel.pubmedError}>⚠ error</span>
                            ) : (
                              <span className="text-slate-300 font-sans">—</span>
                            )}
                          </td>

                          {/* Single-Click Approve / Reject Buttons */}
                          <td
                            className="py-2.5 px-4 text-right whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  handleDecision(
                                    rel.id,
                                    rel.status === 'approved' ? 'pending' : 'approved'
                                  )
                                }
                                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
                                  rel.status === 'approved'
                                    ? 'bg-emerald-600 text-white'
                                    : 'bg-slate-100 text-slate-700 hover:bg-emerald-600 hover:text-white'
                                }`}
                                title={canApprove(rel) ? 'Single-click Approve' : 'Both MeSH IDs must resolve to Wikidata items first'}
                                disabled={!canApprove(rel) && rel.status !== 'approved'}
                                style={!canApprove(rel) && rel.status !== 'approved' ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>{rel.status === 'approved' ? 'Approved' : 'Approve'}</span>
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  handleDecision(
                                    rel.id,
                                    rel.status === 'rejected' ? 'pending' : 'rejected'
                                  )
                                }
                                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded transition-colors cursor-pointer whitespace-nowrap ${
                                  rel.status === 'rejected'
                                    ? 'bg-rose-600 text-white'
                                    : 'bg-slate-100 text-slate-700 hover:bg-rose-600 hover:text-white'
                                }`}
                                title="Single-click Reject"
                              >
                                <X className="w-3.5 h-3.5" />
                                <span>{rel.status === 'rejected' ? 'Rejected' : 'Reject'}</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Right-Hand Evidence & Offline LLM Inspector */}
            <RelationInspector
              relation={selectedRelation}
              availableProperties={activeProps}
              onCustomProperty={handleCustomProperty}
              onDecision={handleDecision}
              onPropertyChange={handlePropertyChange}
              onRefreshPubMed={handleRefreshPubMed}
              canApprove={selectedRelation ? canApprove(selectedRelation) : false}
            />
          </div>
        </main>
      )}

      {/* QuickStatements Export Modal */}
      <QuickStatementsModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        allApprovedRelations={allApprovedRelations}
      />
    </div>
  );
}
