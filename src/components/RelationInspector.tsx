import React, { useState } from 'react';
import {
  Check,
  X,
  ExternalLink,
  RefreshCw,
  BookOpen,
  Cpu,
  ShieldCheck,
  AlertTriangle,
  Copy,
} from 'lucide-react';
import { MeshEntityInfo, ProcessedRelationRecord, WikidataPropertySpec } from '../types';
import { alreadyCitesPmid, existingExact, isExactDuplicate } from '../lib/quickstatements';

interface RelationInspectorProps {
  relation: ProcessedRelationRecord | null;
  availableProperties: WikidataPropertySpec[];
  onDecision: (id: string, status: 'approved' | 'rejected' | 'pending') => void;
  onPropertyChange: (id: string, pid: string) => void;
  onRefreshPubMed: (id: string) => Promise<void>;
  onCustomProperty: (id: string, pid: string) => Promise<void>;
  canApprove: boolean;
}


const RESOLUTION_NOTE: Record<string, string> = {
  resolved: '',
  ambiguous: 'Several Wikidata items carry this MeSH ID; the first is shown. Check before approving.',
  'not-found': 'No Wikidata item has this MeSH descriptor ID (P486), so no statement can be made yet.',
  qualifier: 'This is a MeSH qualifier (subheading), not a descriptor, so it cannot be a statement object.',
  pending: 'Resolving through Wikidata...',
  error: 'The Wikidata lookup failed. Use "Re-run checks" in the queue.',
};

const EntityBlock: React.FC<{ role: string; entity: MeshEntityInfo }> = ({ role, entity }) => (
  <div>
    <div className="flex items-center justify-between text-xs text-slate-500">
      <span>{role} · {entity.semanticGroup ?? 'unclassified'}</span>
      <span className="font-mono tabular-nums">
        <a
          href={`https://meshb.nlm.nih.gov/record/ui?ui=${entity.meshId}`}
          target="_blank"
          rel="noreferrer"
          className="hover:text-blue-600 underline"
        >
          {entity.meshId}
        </a>
        {' → '}
        {entity.qid ? (
          <a
            href={`https://www.wikidata.org/wiki/${entity.qid}`}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 font-semibold hover:underline inline-flex items-center gap-0.5"
          >
            {entity.qid}
            <ExternalLink className="w-3 h-3" />
          </a>
        ) : (
          <span className="text-rose-700 font-semibold">no item</span>
        )}
      </span>
    </div>
    <p className="text-sm font-medium text-slate-900 mt-0.5">{entity.label}</p>
    {entity.description && <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{entity.description}</p>}
    {entity.treeNumbers.length > 0 && (
      <p className="text-[11px] text-slate-500 font-mono mt-0.5">Tree: {entity.treeNumbers.slice(0, 3).join(', ')}</p>
    )}
    {RESOLUTION_NOTE[entity.resolution] && (
      <p className="text-xs text-amber-800 bg-amber-50/70 border border-amber-200 rounded p-2 mt-1.5">{RESOLUTION_NOTE[entity.resolution]}</p>
    )}
  </div>
);

export const RelationInspector: React.FC<RelationInspectorProps> = ({
  relation,
  availableProperties,
  onDecision,
  onPropertyChange,
  onRefreshPubMed,
  onCustomProperty,
  canApprove,
}) => {
  const [customPid, setCustomPid] = useState('');
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [refreshingPubMed, setRefreshingPubMed] = useState(false);
  const [copiedSparql, setCopiedSparql] = useState(false);

  if (!relation) {
    return (
      <aside className="w-full lg:w-[400px] xl:w-[440px] shrink-0 border-l border-slate-200 bg-white p-6 flex flex-col justify-center items-center text-center min-h-[420px]">
        <p className="text-sm font-medium text-slate-700">No relation selected</p>
        <p className="text-xs text-slate-500 mt-1 max-w-xs">
          Select a row to inspect the MeSH-to-Wikidata resolution, property suggestion, duplicate check and PubMed reference.
        </p>
      </aside>
    );
  }

  const sparqlQuery = `ASK WHERE {\n  wd:${relation.subject.qid ?? 'Q?'} wdt:${relation.selectedProperty.pid} wd:${relation.object.qid ?? 'Q?'} .\n}`;

  const handleCopySparql = () => {
    navigator.clipboard.writeText(sparqlQuery);
    setCopiedSparql(true);
    setTimeout(() => setCopiedSparql(false), 1800);
  };

  const handleLivePubMed = async () => {
    setRefreshingPubMed(true);
    try {
      await onRefreshPubMed(relation.id);
    } finally {
      setRefreshingPubMed(false);
    }
  };

  return (
    <aside className="w-full lg:w-[400px] xl:w-[440px] shrink-0 border-l border-slate-200 bg-white flex flex-col">
      {/* Header & Single-Click Curation Bar */}
      <div className="p-5 border-b border-slate-200">
        <div className="flex items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
          <span>Row #{relation.rowIndex} · {relation.tupleRaw}</span>
          <span>PMI {relation.pmi.toFixed(2)}</span>
        </div>

        <h2 className="mt-2 text-base font-semibold text-slate-900 leading-snug">
          {relation.subject.label}{' '}
          <span className="text-blue-600 font-mono text-sm">→ {relation.selectedProperty.pid} →</span>{' '}
          {relation.object.label}
        </h2>

        <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-600">
          <span>Curation Status:</span>
          <span
            className={`font-semibold ${
              relation.status === 'approved'
                ? 'text-emerald-700'
                : relation.status === 'rejected'
                ? 'text-rose-700'
                : 'text-amber-700'
            }`}
          >
            {relation.status === 'approved'
              ? '● Approved for QuickStatements'
              : relation.status === 'rejected'
              ? '✖ Rejected'
              : '▲ Pending Review'}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            disabled={!canApprove && relation.status !== 'approved'}
            title={canApprove ? undefined : 'Both MeSH IDs must resolve to Wikidata items first'}
            onClick={() =>
              onDecision(relation.id, relation.status === 'approved' ? 'pending' : 'approved')
            }
            className={`flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              relation.status === 'approved'
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-900 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            <Check className="w-3.5 h-3.5" />
            <span>{relation.status === 'approved' ? 'Approved (Click to Undo)' : 'Approve Relation (A)'}</span>
          </button>

          <button
            type="button"
            onClick={() =>
              onDecision(relation.id, relation.status === 'rejected' ? 'pending' : 'rejected')
            }
            className={`flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
              relation.status === 'rejected'
                ? 'bg-rose-600 text-white border-rose-600'
                : 'bg-white text-slate-700 border-slate-300 hover:border-rose-300 hover:text-rose-700'
            }`}
          >
            <X className="w-3.5 h-3.5" />
            <span>{relation.status === 'rejected' ? 'Rejected (Click to Undo)' : 'Reject Suggestion (R)'}</span>
          </button>
        </div>
      </div>

      {/* Scrollable Evidence Sections */}
      <div className="p-5 space-y-6 overflow-y-auto max-h-[calc(100vh-240px)]">
        {/* 1. MeSH -> Wikidata Entity Resolution */}
        <section>
          <h3 className="text-xs font-semibold text-slate-900 tracking-tight">
            01. MeSH Descriptor to Wikidata Resolution (P486, live SPARQL)
          </h3>
          <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
            <EntityBlock role="Subject Entity" entity={relation.subject} />
            <div className="border-t border-slate-100 pt-2.5">
              <EntityBlock role="Object Entity" entity={relation.object} />
            </div>
          </div>
        </section>

        {/* 2. Offline LLM Property Identification */}
        <section className="border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-900 tracking-tight flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-blue-600" />
              <span>02. Property Suggestion ({relation.llmPrediction.engine === 'ollama' ? 'local LLM' : 'rule-based'})</span>
            </h3>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {relation.llmPrediction.engine === 'ollama' ? 'Self-reported' : 'Score'} {(relation.llmPrediction.confidence * 100).toFixed(0)}% · {relation.llmPrediction.latencyMs}ms
            </span>
          </div>

          <p className="mt-2 text-xs text-slate-600 leading-relaxed bg-slate-50 p-3 rounded border border-slate-200">
            {relation.llmPrediction.reasoning}
            <span className="block text-[11px] text-slate-500 mt-1">Engine: {relation.llmPrediction.modelId}</span>
          </p>

          <div className="mt-3">
            <label
              htmlFor="inspector-property-select"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Active Wikidata Property (Override if needed)
            </label>
            <select
              id="inspector-property-select"
              value={relation.selectedProperty.pid}
              onChange={(e) => onPropertyChange(relation.id, e.target.value)}
              className="w-full text-xs bg-white border border-slate-300 rounded-md px-2.5 py-2 text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {(availableProperties.some((x) => x.pid === relation.selectedProperty.pid)
                ? availableProperties
                : [relation.selectedProperty, ...availableProperties]
              ).map((prop) => (
                <option key={prop.pid} value={prop.pid}>
                  {prop.pid} — {prop.label}
                </option>
              ))}
            </select>

            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={customPid}
                onChange={(e) => {
                  setCustomPid(e.target.value);
                  setCustomError(null);
                }}
                placeholder="Other property ID, e.g. P1050"
                aria-label="Other Wikidata property ID"
                className="flex-1 min-w-0 text-xs font-mono bg-white border border-slate-300 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button
                type="button"
                disabled={customBusy || !customPid.trim()}
                onClick={async () => {
                  setCustomBusy(true);
                  setCustomError(null);
                  try {
                    await onCustomProperty(relation.id, customPid);
                    setCustomPid('');
                  } catch (e) {
                    setCustomError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setCustomBusy(false);
                  }
                }}
                className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md whitespace-nowrap cursor-pointer"
              >
                {customBusy ? 'Checking...' : 'Use'}
              </button>
            </div>
            {customError && <p className="mt-1 text-xs text-rose-700">{customError}</p>}
            {relation.selectedProperty.custom && (
              <p className="mt-1 text-[11px] text-amber-800">
                Property added by hand: the app only checked that it exists and takes item values. Make sure it means what you intend.
              </p>
            )}
          </div>

          <div className="mt-2.5">
            <p className="text-xs text-slate-500 mb-1.5">Alternative candidates (click to apply):</p>
            <div className="flex flex-wrap gap-1.5">
              {relation.llmPrediction.alternatives.map((alt) => (
                <button
                  key={alt.property.pid}
                  type="button"
                  onClick={() => onPropertyChange(relation.id, alt.property.pid)}
                  className={`px-2.5 py-1 text-xs rounded border transition-colors cursor-pointer whitespace-nowrap ${
                    relation.selectedProperty.pid === alt.property.pid
                      ? 'bg-blue-50 border-blue-600 text-blue-700 font-medium'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                  }`}
                >
                  <span className="font-mono">{alt.property.pid}</span> {alt.property.label} (
                  {(alt.score * 100).toFixed(0)}%)
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 3. Wikidata Duplication Verification */}
        <section className="border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-900 tracking-tight flex items-center gap-1.5">
              {isExactDuplicate(relation) ? (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              ) : (
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
              )}
              <span>03. Wikidata Duplication Check</span>
            </h3>
            <button
              type="button"
              onClick={handleCopySparql}
              className="text-xs text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 cursor-pointer"
            >
              <Copy className="w-3 h-3" />
              <span>{copiedSparql ? 'Copied SPARQL' : 'Copy SPARQL'}</span>
            </button>
          </div>

          <div className="mt-2 text-xs">
            {relation.wikidataVerification.state === 'pending' ? (
              <p className="text-slate-600 bg-slate-50 border border-slate-200 rounded p-2.5">Checking Wikidata for existing statements between these two items...</p>
            ) : relation.wikidataVerification.state === 'skipped' ? (
              <p className="text-slate-600 bg-slate-50 border border-slate-200 rounded p-2.5">Not checked: at least one MeSH ID has no Wikidata item.</p>
            ) : relation.wikidataVerification.state === 'error' ? (
              <p className="text-amber-800 bg-amber-50/70 border border-amber-200 rounded p-2.5 leading-relaxed">
                <strong>Check failed:</strong> {relation.wikidataVerification.error}. Do not assume the claim is novel.
              </p>
            ) : isExactDuplicate(relation) ? (
              <p className="text-amber-800 bg-amber-50/70 border border-amber-200 rounded p-2.5 leading-relaxed">
                <strong>Relation already in Wikidata:</strong>{' '}
                <span className="font-mono">{relation.subject.qid} → {relation.selectedProperty.pid} → {relation.object.qid}</span>.{' '}
                {(existingExact(relation)?.referenceCount ?? 0) > 0 ? (
                  <>
                    It has {existingExact(relation)!.referenceCount} reference(s)
                    {existingExact(relation)!.pmids.length > 0 ? ` (PubMed ${existingExact(relation)!.pmids.join(', ')})` : ''}.
                    {alreadyCitesPmid(relation) ? ' The PubMed paper found below is already cited, so nothing needs adding.' : ' Adding the PubMed paper below would be an extra reference.'}
                  </>
                ) : (
                  <>It has <strong>no reference</strong>: the PubMed paper below would be the first.</>
                )}
              </p>
            ) : (
              <p className="text-emerald-800 bg-emerald-50/60 border border-emerald-200 rounded p-2.5 leading-relaxed">
                <strong>No identical statement found</strong> for {relation.subject.qid} → {relation.selectedProperty.pid} → {relation.object.qid}.
              </p>
            )}
            {relation.wikidataVerification.state === 'checked' && relation.wikidataVerification.existing.length > 0 && (
              <ul className="mt-2 space-y-1 text-slate-700">
                {relation.wikidataVerification.existing.map((e) => (
                  <li key={`${e.direction}-${e.pid}`} className="font-mono text-[11px]">
                    {e.direction === 'forward' ? 'subject → object' : 'object → subject'} via {e.pid} ({e.label}) already in Wikidata · {e.referenceCount} ref
                  </li>
                ))}
              </ul>
            )}
          </div>

          <pre className="mt-2 p-2.5 bg-slate-900 text-slate-100 rounded text-[11px] font-mono overflow-x-auto">
            {sparqlQuery}
          </pre>
        </section>

        {/* 4. PubMed Reference Verification */}
        <section className="border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-900 tracking-tight flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-blue-600" />
              <span>04. PubMed Reference (S698)</span>
            </h3>
            <button
              type="button"
              onClick={handleLivePubMed}
              disabled={refreshingPubMed || relation.pubmedState === 'loading'}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${refreshingPubMed ? 'animate-spin' : ''}`} />
              <span>{refreshingPubMed || relation.pubmedState === 'loading' ? 'Querying NCBI...' : 'Search again'}</span>
            </button>
          </div>

          {relation.pubmedReference ? (
            <div className="mt-2.5 border border-slate-200 rounded p-3 bg-slate-50/50">
              <div className="flex items-center justify-between text-xs text-slate-500 font-mono tabular-nums">
                <span>PMID: {relation.pubmedReference.pmid}</span>
                <span>{relation.pubmedReference.pubDate}</span>
              </div>
              <p className="mt-1 text-xs font-semibold text-slate-900 leading-snug">{relation.pubmedReference.title}</p>
              <p className="mt-1 text-xs text-slate-600">
                {relation.pubmedReference.authors} · <em>{relation.pubmedReference.journal}</em>
              </p>
              <p className="mt-1.5 text-[11px] text-amber-800">
                {relation.pubmedReference.matchLevel === 'relation-specific'
                  ? 'Top-ranked paper indexed with both MeSH terms and a subheading fitting this property.'
                  : relation.pubmedReference.matchLevel === 'co-indexed'
                  ? 'Top-ranked paper indexed with both MeSH terms. It shows co-occurrence only: read it to confirm it supports this specific relation.'
                  : 'No paper is indexed with both MeSH terms; this is the top-ranked paper mentioning both names in its title or abstract. Read it before using it as a reference.'}{' '}
                ({relation.pubmedReference.hitCount.toLocaleString()} matching records)
              </p>
              <div className="mt-2 pt-2 border-t border-slate-200/80 flex items-center justify-between text-[11px] text-slate-500">
                <span className="font-mono truncate max-w-[230px]" title={relation.pubmedReference.queryUsed}>
                  Query: {relation.pubmedReference.queryUsed}
                </span>
                <a
                  href={`https://pubmed.ncbi.nlm.nih.gov/${relation.pubmedReference.pmid}/`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 font-medium hover:underline inline-flex items-center gap-0.5 shrink-0"
                >
                  <span>Open PubMed</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          ) : (
            <p className="mt-2.5 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded p-3">
              {relation.pubmedState === 'loading'
                ? 'Searching PubMed...'
                : relation.pubmedState === 'none'
                ? 'No PubMed record is indexed with both MeSH terms. No reference can be attached automatically.'
                : relation.pubmedState === 'error'
                ? `PubMed search failed: ${relation.pubmedError}`
                : 'No search run yet (needs both MeSH IDs resolved).'}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
};
