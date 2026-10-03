export interface RawCsvRow {
  rowIndex: number;
  tupleRaw: string;
  subjectMeshId: string;
  objectMeshId: string;
  pmi: number;
}

export interface ParsedCsv {
  rows: RawCsvRow[];
  /** lines that looked like data but had no valid tuple or PMI */
  skipped: number;
}

const ROW_RE = /\(\s*'([A-Z]\d+)'\s*,\s*'([A-Z]\d+)'\s*\)"?\s*,\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/;

export function parseCsv(raw: string): ParsedCsv {
  const rows: RawCsvRow[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  let first = true;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (first) {
      first = false;
      if (line.toLowerCase().startsWith('tuple')) continue;
    }
    const m = line.match(ROW_RE);
    if (!m) {
      skipped++;
      continue;
    }
    const pmi = parseFloat(m[3]);
    const key = `${m[1]}_${m[2]}`;
    if (!Number.isFinite(pmi) || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    rows.push({
      rowIndex: rows.length + 1,
      tupleRaw: `('${m[1]}', '${m[2]}')`,
      subjectMeshId: m[1],
      objectMeshId: m[2],
      pmi,
    });
  }
  return { rows, skipped };
}
