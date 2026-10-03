export interface RawCsvRow {
  rowIndex: number;
  tupleRaw: string;
  subjectMeshId: string;
  objectMeshId: string;
  pmi: number;
}

export interface ParsedCsv {
  rows: RawCsvRow[];
  /** false while a streamed file is still being parsed */
  complete?: boolean;
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

/**
 * Streaming parse of a large CSV response. `onChunk` fires with the SAME growing rows array, first as soon
 * as `firstBatch` rows are available (so the first batch can be shown immediately), then after every chunk
 * and finally with complete = true. The loop yields to the browser regularly so the page stays responsive.
 */
export async function parseCsvStream(
  res: Response,
  onChunk: (rows: RawCsvRow[], skipped: number, complete: boolean) => void,
  firstBatch = 100,
  isCancelled: () => boolean = () => false
): Promise<void> {
  const rows: RawCsvRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let headerSeen = false;
  let announced = false;

  const feed = (line: string) => {
    const l = line.trim();
    if (!l) return;
    if (!headerSeen) {
      headerSeen = true;
      if (l.toLowerCase().startsWith('tuple')) return;
    }
    const m = l.match(ROW_RE);
    if (!m) {
      skipped++;
      return;
    }
    const pmi = parseFloat(m[3]);
    const key = `${m[1]}_${m[2]}`;
    if (!Number.isFinite(pmi) || seen.has(key)) {
      skipped++;
      return;
    }
    seen.add(key);
    rows.push({ rowIndex: rows.length + 1, tupleRaw: `('${m[1]}', '${m[2]}')`, subjectMeshId: m[1], objectMeshId: m[2], pmi });
  };

  let lastNotify = 0;
  const notify = (complete: boolean) => {
    if (!(complete || rows.length >= firstBatch || announced)) return;
    const now = Date.now();
    // after the first announcement, update the UI at most ~3 times a second (a re-render per chunk is slow)
    if (!complete && announced && now - lastNotify < 350) return;
    announced = true;
    lastNotify = now;
    onChunk(rows, skipped, complete);
  };

  if (!res.body) {
    for (const line of (await res.text()).split(/\r?\n/)) feed(line);
    notify(true);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (isCancelled()) {
      await reader.cancel();
      return;
    }
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) feed(line);
    if (++n % 4 === 0) {
      notify(false);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  rest += decoder.decode();
  if (rest) feed(rest);
  notify(true);
}
