import React, { useRef, useState } from 'react';
import { Download, Upload, Cpu, Database, CheckCircle2, FileText } from 'lucide-react';
import { DatasetInfoResponse, LlmConfig } from '../types';
import { normalizeOllamaBase } from '../lib/classifier';
import { PropertyCheck } from '../lib/wikidata';

interface StorageAndLlmPanelProps {
  activeSection: 'storage' | 'llm';
  datasetInfo: DatasetInfoResponse | null;
  onUploadCsv: (csvContent: string) => Promise<void>;
  onReturnToQueue: () => void;
  rawCsvString: string;
  config: LlmConfig;
  onConfigChange: (cfg: LlmConfig) => void;
  propertyChecks: PropertyCheck[];
  onVerifyProperties: () => Promise<PropertyCheck[]>;
}

export const StorageAndLlmPanel: React.FC<StorageAndLlmPanelProps> = ({
  activeSection,
  datasetInfo,
  onUploadCsv,
  onReturnToQueue,
  rawCsvString,
  config,
  onConfigChange,
  propertyChecks,
  onVerifyProperties,
}) => {
  const [csvInput, setCsvInput] = useState('');
  const fileText = useRef<{ name: string; text: string } | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const checks = propertyChecks.length > 0 ? propertyChecks : null;
  const [testing, setTesting] = useState(false);
  const [testNotes, setTestNotes] = useState<string[]>([]);

  const set = (patch: Partial<LlmConfig>) => onConfigChange({ ...config, ...patch });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      // Keep large files out of the textarea; it would freeze the page.
      fileText.current = { name: file.name, text: String(ev.target?.result || '') };
      setFileName(file.name);
      setCsvInput('');
    };
    reader.readAsText(file);
  };

  const handleApplyCsv = async () => {
    const text = fileText.current?.text ?? csvInput;
    if (!text.trim()) return;
    setUploading(true);
    setUploadNotice(null);
    setUploadError(null);
    try {
      await onUploadCsv(text);
      setUploadNotice('Loaded the new CSV and started the first batch.');
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const runSelfTest = async () => {
    setTesting(true);
    setTestNotes([]);
    const notes: string[] = [];
    try {
      const res = await onVerifyProperties();
      const bad = res.filter((r) => !r.ok);
      notes.push(
        bad.length === 0
          ? `All ${res.length} property IDs match their Wikidata labels.`
          : `${bad.length} property ID(s) do not match the Wikidata label and are switched off. Correct them in src/data/biomedicalOntology.ts: ${bad.map((b) => b.pid).join(', ')}.`
      );
    } catch (e) {
      notes.push(`Could not reach Wikidata: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (config.mode === 'ollama') {
      try {
        const r = await fetch(`${normalizeOllamaBase(config.ollamaUrl)}/api/tags`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const names: string[] = (j?.models ?? []).map((m: { name: string }) => m.name);
        notes.push(
          names.includes(config.ollamaModel)
            ? `Ollama reachable; model ${config.ollamaModel} is installed.`
            : `Ollama reachable, but model ${config.ollamaModel} is not installed (found: ${names.join(', ') || 'none'}). Run: ollama pull ${config.ollamaModel}`
        );
      } catch (e) {
        notes.push(`Ollama not reachable (${e instanceof Error ? e.message : String(e)}). Start it with OLLAMA_ORIGINS="${window.location.origin}" ollama serve`);
      }
    }
    setTestNotes(notes);
    setTesting(false);
  };

  const handleDownloadCsv = () => {
    if (!rawCsvString) {
      // the bundled file is a static asset: link to it instead of holding 25 MB in memory
      window.open('./data/missing_rels.csv', '_blank');
      return;
    }
    const blob = new Blob([rawCsvString], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'missing_rels.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (activeSection === 'storage') {
    return (
      <div className="max-w-5xl mx-auto py-8 px-6 space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">
              Backend Pipeline Storage (missing_rels.csv)
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              The CSV of MeSH descriptor ID pairs with Pointwise Mutual Information (PMI) scores that drives the queue.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleDownloadCsv}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download missing_rels.csv</span>
            </button>
            <button
              type="button"
              onClick={onReturnToQueue}
              className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap cursor-pointer"
            >
              Return to Curation Queue
            </button>
          </div>
        </div>

        {/* Storage Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 bg-white border border-slate-200 rounded-lg p-5">
          <div>
            <p className="text-xs text-slate-500">Storage File Path</p>
            <p className="text-sm font-mono font-semibold text-slate-900 mt-1">
              {datasetInfo?.storagePath || '/data/missing_rels.csv'}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Total Indexed Tuples</p>
            <p className="text-xl font-mono font-bold text-slate-900 tabular-nums mt-0.5">
              {datasetInfo?.totalRows || 0}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Batch Workload Cap</p>
            <p className="text-xl font-mono font-bold text-blue-600 tabular-nums mt-0.5">
              {datasetInfo?.maxBatchSize || 100} / batch
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Skipped lines (no valid tuple/PMI or repeated pair)</p>
            <p className="text-xl font-mono font-bold text-slate-900 tabular-nums mt-0.5">
              {datasetInfo?.skippedRows ?? 0}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Available Batches</p>
            <p className="text-xl font-mono font-bold text-slate-900 tabular-nums mt-0.5">
              {datasetInfo?.totalBatches || 1} batches
            </p>
          </div>
        </div>

        {/* Custom CSV Upload / Pipeline Replacement */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Database className="w-4 h-4 text-blue-600" />
                <span>Replace the dataset (upload or paste CSV)</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Upload a CSV file or paste <span className="font-mono">Tuple,PMI</span> rows. Rows are processed 100 at a time against live Wikidata and PubMed.
              </p>
            </div>
            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer whitespace-nowrap">
              <Upload className="w-3.5 h-3.5" />
              <span>Load Local .CSV File</span>
              <input type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
            </label>
          </div>

          <textarea
            value={csvInput}
            onChange={(e) => setCsvInput(e.target.value)}
            rows={8}
            placeholder={'Tuple,PMI\n"(\'D009068\', \'D000222\')",2.55'}
            className="w-full font-mono text-xs p-3 bg-slate-900 text-slate-100 rounded-md border border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />

          {fileName && (
            <p className="text-xs text-slate-600">Selected file: <span className="font-mono">{fileName}</span> (used instead of the text box)</p>
          )}
          {uploadError && <p className="text-xs text-rose-700 font-medium">{uploadError}</p>}
          {uploadNotice && (
            <p className="text-xs text-emerald-700 font-medium flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" />
              <span>{uploadNotice}</span>
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleApplyCsv}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>{uploading ? 'Loading...' : 'Load CSV'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Property classifier</h1>
          <p className="text-sm text-slate-600 mt-1">
            Chooses the Wikidata property for each resolved MeSH pair. Runs entirely on your machine: either a rule-based scorer or a local Ollama model.
          </p>
        </div>
        <button
          type="button"
          onClick={onReturnToQueue}
          className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap cursor-pointer"
        >
          Return to Curation Queue
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
          <Cpu className="w-4 h-4 text-blue-600" />
          <span>01. Engine</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => set({ mode: 'rule-based' })}
            className={`text-left p-4 rounded-lg border transition-colors cursor-pointer ${config.mode === 'rule-based' ? 'border-blue-600 bg-blue-50/30' : 'border-slate-200 hover:border-slate-300'}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900">Rule-based scorer (default)</span>
              {config.mode === 'rule-based' && <span className="text-xs font-mono text-emerald-700 font-semibold">● ACTIVE</span>}
            </div>
            <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
              Scores each candidate property by how well the MeSH tree-number categories of subject and object fit its domain and range. Instant and deterministic, but it is not a language model and cannot read the labels.
            </p>
          </button>

          <button
            type="button"
            onClick={() => set({ mode: 'ollama' })}
            className={`text-left p-4 rounded-lg border transition-colors cursor-pointer ${config.mode === 'ollama' ? 'border-blue-600 bg-blue-50/30' : 'border-slate-200 hover:border-slate-300'}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900">Local LLM through Ollama</span>
              {config.mode === 'ollama' && <span className="text-xs font-mono text-emerald-700 font-semibold">● ACTIVE</span>}
            </div>
            <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
              Sends labels, descriptions and the candidate list to a model running on your computer. If the server cannot be reached the queue falls back to the rule-based scorer and says so.
            </p>
          </button>
        </div>

        {config.mode === 'ollama' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-slate-100">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Ollama server URL</label>
              <input type="text" value={config.ollamaUrl} onChange={(e) => set({ ollamaUrl: e.target.value })} className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Model tag (must be pulled already)</label>
              <input type="text" value={config.ollamaModel} onChange={(e) => set({ ollamaModel: e.target.value })} className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md" />
            </div>
            <p className="md:col-span-2 text-xs text-slate-500">
              The browser may only call your server if it allows this site as an origin: start it with{' '}
              <span className="font-mono">OLLAMA_ORIGINS=&quot;{typeof window !== 'undefined' ? window.location.origin : ''}&quot; ollama serve</span>.
              Changes apply the next time a batch is processed ("Re-run checks" in the queue).
            </p>
          </div>
        )}

        <div className="pt-3 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Minimum confidence for "Approve novel" bulk action: <span className="font-mono">{(config.minConfidence * 100).toFixed(0)}%</span>
            </label>
            <input type="range" min="0.50" max="0.95" step="0.05" value={config.minConfidence} onChange={(e) => set({ minConfidence: parseFloat(e.target.value) })} className="w-full accent-blue-600" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">NCBI API key (optional, kept in this browser)</label>
            <input type="password" value={config.ncbiApiKey} onChange={(e) => set({ ncbiApiKey: e.target.value.trim() })} placeholder="raises PubMed limit from 3 to 10 requests/second" className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-md" />
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 space-y-2">
          <button type="button" onClick={runSelfTest} disabled={testing} className="px-3.5 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-md cursor-pointer whitespace-nowrap">
            {testing ? 'Testing...' : 'Check property IDs against Wikidata' + (config.mode === 'ollama' ? ' and ping Ollama' : '')}
          </button>
          {testNotes.map((n) => (
            <p key={n} className="text-xs text-slate-700">{n}</p>
          ))}
        </div>
      </div>

      {/* Candidate Wikidata Property Ontology Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            02. Supported Wikidata Biomedical Properties ({datasetInfo?.availableProperties.length ?? 0})
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Candidate properties offered to the classifier. Each ID is verified against its live Wikidata label when the app starts; mismatches are switched off. For a property not listed, use "Other property ID" in the inspector.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="py-2.5 px-4">Property ID</th>
                <th className="py-2.5 px-4">Category</th>
                <th className="py-2.5 px-4">Label (configured)</th>
                <th className="py-2.5 px-4">Live Wikidata check</th>
                <th className="py-2.5 px-4">Subject Domain → Object Range</th>
                <th className="py-2.5 px-4">Canonical Biomedical Example</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {(datasetInfo?.availableProperties || []).map((prop) => (
                <tr key={prop.pid} className="hover:bg-slate-50/80">
                  <td className="py-2.5 px-4 font-mono font-semibold text-blue-600 whitespace-nowrap">
                    <a
                      href={`https://www.wikidata.org/wiki/Property:${prop.pid}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {prop.pid}
                    </a>
                  </td>
                  <td className="py-2.5 px-4 text-slate-500 whitespace-nowrap">{prop.category ?? ''}{prop.generic ? ' (generic)' : ''}</td>
                  <td className={`py-2.5 px-4 font-medium ${datasetInfo?.excludedPids.includes(prop.pid) ? 'text-slate-400 line-through' : 'text-slate-900'}`}>{prop.label}</td>
                  <td className="py-2.5 px-4 text-[11px]">
                    {(() => {
                      const c = checks?.find((x) => x.pid === prop.pid);
                      if (!c) return <span className="text-slate-400">not checked</span>;
                      return c.ok ? <span className="text-emerald-700">● matches</span> : <span className="text-rose-700">▲ switched off: Wikidata says "{c.wikidataLabel ?? 'unknown'}"</span>;
                    })()}
                  </td>
                  <td className="py-2.5 px-4 text-slate-600">
                    {prop.domainGroups.length >= 12 ? 'any' : prop.domainGroups.slice(0, 2).join(', ')}{prop.domainGroups.length > 2 && prop.domainGroups.length < 12 ? ' …' : ''} → {prop.rangeGroups.length >= 12 ? 'any' : prop.rangeGroups.slice(0, 2).join(', ')}{prop.rangeGroups.length > 2 && prop.rangeGroups.length < 12 ? ' …' : ''}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[11px] text-slate-500">
                    {prop.exampleUsage}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
