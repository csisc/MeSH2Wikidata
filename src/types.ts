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

/**
 * How a MeSH identifier was (or was not) mapped to a Wikidata item.
 *  - resolved:   exactly one item carries this MeSH descriptor ID (P486)
 *  - ambiguous:  several items carry it; the first is shown, curator must check
 *  - not-found:  no item has this descriptor ID
 *  - qualifier:  a MeSH qualifier/subheading (Qxxxxxx), not a descriptor
 *  - pending:    lookup not finished yet
 *  - error:      lookup failed (network, rate limit...)
 */
export type MeshResolution = 'resolved' | 'ambiguous' | 'not-found' | 'qualifier' | 'pending' | 'error';

export interface MeshEntityInfo {
  meshId: string;
  qid: string | null;
  label: string;
  description: string;
  semanticGroup: SemanticGroup | null;
  treeNumbers: string[];
  /** English aliases from Wikidata, used as extra PubMed search names */
  aliases?: string[];
  resolution: MeshResolution;
  candidateQids?: string[];
}

export interface WikidataPropertySpec {
  pid: string;
  label: string;
  description: string;
  inversePid?: string;
  domainGroups: SemanticGroup[];
  rangeGroups: SemanticGroup[];
  exampleUsage: string;
  /** Topic bucket shown in the property table */
  category?: string;
  /** Structural/meta property (instance of, part of...): ranked below specific properties of equal fit */
  generic?: boolean;
  /** Added by the curator at runtime, not part of the curated list */
  custom?: boolean;
}

export interface PubMedReference {
  pmid: string;
  title: string;
  journal: string;
  pubDate: string;
  authors: string;
  queryUsed: string;
  /**
   * sentence-with-relation: one sentence names both items and a keyword typical for the property
   * sentence:               one sentence names both items
   * abstract:               both items occur in title/abstract, but not in the same sentence
   */
  matchLevel: 'sentence-with-relation' | 'sentence' | 'abstract';
  /** number of PubMed records matching the search that produced this reference */
  hitCount: number;
  /** up to two sentences from the abstract that mention the items */
  evidence: string[];
}

export type PubMedState = 'idle' | 'loading' | 'found' | 'none' | 'error';

export interface ExistingLink {
  pid: string;
  label: string;
  /** forward: subject -> object, reverse: object -> subject */
  direction: 'forward' | 'reverse';
  /** number of references on the existing statement(s) (deprecated statements ignored) */
  referenceCount: number;
  /** PubMed IDs (P698) found in those references */
  pmids: string[];
}

export interface WikidataVerification {
  state: 'pending' | 'checked' | 'error' | 'skipped';
  existing: ExistingLink[];
  checkedAt?: string;
  error?: string;
}

export interface LlmPrediction {
  recommendedProperty: WikidataPropertySpec;
  confidence: number;
  reasoning: string;
  alternatives: Array<{ property: WikidataPropertySpec; score: number }>;
  modelId: string;
  latencyMs: number;
  engine: 'rule-based' | 'ollama';
  /** set when an Ollama call was requested but failed and the rule-based result is shown instead */
  fallbackReason?: string;
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
  llmPrediction: LlmPrediction;
  wikidataVerification: WikidataVerification;
  pubmedReference: PubMedReference | null;
  /** other papers returned by the same search (the chosen one is pubmedReference) */
  pubmedCandidates: PubMedReference[];
  pubmedState: PubMedState;
  pubmedError?: string;
  status: 'pending' | 'approved' | 'rejected';
  updatedAt: string;
}

export interface DatasetInfoResponse {
  fileName: string;
  storagePath: string;
  totalRows: number;
  skippedRows: number;
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
  /** Properties whose ID failed the live label check and are therefore not offered */
  excludedPids: string[];
}

export interface LlmConfig {
  mode: 'rule-based' | 'ollama';
  /** Base URL of the Ollama server, e.g. http://localhost:11434 */
  ollamaUrl: string;
  ollamaModel: string;
  /** Rows below this confidence are not touched by "Approve all novel in batch" */
  minConfidence: number;
  /** Optional NCBI API key: raises the E-utilities limit from 3 to 10 requests/second */
  ncbiApiKey: string;
}
