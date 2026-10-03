import { SemanticGroup, WikidataPropertySpec } from '../types';

/*
 * Candidate Wikidata properties for MeSH-to-MeSH statements (item -> item).
 *
 * The list is curated by hand. `domainGroups` / `rangeGroups` say which MeSH-derived categories
 * normally appear as subject / object, and drive the rule-based scorer and the prompt sent to a
 * local LLM. Every ID is checked against the live Wikidata label when the app starts; a property
 * whose label does not match is switched off and flagged under "Property Classifier".
 * To add one: append an entry below, or use "Other property ID" in the inspector for a one-off.
 */

const DIS: SemanticGroup[] = ['Disease & Syndrome', 'Neoplastic Process'];
const DRUG: SemanticGroup[] = ['Pharmacologic Substance'];
const TREAT: SemanticGroup[] = ['Therapeutic Procedure'];
const DIAG: SemanticGroup[] = ['Diagnostic & Lab Procedure'];
const GENE: SemanticGroup[] = ['Gene, Protein & Receptor'];
const CELL: SemanticGroup[] = ['Cell & Tissue'];
const ANAT: SemanticGroup[] = ['Anatomical Structure'];
const FUNC: SemanticGroup[] = ['Biological Function'];
const ORG: SemanticGroup[] = ['Organism & Model'];
const EPI: SemanticGroup[] = ['Epidemiology & Healthcare'];
const CHEM: SemanticGroup[] = ['Environmental & Chemical'];
const ALL: SemanticGroup[] = [
  'Disease & Syndrome', 'Neoplastic Process', 'Pharmacologic Substance', 'Gene, Protein & Receptor',
  'Cell & Tissue', 'Anatomical Structure', 'Diagnostic & Lab Procedure', 'Therapeutic Procedure',
  'Biological Function', 'Organism & Model', 'Epidemiology & Healthcare', 'Environmental & Chemical',
];

function p(
  category: string,
  pid: string,
  label: string,
  description: string,
  domainGroups: SemanticGroup[],
  rangeGroups: SemanticGroup[],
  exampleUsage: string,
  extra: { inversePid?: string; generic?: boolean } = {}
): WikidataPropertySpec {
  return { pid, label, description, domainGroups, rangeGroups, exampleUsage, category, ...extra };
}

const TX = 'Treatment & clinical';
const DM = 'Disease mechanisms';
const GM = 'Genes & molecular biology';
const AC = 'Anatomy & cells';
const OR = 'Organisms';
const CP = 'Chemistry & pharmacology';
const ST = 'General / structural';

export const WIKIDATA_BIOMEDICAL_PROPERTIES: WikidataPropertySpec[] = [
  // ---- Treatment & clinical -------------------------------------------------------------
  p(TX, 'P2176', 'drug or therapy used for treatment', 'Drug, procedure or therapy used to treat this medical condition', DIS, [...DRUG, ...TREAT], 'Mouth Neoplasms -> P2176 -> Photochemotherapy', { inversePid: 'P2175' }),
  p(TX, 'P2175', 'medical condition treated', 'Disease or condition treated by this drug or therapeutic procedure', [...DRUG, ...TREAT], DIS, 'Photochemotherapy -> P2175 -> Skin Neoplasms', { inversePid: 'P2176' }),
  p(TX, 'P923', 'medical examination', 'Diagnostic test or clinical procedure used to evaluate or diagnose this condition', [...DIS, ...EPI], DIAG, 'Endocrine System Diseases -> P923 -> Endocrine Diagnostic Techniques'),
  p(TX, 'P780', 'symptoms and signs', 'Symptom or sign associated with this condition', DIS, DIS, 'Influenza -> P780 -> Fever'),
  p(TX, 'P1909', 'side effect', 'Unwanted effect of a drug or therapy', [...DRUG, ...TREAT], DIS, 'Methotrexate -> P1909 -> Stomatitis'),
  p(TX, 'P769', 'significant drug interaction', 'Drug that has a significant interaction with this drug', DRUG, DRUG, 'Warfarin -> P769 -> Aspirin'),
  p(TX, 'P636', 'route of administration', 'Path by which a drug or therapy is taken into the body', DRUG, TREAT, 'Insulin -> P636 -> Administration, Subcutaneous'),
  p(TX, 'P4044', 'therapeutic area', 'Disease area in which a drug or therapy is used', [...DRUG, ...TREAT], [...EPI, ...DIS], 'Antineoplastic Agents -> P4044 -> Oncology'),
  p(TX, 'P1995', 'health specialty', 'Medical specialty that deals with this condition or procedure', [...DIS, ...TREAT, ...DIAG], EPI, 'Glaucoma -> P1995 -> Ophthalmology'),
  p(TX, 'P3354', 'positive therapeutic predictor', 'Genetic variant or biomarker predicting a good response to a therapy', [...GENE, ...CHEM], [...DRUG, ...TREAT], 'EGFR Mutation -> P3354 -> Gefitinib'),
  p(TX, 'P3355', 'negative therapeutic predictor', 'Genetic variant or biomarker predicting a poor response to a therapy', [...GENE, ...CHEM], [...DRUG, ...TREAT], 'KRAS Mutation -> P3355 -> Cetuximab'),
  p(TX, 'P3356', 'positive diagnostic predictor', 'Biomarker whose presence supports a diagnosis', [...GENE, ...CHEM, ...DIAG], DIS, 'Prostate-Specific Antigen -> P3356 -> Prostatic Neoplasms'),
  p(TX, 'P3357', 'negative diagnostic predictor', 'Biomarker whose presence argues against a diagnosis', [...GENE, ...CHEM, ...DIAG], DIS, 'Rheumatoid Factor -> P3357 -> Osteoarthritis'),
  p(TX, 'P3358', 'positive prognostic predictor', 'Biomarker associated with a better outcome', [...GENE, ...CHEM], DIS, 'Estrogen Receptors -> P3358 -> Breast Neoplasms'),
  p(TX, 'P3359', 'negative prognostic predictor', 'Biomarker associated with a worse outcome', [...GENE, ...CHEM], DIS, 'Receptor, ErbB-2 -> P3359 -> Breast Neoplasms'),

  // ---- Disease mechanisms ---------------------------------------------------------------
  p(DM, 'P828', 'has cause', 'Underlying cause, entity or process that brings this about', [...DIS, ...FUNC], [...DIS, ...CHEM, ...DRUG, ...ORG, ...GENE, ...FUNC], 'Cholera -> P828 -> Vibrio cholerae'),
  p(DM, 'P1542', 'has effect', 'Effect that this entity or process produces', [...CHEM, ...DRUG, ...ORG, ...GENE, ...FUNC, ...DIS], [...DIS, ...FUNC], 'Asbestos -> P1542 -> Mesothelioma'),
  p(DM, 'P5642', 'risk factor', 'Factor that increases the chance of developing this condition', DIS, [...CHEM, ...DRUG, ...ORG, ...FUNC, ...EPI, ...DIS], 'Lung Neoplasms -> P5642 -> Smoking'),
  p(DM, 'P1060', 'pathogen transmission process', 'Way in which a pathogen or disease spreads', DIS, [...FUNC, ...ORG, ...EPI], 'Malaria -> P1060 -> Vector Borne Transmission'),
  p(DM, 'P2293', 'genetic association', 'Gene, protein or molecular factor associated with this phenotype or disorder', [...DIS, ...FUNC], GENE, 'Mouth Neoplasms -> P2293 -> Tumor Suppressor Proteins'),
  p(DM, 'P927', 'anatomical location', 'Anatomical structure, tissue or cell type where this condition or entity is found', [...DIS, ...FUNC, ...GENE], [...ANAT, ...CELL], 'Mouth Neoplasms -> P927 -> Epithelial Cells'),

  // ---- Genes & molecular biology --------------------------------------------------------
  p(GM, 'P688', 'encodes', 'Product (protein or RNA) encoded by this gene', GENE, GENE, 'Genes, p53 -> P688 -> Tumor Suppressor Protein p53', { inversePid: 'P702' }),
  p(GM, 'P702', 'encoded by', 'Gene that encodes this protein or RNA', GENE, GENE, 'Tumor Suppressor Protein p53 -> P702 -> Genes, p53', { inversePid: 'P688' }),
  p(GM, 'P684', 'ortholog', 'Gene in another species with the same evolutionary origin and function', GENE, GENE, 'Insulin -> P684 -> Insulin, Long-Acting'),
  p(GM, 'P129', 'physically interacts with', 'Protein, chemical or cellular component that directly binds or interacts with this entity', [...GENE, ...DRUG, ...CHEM, ...CELL], [...GENE, ...DRUG, ...CHEM, ...CELL], 'DNA-Binding Proteins -> P129 -> Transcription Factors'),
  p(GM, 'P680', 'molecular function', 'Elementary activity of a gene product at the molecular level', GENE, FUNC, 'Receptors, Adrenergic -> P680 -> Signal Transduction'),
  p(GM, 'P681', 'cell component', 'Cellular location where a gene product is active', [...GENE, ...FUNC], CELL, 'Histones -> P681 -> Chromatin'),
  p(GM, 'P682', 'biological process', 'Biological or physiological process in which this entity participates', [...GENE, ...CELL, ...DRUG, ...ANAT], [...FUNC, ...DIS], 'Leukocytes, Mononuclear -> P682 -> Immunity, Cellular'),
  p(GM, 'P1057', 'chromosome', 'Chromosome on which this gene is located', GENE, CELL, 'Genes, BRCA1 -> P1057 -> Chromosomes, Human, Pair 17'),
  p(GM, 'P3433', 'biological variant of', 'Variant, isoform or strain derived from another biological entity', [...GENE, ...ORG], [...GENE, ...ORG], 'Hemoglobin S -> P3433 -> Hemoglobin A'),

  // ---- Anatomy & cells ------------------------------------------------------------------
  p(AC, 'P3261', 'anatomical branch of', 'Anatomical structure that branches from another', ANAT, ANAT, 'Carotid Artery, External -> P3261 -> Carotid Artery, Common'),
  p(AC, 'P2789', 'connects with', 'Anatomical structure physically connected to this one', [...ANAT, ...CELL], [...ANAT, ...CELL], 'Fallopian Tubes -> P2789 -> Uterus'),

  // ---- Organisms ------------------------------------------------------------------------
  p(OR, 'P703', 'found in taxon', 'Taxon in which this gene, compound, disease or cell type is found', [...GENE, ...DRUG, ...CHEM, ...DIS, ...CELL], ORG, 'Tetrodotoxin -> P703 -> Tetraodontiformes'),
  p(OR, 'P171', 'parent taxon', 'Closest parent taxon of this organism', ORG, ORG, 'Escherichia coli -> P171 -> Escherichia'),
  p(OR, 'P1034', 'main food source', 'Primary food of this organism', ORG, [...ORG, ...CHEM], 'Anopheles -> P1034 -> Blood'),
  p(OR, 'P1056', 'product or material produced', 'Product or material that this organism, cell or process produces', [...ORG, ...CELL], [...DRUG, ...CHEM, ...GENE], 'Penicillium -> P1056 -> Penicillins'),
  p(OR, 'P1582', 'natural product of taxon', 'Organism that naturally produces this chemical', [...DRUG, ...CHEM], ORG, 'Quinine -> P1582 -> Cinchona'),

  // ---- Chemistry & pharmacology ---------------------------------------------------------
  p(CP, 'P3781', 'has active ingredient', 'Active chemical component of this drug or preparation', DRUG, [...DRUG, ...CHEM], 'Aspirin/caffeine -> P3781 -> Aspirin', { inversePid: 'P3780' }),
  p(CP, 'P3780', 'active ingredient in', 'Drug or preparation that contains this active ingredient', [...DRUG, ...CHEM], DRUG, 'Aspirin -> P3780 -> Aspirin/caffeine', { inversePid: 'P3781' }),
  p(CP, 'P3364', 'stereoisomer of', 'Compound with the same atoms but different spatial arrangement', [...DRUG, ...CHEM], [...DRUG, ...CHEM], 'Levodopa -> P3364 -> Dextrodopa'),
  p(CP, 'P2868', 'subject has role', 'Role (function or use) that this substance plays', [...DRUG, ...CHEM, ...GENE], [...DRUG, ...CHEM, ...FUNC], 'Atropine -> P2868 -> Muscarinic Antagonists'),
  p(CP, 'P366', 'has use', 'Use or purpose of this substance, tool or procedure', [...DRUG, ...CHEM], [...FUNC, ...TREAT, ...EPI], 'Chlorhexidine -> P366 -> Antisepsis'),
  p(CP, 'P1535', 'used by', 'Person, procedure or field that uses this substance or tool', [...DRUG, ...CHEM, ...GENE], [...DIAG, ...TREAT], 'Radioisotopes -> P1535 -> Nuclear Medicine'),
  p(CP, 'P2283', 'uses', 'Substance, tool or concept used by this procedure', [...DIAG, ...TREAT], [...DRUG, ...CHEM, ...GENE], 'Immunoassay -> P2283 -> Antibodies'),

  // ---- General / structural (ranked below specific properties of equal fit) -------------
  p(ST, 'P2579', 'studied by', 'Discipline or field that studies this topic', [...DIS, ...ORG, ...GENE, ...FUNC, ...ANAT, ...CELL], EPI, 'Neoplasms -> P2579 -> Oncology', { inversePid: 'P2578' }),
  p(ST, 'P2578', 'studies', 'Topic studied by this discipline or field', EPI, [...DIS, ...ORG, ...GENE, ...FUNC, ...ANAT, ...CELL], 'Cardiology -> P2578 -> Heart Diseases', { inversePid: 'P2579' }),
  p(ST, 'P279', 'subclass of', 'This entity is a more specific kind of another', ALL, ALL, 'Mouth Neoplasms -> P279 -> Head and Neck Neoplasms', { generic: true }),
  p(ST, 'P31', 'instance of', 'This entity is an individual member of a class', ALL, ALL, 'Dacarbazine -> P31 -> Antineoplastic Agents', { generic: true }),
  p(ST, 'P361', 'part of', 'This entity is a component of a larger one', ALL, ALL, 'Hippocampus -> P361 -> Limbic System', { generic: true, inversePid: 'P527' }),
  p(ST, 'P527', 'has part(s)', 'This entity is composed of the following parts', ALL, ALL, 'Limbic System -> P527 -> Hippocampus', { generic: true, inversePid: 'P361' }),
  p(ST, 'P2670', 'has part(s) of the class', 'This entity has parts that belong to the given class', ALL, ALL, 'Skeleton -> P2670 -> Bones', { generic: true }),
  p(ST, 'P1269', 'facet of', 'This topic is one aspect of a broader topic', ALL, ALL, 'Drug Resistance -> P1269 -> Pharmacology', { generic: true }),
];
