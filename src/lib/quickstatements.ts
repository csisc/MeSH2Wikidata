import { ProcessedRelationRecord } from '../types';

export interface ExportOptions {
  /** Drop rows that have no PubMed reference */
  requireReference: boolean;
  /** Keep rows whose exact statement already exists (QuickStatements then only has a reference to add) */
  includeExactDuplicates: boolean;
  retrieved?: Date;
}

/** The statement subject -> selected property -> object already exists on Wikidata. */
export function existingExact(r: ProcessedRelationRecord) {
  return r.wikidataVerification.existing.find(
    (e) => e.direction === 'forward' && e.pid === r.selectedProperty.pid
  );
}

export function isExactDuplicate(r: ProcessedRelationRecord): boolean {
  return !!existingExact(r);
}

/** The existing statement already carries the very PubMed reference we would add. */
export function alreadyCitesPmid(r: ProcessedRelationRecord): boolean {
  const ex = existingExact(r);
  return !!ex && !!r.pubmedReference && ex.pmids.includes(r.pubmedReference.pmid);
}

export function isExportable(r: ProcessedRelationRecord, o: ExportOptions): boolean {
  if (r.status !== 'approved') return false;
  if (!r.subject.qid || !r.object.qid || r.subject.qid === r.object.qid) return false;
  if (o.requireReference && !r.pubmedReference) return false;
  if (!o.includeExactDuplicates && isExactDuplicate(r)) return false;
  if (alreadyCitesPmid(r)) return false;
  return true;
}

export function wikidataDate(d: Date): string {
  return `+${d.toISOString().slice(0, 10)}T00:00:00Z/11`;
}

/** QuickStatements V1: one tab-separated command per line. S698 = PubMed ID (P698), S813 = retrieved (P813). */
export function buildV1(records: ProcessedRelationRecord[], o: ExportOptions): string {
  const date = wikidataDate(o.retrieved ?? new Date());
  return records
    .filter((r) => isExportable(r, o))
    .map((r) => {
      const core = [r.subject.qid, r.selectedProperty.pid, r.object.qid];
      if (r.pubmedReference) core.push('S698', `"${r.pubmedReference.pmid}"`, 'S813', date);
      return core.join('\t');
    })
    .join('\n');
}

/** Same commands in the pipe form accepted by quickstatements.toolforge.org/#/v1=... */
export function buildV1Url(v1: string): string {
  if (!v1) return 'https://quickstatements.toolforge.org/#/batch';
  const piped = v1.split('\n').map((l) => l.split('\t').join('|')).join('||');
  return `https://quickstatements.toolforge.org/#/v1=${encodeURIComponent(piped)}`;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Human-readable audit trail for the curator (not a QuickStatements format). */
export function buildAuditCsv(records: ProcessedRelationRecord[], o: ExportOptions): string {
  const head = [
    'subject_qid', 'subject_mesh', 'subject_label', 'property', 'property_label',
    'object_qid', 'object_mesh', 'object_label', 'pmi', 'pmid', 'pubmed_match', 'pubmed_title',
  ];
  const rows = records
    .filter((r) => isExportable(r, o))
    .map((r) =>
      [
        r.subject.qid, r.subjectMeshId, r.subject.label, r.selectedProperty.pid, r.selectedProperty.label,
        r.object.qid, r.objectMeshId, r.object.label, r.pmi.toFixed(2),
        r.pubmedReference?.pmid ?? '', r.pubmedReference?.matchLevel ?? '', r.pubmedReference?.title ?? '',
      ].map((c) => csvCell(c ?? '')).join(',')
    );
  return [head.join(','), ...rows].join('\n');
}

/** A relation can only be approved once both MeSH IDs map to distinct Wikidata items. */
export function canApprove(r: ProcessedRelationRecord): boolean {
  return !!r.subject.qid && !!r.object.qid && r.subject.qid !== r.object.qid;
}
