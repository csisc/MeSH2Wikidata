import React, { useMemo, useState } from 'react';
import { Copy, Check, Download, ExternalLink, X } from 'lucide-react';
import { ProcessedRelationRecord } from '../types';
import { buildAuditCsv, buildV1, buildV1Url, ExportOptions, isExportable } from '../lib/quickstatements';

interface QuickStatementsModalProps {
  isOpen: boolean;
  onClose: () => void;
  allApprovedRelations: ProcessedRelationRecord[];
}

// Browsers and Toolforge both choke on very long URLs; above this, paste or upload the batch instead.
const MAX_URL_CHARS = 6000;

export const QuickStatementsModal: React.FC<QuickStatementsModalProps> = ({
  isOpen,
  onClose,
  allApprovedRelations,
}) => {
  const [requireReference, setRequireReference] = useState(true);
  const [includeExactDuplicates, setIncludeExactDuplicates] = useState(false);
  const [copied, setCopied] = useState(false);

  const opts: ExportOptions = useMemo(
    () => ({ requireReference, includeExactDuplicates }),
    [requireReference, includeExactDuplicates]
  );

  const v1 = useMemo(() => buildV1(allApprovedRelations, opts), [allApprovedRelations, opts]);
  const count = useMemo(
    () => allApprovedRelations.filter((r) => isExportable(r, opts)).length,
    [allApprovedRelations, opts]
  );
  const held = allApprovedRelations.length - count;
  const url = useMemo(() => buildV1Url(v1), [v1]);

  if (!isOpen) return null;

  const download = (text: string, name: string, mime: string) => {
    const blob = new Blob([text], { type: mime });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
    URL.revokeObjectURL(href);
  };

  const handleCopy = () => {
    if (!v1) return;
    navigator.clipboard.writeText(v1);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-lg max-w-4xl w-full shadow-xl flex flex-col max-h-[88vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Export approved relations to QuickStatements</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              QuickStatements V1 commands: subject item, property, object item, reference PubMed ID (S698) and retrieval date (S813).
              Paste them into QuickStatements and read its preview before running the batch.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-slate-500 hover:text-slate-900 rounded-md cursor-pointer" aria-label="Close export modal">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-5 text-xs text-slate-700">
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={requireReference} onChange={(e) => setRequireReference(e.target.checked)} className="rounded border-slate-300" />
              <span>Only statements with a PubMed reference</span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={includeExactDuplicates} onChange={(e) => setIncludeExactDuplicates(e.target.checked)} className="rounded border-slate-300" />
              <span>Include statements that already exist (reference only)</span>
            </label>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-600">
            Exporting {count} statement{count === 1 ? '' : 's'}
            {held > 0 ? ` · ${held} approved row(s) held back by the options above` : ''}
          </div>
        </div>

        <div className="p-6 flex-1 overflow-y-auto">
          {count === 0 ? (
            <div className="py-12 text-center border border-dashed border-slate-300 rounded-lg p-6">
              <p className="text-sm font-semibold text-slate-800">No approved relations ready for export</p>
              <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                Approve relations whose MeSH IDs both resolved to Wikidata items. With the default options a PubMed reference is also required and exact duplicates are skipped.
              </p>
            </div>
          ) : (
            <pre className="p-4 bg-slate-900 text-slate-100 rounded-md text-xs font-mono leading-relaxed overflow-x-auto max-h-[360px]">{v1}</pre>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-white rounded-b-lg">
          {count > 0 && url.length <= MAX_URL_CHARS ? (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800 whitespace-nowrap">
              <span>Open in QuickStatements</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          ) : (
            <a href="https://quickstatements.toolforge.org/#/batch" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800">
              <span>{count > 0 ? 'Batch too long for a link: open QuickStatements and paste' : 'Open QuickStatements'}</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => download(buildAuditCsv(allApprovedRelations, opts), 'mesh_wikidata_audit.csv', 'text/csv;charset=utf-8')}
              disabled={count === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap cursor-pointer"
              title="Labels, PMI and PubMed titles for your own records (not a QuickStatements format)"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Audit CSV</span>
            </button>
            <button
              type="button"
              onClick={() => download(v1, 'mesh_wikidata_batch.qs.txt', 'text/plain;charset=utf-8')}
              disabled={count === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download batch</span>
            </button>
            <button
              type="button"
              onClick={handleCopy}
              disabled={count === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy batch'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
