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
import { ProcessedRelationRecord, WikidataPropertySpec } from '../types';

interface RelationInspectorProps {
  relation: ProcessedRelationRecord | null;
  availableProperties: WikidataPropertySpec[];
  onDecision: (id: string, status: 'approved' | 'rejected' | 'pending') => void;
  onPropertyChange: (id: string, pid: string) => void;
  onRefreshPubMed: (id: string) => Promise<void>;
}

export const RelationInspector: React.FC<RelationInspectorProps> = ({
  relation,
  availableProperties,
  onDecision,
  onPropertyChange,
  onRefreshPubMed,
}) => {
  const [refreshingPubMed, setRefreshingPubMed] = useState(false);
  const [copiedSparql, setCopiedSparql] = useState(false);

  if (!relation) {
    return (
      <aside className="w-full lg:w-[400px] xl:w-[440px] shrink-0 border-l border-slate-200 bg-white p-6 flex flex-col justify-center items-center text-center min-h-[420px]">
        <p className="text-sm font-medium text-slate-700">No relation selected</p>
        <p className="text-xs text-slate-500 mt-1 max-w-xs">
          Select any tuple row in the current 100-relation batch to inspect MeSH-to-Wikidata resolution, Offline LLM property inference, SPARQL duplication check, and PubMed reference.
        </p>
      </aside>
    );
  }

  const sparqlQuery = `ASK WHERE {\n  wd:${relation.subject.qid} wdt:${relation.selectedProperty.pid} wd:${relation.object.qid} .\n}`;

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
            onClick={() =>
              onDecision(relation.id, relation.status === 'approved' ? 'pending' : 'approved')
            }
            className={`flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              relation.status === 'approved'
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-900 text-white hover:bg-emerald-600'
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
            01. MeSH Descriptor to Wikidata Resolution (P486)
          </h3>
          <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
            <div>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Subject Entity · {relation.subject.semanticGroup}</span>
                <span className="font-mono tabular-nums">
                  <a
                    href={`https://meshb.nlm.nih.gov/record/ui?ui=${relation.subjectMeshId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-blue-600 underline"
                  >
                    {relation.subjectMeshId}
                  </a>
                  {' → '}
                  <a
                    href={`https://www.wikidata.org/wiki/${relation.subject.qid}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 font-semibold hover:underline inline-flex items-center gap-0.5"
                  >
                    {relation.subject.qid}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </span>
              </div>
              <p className="text-sm font-medium text-slate-900 mt-0.5">{relation.subject.label}</p>
              <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                {relation.subject.description}
              </p>
            </div>

            <div className="border-t border-slate-100 pt-2.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Object Entity · {relation.object.semanticGroup}</span>
                <span className="font-mono tabular-nums">
                  <a
                    href={`https://meshb.nlm.nih.gov/record/ui?ui=${relation.objectMeshId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-blue-600 underline"
                  >
                    {relation.objectMeshId}
                  </a>
                  {' → '}
                  <a
                    href={`https://www.wikidata.org/wiki/${relation.object.qid}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 font-semibold hover:underline inline-flex items-center gap-0.5"
                  >
                    {relation.object.qid}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </span>
              </div>
              <p className="text-sm font-medium text-slate-900 mt-0.5">{relation.object.label}</p>
              <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                {relation.object.description}
              </p>
            </div>
          </div>
        </section>

        {/* 2. Offline LLM Property Identification */}
        <section className="border-t border-slate-200 pt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-900 tracking-tight flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-blue-600" />
              <span>02. Offline LLM Property Identification</span>
            </h3>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              Conf {(relation.llmPrediction.confidence * 100).toFixed(1)}% · {relation.llmPrediction.latencyMs}ms
            </span>
          </div>

          <p className="mt-2 text-xs text-slate-600 leading-relaxed bg-slate-50 p-3 rounded border border-slate-200">
            {relation.llmPrediction.reasoning}
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
              {availableProperties.map((prop) => (
                <option key={prop.pid} value={prop.pid}>
                  {prop.pid} — {prop.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-2.5">
            <p className="text-xs text-slate-500 mb-1.5">Alternative LLM Candidates (Click to apply):</p>
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
              {relation.wikidataVerification.existsInWikidata ? (
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
            {relation.wikidataVerification.existsInWikidata ? (
              <p className="text-amber-800 bg-amber-50/70 border border-amber-200 rounded p-2.5 leading-relaxed">
                <strong>Duplicate Detected in Wikidata:</strong> Statement{' '}
                <span className="font-mono">
                  {relation.subject.qid} → {relation.wikidataVerification.existingPropertyId} (
                  {relation.wikidataVerification.existingPropertyLabel}) → {relation.object.qid}
                </span>{' '}
                is already present. Approving will add a PubMed reference statement or can be skipped.
              </p>
            ) : (
              <p className="text-emerald-800 bg-emerald-50/60 border border-emerald-200 rounded p-2.5 leading-relaxed">
                <strong>Verified Novel Relation:</strong> No existing direct claim links{' '}
                <span className="font-mono">{relation.subject.qid}</span> and{' '}
                <span className="font-mono">{relation.object.qid}</span> in Wikidata. Safe to export via QuickStatements.
              </p>
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
              disabled={refreshingPubMed}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${refreshingPubMed ? 'animate-spin' : ''}`} />
              <span>{refreshingPubMed ? 'Querying NCBI...' : 'Query Live PubMed'}</span>
            </button>
          </div>

          <div className="mt-2.5 border border-slate-200 rounded p-3 bg-slate-50/50">
            <div className="flex items-center justify-between text-xs text-slate-500 font-mono tabular-nums">
              <span>PMID: {relation.pubmedReference.pmid}</span>
              <span>{relation.pubmedReference.pubDate}</span>
            </div>
            <p className="mt-1 text-xs font-semibold text-slate-900 leading-snug">
              {relation.pubmedReference.title}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {relation.pubmedReference.authors} · <em>{relation.pubmedReference.journal}</em>
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
        </section>
      </div>
    </aside>
  );
};
