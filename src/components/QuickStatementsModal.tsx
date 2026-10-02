import React, { useState } from 'react';
import { Copy, Check, Download, ExternalLink, X } from 'lucide-react';
import { ProcessedRelationRecord } from '../types';

interface QuickStatementsModalProps {
  isOpen: boolean;
  onClose: () => void;
  allApprovedRelations: ProcessedRelationRecord[];
}

export const QuickStatementsModal: React.FC<QuickStatementsModalProps> = ({
  isOpen,
  onClose,
  allApprovedRelations,
}) => {
  const [format, setFormat] = useState<'v1' | 'v2'>('v1');
  const [scope, setScope] = useState<'novel-approved' | 'approved'>('novel-approved');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const records = allApprovedRelations.filter((r) => {
    if (scope === 'novel-approved') return !r.wikidataVerification.existsInWikidata;
    return true;
  });

  const retrievedDate = '+2026-10-02T00:00:00Z/11';

  // QuickStatements V1 format (Tab-separated: SubjectQID \t PropertyID \t ObjectQID \t S698 \t "PMID" \t S813 \t +YYYY-MM-DDT00:00:00Z/11)
  const v1Lines = records.map(
    (r) =>
      `${r.subject.qid}\t${r.selectedProperty.pid}\t${r.object.qid}\tS698\t"${r.pubmedReference.pmid}"\tS813\t${retrievedDate}\t/* ${r.subject.label} (${r.subjectMeshId}) -> ${r.selectedProperty.label} -> ${r.object.label} (${r.objectMeshId}) | PMI=${r.pmi.toFixed(2)} */`
  );

  // QuickStatements V1 pipe-delimited URL command format for direct QuickStatements link
  const v1PipeCommands = records
    .map(
      (r) =>
        `${r.subject.qid}|${r.selectedProperty.pid}|${r.object.qid}|S698|"${r.pubmedReference.pmid}"|S813|${retrievedDate}`
    )
    .join('||');

  // QuickStatements V2 CSV format
  const v2CsvLines = [
    'qid,P,value,S698,S813,#comment',
    ...records.map(
      (r) =>
        `${r.subject.qid},${r.selectedProperty.pid},${r.object.qid},"""${r.pubmedReference.pmid}""",${retrievedDate},"${r.subject.label} -> ${r.object.label} (PMI ${r.pmi.toFixed(2)})"`
    ),
  ];

  const activeText = format === 'v1' ? v1Lines.join('\n') : v2CsvLines.join('\n');

  const handleCopy = () => {
    if (!activeText) return;
    navigator.clipboard.writeText(activeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!activeText) return;
    const ext = format === 'v1' ? 'qs.txt' : 'qs_v2.csv';
    const mime = format === 'v1' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8';
    const blob = new Blob([activeText], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wikidata_mesh_relations_${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const quickStatementsUrl = v1PipeCommands
    ? `https://quickstatements.toolforge.org/#/v1=${encodeURIComponent(v1PipeCommands)}`
    : 'https://quickstatements.toolforge.org/#/';

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-lg max-w-4xl w-full shadow-xl flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Export Approved Relations to Wikidata QuickStatements
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Includes resolved Subject QID, Offline LLM Property PID, Object QID, PubMed ID reference (S698), and retrieved timestamp (S813).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-500 hover:text-slate-900 rounded-md cursor-pointer"
            aria-label="Close export modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Controls Bar */}
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-md">
              <button
                type="button"
                onClick={() => setFormat('v1')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  format === 'v1'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                QuickStatements V1 (TSV)
              </button>
              <button
                type="button"
                onClick={() => setFormat('v2')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  format === 'v2'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                QuickStatements V2 (CSV)
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-md">
              <button
                type="button"
                onClick={() => setScope('novel-approved')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  scope === 'novel-approved'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Novel Approved Only (No Duplicates)
              </button>
              <button
                type="button"
                onClick={() => setScope('approved')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  scope === 'approved'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                All Approved
              </button>
            </div>
          </div>

          <div className="text-xs font-mono tabular-nums text-slate-600">
            Exporting {records.length} statement{records.length === 1 ? '' : 's'}
          </div>
        </div>

        {/* Batch Code Preview */}
        <div className="p-6 flex-1 overflow-y-auto">
          {records.length === 0 ? (
            <div className="py-12 text-center border border-dashed border-slate-300 rounded-lg p-6">
              <p className="text-sm font-semibold text-slate-800">
                No approved relations ready for export
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                Approve one or more pending relations in the curation table using the single-click Approve button (or "Approve All Novel in Batch") to generate your QuickStatements batch.
              </p>
            </div>
          ) : (
            <pre className="p-4 bg-slate-900 text-slate-100 rounded-md text-xs font-mono leading-relaxed overflow-x-auto max-h-[360px]">
              {activeText}
            </pre>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-white rounded-b-lg">
          <a
            href={quickStatementsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800 whitespace-nowrap"
          >
            <span>Open directly in Toolforge QuickStatements</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleDownload}
              disabled={records.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Batch File</span>
            </button>

            <button
              type="button"
              onClick={handleCopy}
              disabled={records.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied to Clipboard' : 'Copy QuickStatements Batch'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
