export type SemanticGroup =
  | 'Disease & Syndrome'
  | 'Neoplastic Process'
  | 'Pharmacologic Substance'
  | 'Gene, Protein & Receptor'
  | 'Cell & Tissue'
  | 'Anatomical Structure'
  | 'Diagnostic & Lab Procedure'
  | 'Therapeutic Procedure'
  | 'Biological Function'
  | 'Organism & Model'
  | 'Epidemiology & Healthcare'
  | 'Environmental & Chemical';

export interface MeshEntityInfo {
  meshId: string;
  qid: string;
  label: string;
  description: string;
  semanticGroup: SemanticGroup;
  treeNumber?: string;
}

export interface WikidataPropertySpec {
  pid: string;
  label: string;
  description: string;
  inversePid?: string;
  domainGroups: SemanticGroup[];
  rangeGroups: SemanticGroup[];
  exampleUsage: string;
}

export interface PubMedReference {
  pmid: string;
  title: string;
  journal: string;
  pubDate: string;
  authors: string;
  queryUsed: string;
  source: 'ncbi-eutils-live' | 'pubmed-indexed-cache';
}

export interface WikidataVerification {
  existsInWikidata: boolean;
  existingPropertyId?: string;
  existingPropertyLabel?: string;
  checkedAt: string;
  sparqlEndpoint: string;
  verificationMode: 'live-sparql' | 'local-kg-index';
}

export interface ProcessedRelationRecord {
  id: string;
  rowIndex: number;
  tupleRaw: string;
  subjectMeshId: string;
  objectMeshId: string;
  pmi: number;
  subject: MeshEntityInfo;
  object: MeshEntityInfo;
  selectedProperty: WikidataPropertySpec;
  llmPrediction: {
    recommendedProperty: WikidataPropertySpec;
    confidence: number;
    reasoning: string;
    alternatives: Array<{ property: WikidataPropertySpec; score: number }>;
    modelId: string;
    latencyMs: number;
  };
  wikidataVerification: WikidataVerification;
  pubmedReference: PubMedReference;
  status: 'pending' | 'approved' | 'rejected';
  updatedAt: string;
}

export interface DatasetInfoResponse {
  fileName: string;
  storagePath: string;
  totalRows: number;
  maxBatchSize: number;
  totalBatches: number;
  processedTotal: number;
  stats: {
    approvedCount: number;
    rejectedCount: number;
    pendingCount: number;
    duplicateCount: number;
  };
  availableProperties: WikidataPropertySpec[];
}

export interface BatchResponse {
  batchIndex: number;
  batchSize: number;
  startRow: number;
  endRow: number;
  totalRows: number;
  totalBatches: number;
  relations: ProcessedRelationRecord[];
}

export interface QuickStatementsExportResponse {
  count: number;
  v1TabSeparated: string;
  v1PipeCommands: string;
  v2Csv: string;
  records: ProcessedRelationRecord[];
}
