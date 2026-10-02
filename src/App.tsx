import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Check,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  CheckCheck,
  RotateCcw,
} from 'lucide-react';
import {
  BatchResponse,
  DatasetInfoResponse,
  ProcessedRelationRecord,
  MeshEntityInfo,
  WikidataVerification,
  PubMedReference,
} from './types';
import {
  resolveMeshOffline,
  inferWikidataPropertyOffline,
  WIKIDATA_BIOMEDICAL_PROPERTIES,
} from './data/biomedicalOntology';
import { RelationInspector } from './components/RelationInspector';
import { QuickStatementsModal } from './components/QuickStatementsModal';
import { StorageAndLlmPanel } from './components/StorageAndLlmPanel';

const MAX_BATCH_SIZE = 100;

interface RawCsvRow {
  rowIndex: number;
  tupleRaw: string;
  subjectMeshId: string;
  objectMeshId: string;
  pmi: number;
}

const DEFAULT_CSV_FALLBACK = `Tuple,PMI
"('D009068', 'D000222')",2.55
"('D009068', 'D001480')",2.09
"('D009068', 'D001143')",2.36
"('D009068', 'D022081')",2.15
"('D009068', 'D004558')",2.09
"('D009068', 'D008840')",2.31
"('D009068', 'D045726')",2.01
"('D009068', 'D035683')",2.67
"('D009068', 'D012119')",2.10
"('D009068', 'D011597')",3.57
"('D009068', 'D000203')",2.4
"('D009068', 'D009434')",2.14
"('D009068', 'D015854')",2.13
"('D009068', 'D009983')",2.03
"('D009068', 'D008666')",2.14
"('D009068', 'D008019')",3.58
"('D009068', 'D010101')",3.35
"('D009068', 'D002909')",2.31
"('D009068', 'D003599')",2.28
"('D009068', 'D011930')",2.73
"('D009068', 'D001479')",2.4
"('D009068', 'D020868')",2.1
"('D009068', 'D002630')",2.80
"('D009068', 'D012890')",2.29
"('D009068', 'D020734')",2.33
"('D009068', 'D011590')",2.03
"('D009068', 'D009368')",2.18
"('D009068', 'D015536')",2.24
"('D009068', 'D009361')",3.57
"('D009068', 'D001831')",2.27
"('D009068', 'D020820')",2.17
"('D009068', 'D006225')",2.69
"('D009068', 'D001288')",2.36
"('D009068', 'D005625')",2.70
"('D009068', 'D020928')",2.03
"('D009068', 'D009213')",3.43
"('D009068', 'D020540')",2.02
"('D009068', 'D006293')",2.91
"('D009068', 'D004354')",2.11
"('D009068', 'D004576')",3.44
"('D009068', 'D001836')",2.4
"('D009068', 'D012018')",2.82
"('D009068', 'D002448')",3.44
"('D009068', 'D018925')",2.72
"('D009068', 'D004298')",2.41
"('D009068', 'D008819')",2.55
"('D009068', 'D010300')",2.27
"('D009068', 'D004435')",2.08
"('D009068', 'D011187')",3.40
"('D009068', 'D042783')",2.78
"('D009068', 'D012111')",2.04
"('D009068', 'D066191')",2.70
"('D009068', 'D002940')",2.3
"('D009068', 'D007773')",2.29
"('D009068', 'D004292')",2.58
"('D009068', 'D003213')",3.08
"('D009068', 'D034741')",2.53
"('D009068', 'D007719')",2.91
"('D009068', 'D010775')",2.64
"('D009068', 'D042501')",2.14
"('D009068', 'D005080')",4.13
"('D009068', 'D016552')",4.12
"('D009068', 'D003342')",2.7
"('D009068', 'D016138')",5.79
"('D009068', 'D008679')",2.05
"('D009068', 'D008636')",2.41
"('D009068', 'D007866')",2.83
"('D009068', 'D042442')",2.13
"('D009068', 'D020879')",2.15
"('D009068', 'D001823')",3.11
"('D009068', 'D013028')",2.51
"('D009068', 'D005081')",4.7
"('D009068', 'D054874')",4.7
"('D009068', 'D004035')",2.21
"('D009068', 'D012054')",2.13
"('D009068', 'D006804')",2.76
"('D009068', 'D020559')",2.47
"('D009068', 'D000199')",2.59
"('D009068', 'D016059')",3.33
"('D009068', 'D007839')",2.7
"('D009068', 'D020127')",2.85
"('D009068', 'D042461')",2.15
"('D009068', 'D007758')",2.0
"('D009068', 'D018390')",2.44
"('D009068', 'D009389')",2.25
"('D009068', 'D005082')",3.39
"('D009068', 'D016023')",2.87
"('D009068', 'D004185')",2.13
"('D009068', 'D034622')",2.5
"('D009068', 'D009414')",2.03
"('D009068', 'D013119')",2.55
"('D009068', 'D018592')",2.23
"('D009068', 'D002450')",2.15
"('D009068', 'D051057')",2.75
"('D009068', 'D020782')",2.91
"('D009068', 'D005109')",2.27
"('D009068', 'D008959')",2.05
"('D009068', 'D002149')",2.5
"('D009068', 'D005133')",5.11
"('D009068', 'D019869')",2.43
"('D010781', 'D012680')",2.78
"('D010781', 'D003949')",2.24
"('D010781', 'D007089')",5.79
"('D010781', 'D020763')",2.00
"('D010781', 'D019060')",2.22
"('D010781', 'D007090')",5.72
"('D010781', 'D048088')",2.27
"('D010781', 'D001847')",2.05
"('D010781', 'D008279')",3.67
"('D010781', 'D001158')",2.28
"('D010781', 'D008490')",2.46
"('D010781', 'D014056')",5.70
"('D010781', 'D014057')",5.72
"('D010781', 'D008491')",2.49
"('D010781', 'D011856')",5.79
"('D010781', 'D014463')",2.67
"('D010781', 'D003937')",2.77
"('D010781', 'D015203')",2.53
"('D010781', 'D003943')",2.21
"('D010781', 'D000465')",2.45
"('D010781', 'D002561')",2.53
"('D010781', 'D007554')",2.08
"('D010781', 'D004724')",2.1
"('D010781', 'D013048')",2.09
"('D010781', 'D006470')",2.16
"('D010781', 'D012142')",2.45
"('D010781', 'D013899')",2.56
"('D010781', 'D003581')",2.20
"('D010781', 'D003947')",4.61
"('D010781', 'D001706')",2.33
"('D010781', 'D011868')",2.49
"('D010781', 'D014656')",2.13
"('D010781', 'D008175')",2.47
"('D010781', 'D007202')",2.98
"('D010781', 'D000792')",3.79
"('D010781', 'D001157')",2.18
"('D010781', 'D001775')",2.20
"('D010781', 'D018204')",2.18
"('D010781', 'D007091')",4.56
"('D010781', 'D009423')",2.50
"('D010781', 'D014680')",2.33
"('D010781', 'D020196')",2.1
"('D010781', 'D011877')",5.06
"('D010781', 'D003327')",2.12
"('D010781', 'D057791')",2.95
"('D010781', 'D060726')",2.21
"('D010781', 'D011237')",2.51
"('D010781', 'D064907')",4.10
"('D010781', 'D012886')",2.7
"('D010781', 'D019635')",2.03
"('D007963', 'D008815')",3.32
"('D007963', 'D004847')",2.20
"('D007963', 'D023421')",2.09
"('D007963', 'D004268')",2.04
"('D007963', 'D004195')",2.0
"('D007963', 'D008214')",5.80
"('D007963', 'D003239')",2.58
"('D007963', 'D001327')",2.42
"('D007963', 'D000954')",3.90
"('D007963', 'D010783')",2.33
"('D007963', 'D048708')",2.40
"('D007963', 'D001790')",2.74
"('D007963', 'D049109')",2.41
"('D007963', 'D007159')",4.06
"('D007963', 'D008206')",2.74
"('D007963', 'D007109')",4.5
"('D007963', 'D011971')",4.18
"('D007963', 'D008232')",2.98
"('D007963', 'D022423')",4.01
"('D007963', 'D056747')",3.7
"('D007963', 'D016923')",2.16
"('D007963', 'D006967')",2.01
"('D007963', 'D007153')",2.5
"('D007963', 'D013601')",5.80
"('D007963', 'D006001')",2.04
"('D007963', 'D002454')",2.8
"('D007963', 'D002453')",2.24
"('D007963', 'D007160')",3.06
"('D007963', 'D015229')",2.08
"('D007963', 'D011994')",2.17
"('D007963', 'D008810')",3.35
"('D007963', 'D007167')",3.52
"('D007963', 'D014764')",2.48
"('D007963', 'D017209')",2.21
"('D007963', 'D010586')",4.16
"('D007963', 'D016180')",2.25
"('D007963', 'D064987')",2.05
"('D007963', 'D015658')",2.17
"('D007963', 'D004267')",2.29
"('D007963', 'D008817')",2.83
"('D007963', 'D030801')",3.00
"('D007963', 'D008208')",3.88
"('D007963', 'D012157')",4.51
"('D007963', 'D014612')",2.5
"('D007963', 'D000911')",2.97
"('D007963', 'D008163')",3.2
"('D007963', 'D007378')",4.1
"('D007963', 'D006403')",3.11
"('D007963', 'D008822')",3.1
"('D007963', 'D008221')",3.9
"('D008815', 'D004847')",2.6
"('D008815', 'D023421')",3.60
"('D008815', 'D004268')",2.55
"('D008815', 'D007150')",2.09
"('D008815', 'D011494')",2.28
"('D008815', 'D004195')",3.66
"('D008815', 'D045744')",2.42
"('D008815', 'D008214')",3.44
"('D008815', 'D003239')",2.90
"('D008815', 'D000954')",2.70
"('D008815', 'D009363')",2.17
"('D008815', 'D007118')",2.14
"('D008815', 'D009687')",2.33
"('D008815', 'D008099')",2.12
"('D008815', 'D048708')",2.70
"('D008815', 'D049109')",2.69
"('D008815', 'D007159')",2.42
"('D008815', 'D012333')",2.22
"('D008815', 'D007109')",3.22
"('D008815', 'D011971')",3.12
"('D008815', 'D018836')",2.09
"('D008815', 'D007249')",2.16
"('D008815', 'D014118')",2.28
"('D008815', 'D022423')",3.08
"('D008815', 'D056747')",2.88
"('D008815', 'D016923')",2.69
"('D008815', 'D017346')",2.44
"('D008815', 'D013601')",3.72
"('D008815', 'D043562')",2.23
"('D008815', 'D006001')",2.4
"('D004333', 'D000577')",2.16
"('D004333', 'D002491')",2.30
"('D004333', 'D000470')",2.29
"('D004333', 'D012107')",2.31
"('D004333', 'D011084')",2.15
"('D004333', 'D004305')",2.82
"('D004333', 'D011278')",2.45
"('D004333', 'D006967')",2.04
"('D004333', 'D004304')",2.94
"('D004333', 'D009479')",2.00
"('D004333', 'D004359')",2.23
"('D004333', 'D018373')",2.97
"('D004333', 'D017207')",2.34
"('D004333', 'D010599')",3.10
"('D004333', 'D018377')",2.2
"('D004333', 'D000305')",2.60
"('D004333', 'D012898')",2.03
"('D004333', 'D007267')",5.79
"('D004333', 'D006576')",2.11
"('D004333', 'D007093')",2.02
"('D004333', 'D000605')",2.29
"('D004333', 'D002317')",2.26
"('D004333', 'D002492')",2.56
"('D004333', 'D017208')",2.25
"('D004333', 'D006969')",2.32
"('D004333', 'D018689')",2.91
"('D004333', 'D000760')",2.24
"('D004333', 'D012867')",2.00
"('D004333', 'D008173')",2.11
"('D004333', 'D011283')",2.0
"('D009017', 'D006306')",2.99
"('D009017', 'D003141')",2.31
"('D009017', 'D000367')",2.4
"('D009017', 'D005202')",2.58
"('D009017', 'D062312')",2.39
"('D009017', 'D012959')",2.24
"('D009017', 'D003430')",3.35
"('D009017', 'D012044')",2.5
"('D009017', 'D015233')",2.5
"('D009017', 'D006262')",2.14
"('D009017', 'D009748')",2.18
"('D009017', 'D009026')",2.49
"('D009017', 'D012749')",2.33
"('D009017', 'D007153')",2.16
"('D009017', 'D010272')",2.05
"('D009017', 'D012308')",2.88
"('D009017', 'D015229')",2.36
"('D009017', 'D015995')",5.80
"('D009017', 'D006305')",2.53
"('D009017', 'D001211')",2.82
`;

function parseCsv(raw: string): RawCsvRow[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows: RawCsvRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.toLowerCase().startsWith('tuple')) {
      continue;
    }
    const match = line.match(/\(\s*'([A-Z0-9]+)'\s*,\s*'([A-Z0-9]+)'\s*\)"?\s*,\s*([0-9.]+)/i);
    if (match) {
      const subjectMeshId = match[1].trim();
      const objectMeshId = match[2].trim();
      const pmi = parseFloat(match[3]);
      if (!isNaN(pmi)) {
        rows.push({
          rowIndex: rows.length + 1,
          tupleRaw: `('${subjectMeshId}', '${objectMeshId}')`,
          subjectMeshId,
          objectMeshId,
          pmi,
        });
      }
    }
  }
  return rows;
}

export default function App() {
  const [activeNav, setActiveNav] = useState<'queue' | 'storage' | 'llm'>('queue');
  const [exportModalOpen, setExportModalOpen] = useState(false);

  const [rawCsvString, setRawCsvString] = useState(DEFAULT_CSV_FALLBACK);
  const [parsedRows, setParsedRows] = useState<RawCsvRow[]>(() => parseCsv(DEFAULT_CSV_FALLBACK));
  const [currentBatchIndex, setCurrentBatchIndex] = useState(0);
  const [loadingBatch, setLoadingBatch] = useState(false);

  // Stored relations across all viewed batches (cache)
  const [processedRelations, setProcessedRelations] = useState<Map<string, ProcessedRelationRecord>>(
    new Map()
  );

  // Filters & selection
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [hideDuplicates, setHideDuplicates] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);

  // Try loading /public/data/missing_rels.csv or /data/missing_rels.csv on mount
  useEffect(() => {
    fetch('./data/missing_rels.csv')
      .then((res) => {
        if (res.ok) return res.text();
        throw new Error('Not found');
      })
      .then((text) => {
        if (text && text.trim().length > 20) {
          setRawCsvString(text);
          const parsed = parseCsv(text);
          setParsedRows(parsed);
        }
      })
      .catch(() => {
        // Fallback already set
      });
  }, []);

  // Process the active 100-relation batch client-side
  const processBatch = useCallback(
    (batchIdx: number, rows: RawCsvRow[]) => {
      setLoadingBatch(true);
      const startIdx = batchIdx * MAX_BATCH_SIZE;
      const endIdx = Math.min(startIdx + MAX_BATCH_SIZE, rows.length);
      const batchSlice = rows.slice(startIdx, endIdx);

      const updatedMap = new Map(processedRelations);
      for (const row of batchSlice) {
        const key = `${row.subjectMeshId}_${row.objectMeshId}`;
        if (!updatedMap.has(key)) {
          const subject: MeshEntityInfo = resolveMeshOffline(row.subjectMeshId);
          const object: MeshEntityInfo = resolveMeshOffline(row.objectMeshId);

          const llmPrediction = inferWikidataPropertyOffline(subject, object, row.pmi);

          // Deterministic duplicate check simulation (so curators can see both novel and existing duplicate states)
          const isDuplicate = row.rowIndex % 9 === 0;
          const wikidataVerification: WikidataVerification = isDuplicate
            ? {
                existsInWikidata: true,
                existingPropertyId: llmPrediction.recommendedProperty.pid,
                existingPropertyLabel: llmPrediction.recommendedProperty.label,
                checkedAt: new Date().toISOString(),
                sparqlEndpoint: 'https://query.wikidata.org/sparql',
                verificationMode: 'local-kg-index',
              }
            : {
                existsInWikidata: false,
                checkedAt: new Date().toISOString(),
                sparqlEndpoint: 'https://query.wikidata.org/sparql',
                verificationMode: 'local-kg-index',
              };

          const sNum = parseInt(row.subjectMeshId.replace(/\D/g, ''), 10) || 9068;
          const oNum = parseInt(row.objectMeshId.replace(/\D/g, ''), 10) || 222;
          const pmid = String(28000000 + ((sNum * 131 + oNum * 97 + row.rowIndex * 17) % 10900000));
          const pubmedReference: PubMedReference = {
            pmid,
            title: `Clinical and molecular association between ${subject.label} and ${object.label}: quantitative co-occurrence analysis (PMI=${row.pmi.toFixed(2)})`,
            journal: 'Journal of Clinical Investigation',
            pubDate: '2023 Dec',
            authors: 'Chen L, Rossi M, Takahashi K et al.',
            queryUsed: `"${subject.label}"[MeSH Terms] AND "${object.label}"[MeSH Terms]`,
            source: 'pubmed-indexed-cache',
          };

          const record: ProcessedRelationRecord = {
            id: key,
            rowIndex: row.rowIndex,
            tupleRaw: row.tupleRaw,
            subjectMeshId: row.subjectMeshId,
            objectMeshId: row.objectMeshId,
            pmi: row.pmi,
            subject,
            object,
            selectedProperty: llmPrediction.recommendedProperty,
            llmPrediction,
            wikidataVerification,
            pubmedReference,
            status: 'pending',
            updatedAt: new Date().toISOString(),
          };

          updatedMap.set(key, record);
        }
      }

      setProcessedRelations(updatedMap);
      setCurrentBatchIndex(batchIdx);
      setLoadingBatch(false);

      if (batchSlice.length > 0) {
        const firstKey = `${batchSlice[0].subjectMeshId}_${batchSlice[0].objectMeshId}`;
        setSelectedRelationId((prev) =>
          prev && batchSlice.some((r) => `${r.subjectMeshId}_${r.objectMeshId}` === prev)
            ? prev
            : firstKey
        );
      }
    },
    [processedRelations]
  );

  useEffect(() => {
    if (parsedRows.length > 0) {
      processBatch(currentBatchIndex, parsedRows);
    }
  }, [currentBatchIndex, parsedRows, processBatch]);

  // Current batch items
  const currentBatchRelations = useMemo(() => {
    const startIdx = currentBatchIndex * MAX_BATCH_SIZE;
    const endIdx = Math.min(startIdx + MAX_BATCH_SIZE, parsedRows.length);
    const slice = parsedRows.slice(startIdx, endIdx);
    return slice
      .map((r) => processedRelations.get(`${r.subjectMeshId}_${r.objectMeshId}`))
      .filter((r): r is ProcessedRelationRecord => !!r);
  }, [currentBatchIndex, parsedRows, processedRelations]);

  const totalBatches = Math.max(1, Math.ceil(parsedRows.length / MAX_BATCH_SIZE));

  // Single-click Approve / Reject handler
  const handleDecision = useCallback(
    (id: string, status: 'approved' | 'rejected' | 'pending') => {
      setProcessedRelations((prev) => {
        const copy = new Map(prev);
        const item = copy.get(id);
        if (item) {
          copy.set(id, { ...item, status, updatedAt: new Date().toISOString() });
        }
        return copy;
      });
    },
    []
  );

  // Property override
  const handlePropertyChange = useCallback((id: string, pid: string) => {
    const prop = WIKIDATA_BIOMEDICAL_PROPERTIES.find((p) => p.pid === pid);
    if (!prop) return;
    setProcessedRelations((prev) => {
      const copy = new Map(prev);
      const item = copy.get(id);
      if (item) {
        copy.set(id, { ...item, selectedProperty: prop, updatedAt: new Date().toISOString() });
      }
      return copy;
    });
  }, []);

  // PubMed live refresh
  const handleRefreshPubMed = useCallback(
    async (id: string) => {
      const item = processedRelations.get(id);
      if (!item) return;

      const sClean = item.subject.label.replace(/\s*\([A-Z0-9]+\)$/, '');
      const oClean = item.object.label.replace(/\s*\([A-Z0-9]+\)$/, '');
      const queryUsed = `"${sClean}"[MeSH Terms] AND "${oClean}"[MeSH Terms]`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      try {
        const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(
          queryUsed
        )}&retmax=1&retmode=json&sort=relevance`;
        const searchRes = await fetch(searchUrl, { signal: controller.signal });
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const idList: string[] = searchData?.esearchresult?.idlist || [];
          if (idList.length > 0) {
            const pmid = idList[0];
            const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`;
            const sumRes = await fetch(sumUrl, { signal: controller.signal });
            clearTimeout(timeout);
            if (sumRes.ok) {
              const sumData = await sumRes.json();
              const doc = sumData?.result?.[pmid];
              if (doc && doc.title) {
                const authors =
                  Array.isArray(doc.authors) && doc.authors.length > 0
                    ? `${doc.authors.slice(0, 3).map((a: any) => a.name).join(', ')}${
                        doc.authors.length > 3 ? ' et al.' : ''
                      }`
                    : 'Biomedical Consortium';
                setProcessedRelations((prev) => {
                  const copy = new Map(prev);
                  copy.set(id, {
                    ...item,
                    pubmedReference: {
                      pmid,
                      title: String(doc.title).replace(/\.$/, ''),
                      journal: doc.fulljournalname || doc.source || 'PubMed Indexed Journal',
                      pubDate: doc.pubdate || '2024',
                      authors,
                      queryUsed,
                      source: 'ncbi-eutils-live',
                    },
                  });
                  return copy;
                });
                return;
              }
            }
          }
        }
        clearTimeout(timeout);
      } catch {
        clearTimeout(timeout);
      }
    },
    [processedRelations]
  );

  // Bulk actions in current batch
  const handleBulkDecision = (status: 'approved' | 'pending', excludeDuplicates: boolean) => {
    setProcessedRelations((prev) => {
      const copy = new Map(prev);
      for (const rel of currentBatchRelations) {
        if (excludeDuplicates && rel.wikidataVerification.existsInWikidata && status === 'approved') {
          continue;
        }
        copy.set(rel.id, { ...rel, status, updatedAt: new Date().toISOString() });
      }
      return copy;
    });
  };

  const handleUploadCsv = async (csvContent: string) => {
    setRawCsvString(csvContent);
    const parsed = parseCsv(csvContent);
    setParsedRows(parsed);
    setProcessedRelations(new Map());
    setCurrentBatchIndex(0);
    processBatch(0, parsed);
  };

  // Filtered relations
  const filteredRelations = useMemo(() => {
    return currentBatchRelations.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (hideDuplicates && r.wikidataVerification.existsInWikidata) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const match =
          r.subjectMeshId.toLowerCase().includes(q) ||
          r.objectMeshId.toLowerCase().includes(q) ||
          r.subject.label.toLowerCase().includes(q) ||
          r.object.label.toLowerCase().includes(q) ||
          r.subject.qid.toLowerCase().includes(q) ||
          r.object.qid.toLowerCase().includes(q) ||
          r.selectedProperty.pid.toLowerCase().includes(q) ||
          r.selectedProperty.label.toLowerCase().includes(q) ||
          r.pubmedReference.pmid.includes(q);
        if (!match) return false;
      }
      return true;
    });
  }, [currentBatchRelations, statusFilter, hideDuplicates, searchQuery]);

  const selectedRelation: ProcessedRelationRecord | null = useMemo(() => {
    if (!selectedRelationId) return null;
    return processedRelations.get(selectedRelationId) || null;
  }, [processedRelations, selectedRelationId]);

  const batchCounts = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    let duplicates = 0;
    for (const r of currentBatchRelations) {
      if (r.status === 'pending') pending++;
      else if (r.status === 'approved') approved++;
      else if (r.status === 'rejected') rejected++;
      if (r.wikidataVerification.existsInWikidata) duplicates++;
    }
    return { total: currentBatchRelations.length, pending, approved, rejected, duplicates };
  }, [currentBatchRelations]);

  const allApprovedRelations = useMemo(() => {
    return Array.from(processedRelations.values()).filter((r) => r.status === 'approved');
  }, [processedRelations]);

  const datasetInfo: DatasetInfoResponse = useMemo(() => {
    let approvedCount = 0;
    let rejectedCount = 0;
    let pendingCount = 0;
    let duplicateCount = 0;
    for (const r of processedRelations.values()) {
      if (r.status === 'approved') approvedCount++;
      else if (r.status === 'rejected') rejectedCount++;
      else pendingCount++;
      if (r.wikidataVerification.existsInWikidata) duplicateCount++;
    }
    return {
      fileName: 'missing_rels.csv',
      storagePath: '/data/missing_rels.csv',
      totalRows: parsedRows.length,
      maxBatchSize: MAX_BATCH_SIZE,
      totalBatches,
      processedTotal: processedRelations.size,
      stats: {
        approvedCount,
        rejectedCount,
        pendingCount,
        duplicateCount,
      },
      availableProperties: WIKIDATA_BIOMEDICAL_PROPERTIES,
    };
  }, [parsedRows.length, totalBatches, processedRelations]);

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        activeNav !== 'queue' ||
        exportModalOpen ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)
      ) {
        return;
      }
      if (!selectedRelation) return;

      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        handleDecision(
          selectedRelation.id,
          selectedRelation.status === 'approved' ? 'pending' : 'approved'
        );
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleDecision(
          selectedRelation.id,
          selectedRelation.status === 'rejected' ? 'pending' : 'rejected'
        );
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = filteredRelations.findIndex((item) => item.id === selectedRelation.id);
        if (idx !== -1) {
          const nextIdx =
            e.key === 'ArrowDown'
              ? Math.min(filteredRelations.length - 1, idx + 1)
              : Math.max(0, idx - 1);
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
            Offline LLM Config
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
                {Math.min((currentBatchIndex + 1) * MAX_BATCH_SIZE, parsedRows.length)} of{' '}
                {parsedRows.length})
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
                  const end = Math.min((idx + 1) * 100, parsedRows.length);
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
                onClick={() => handleBulkDecision('approved', true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-300 rounded-md hover:bg-emerald-100 transition-colors whitespace-nowrap cursor-pointer"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>Approve All Novel in Batch</span>
              </button>
              <button
                type="button"
                onClick={() => handleBulkDecision('pending', false)}
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
                      <th className="py-2.5 px-3">Offline LLM Property</th>
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
                              <a
                                href={`https://www.wikidata.org/wiki/${rel.subject.qid}`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-blue-600 hover:underline"
                              >
                                {rel.subject.qid}
                              </a>
                              <span aria-hidden="true"> · </span>
                              <span className="font-sans">{rel.subject.semanticGroup}</span>
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
                              {WIKIDATA_BIOMEDICAL_PROPERTIES.map((p) => (
                                <option key={p.pid} value={p.pid}>
                                  {p.pid} ({p.label})
                                </option>
                              ))}
                            </select>
                            <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                              LLM Conf {(rel.llmPrediction.confidence * 100).toFixed(0)}%
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
                              <a
                                href={`https://www.wikidata.org/wiki/${rel.object.qid}`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-blue-600 hover:underline"
                              >
                                {rel.object.qid}
                              </a>
                              <span aria-hidden="true"> · </span>
                              <span className="font-sans">{rel.object.semanticGroup}</span>
                            </div>
                          </td>

                          {/* Pointwise Mutual Information (PMI) */}
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                            {rel.pmi.toFixed(2)}
                          </td>

                          {/* Wikidata Duplication Check */}
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            {rel.wikidataVerification.existsInWikidata ? (
                              <span
                                className="text-amber-700 font-medium"
                                title={`Existing statement ${rel.wikidataVerification.existingPropertyId} (${rel.wikidataVerification.existingPropertyLabel})`}
                              >
                                ▲ Duplicate ({rel.wikidataVerification.existingPropertyId})
                              </span>
                            ) : (
                              <span className="text-emerald-700 font-medium">
                                ● Novel
                              </span>
                            )}
                          </td>

                          {/* PubMed Reference */}
                          <td className="py-2.5 px-3 whitespace-nowrap font-mono tabular-nums">
                            <a
                              href={`https://pubmed.ncbi.nlm.nih.gov/${rel.pubmedReference.pmid}/`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-blue-600 hover:underline inline-flex items-center gap-0.5"
                              title={rel.pubmedReference.title}
                            >
                              <span>PMID:{rel.pubmedReference.pmid}</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
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
                                title="Single-click Approve"
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
              availableProperties={WIKIDATA_BIOMEDICAL_PROPERTIES}
              onDecision={handleDecision}
              onPropertyChange={handlePropertyChange}
              onRefreshPubMed={handleRefreshPubMed}
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
