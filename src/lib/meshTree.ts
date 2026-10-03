import { SemanticGroup } from '../types';

/**
 * Coarse mapping from MeSH tree numbers (Wikidata property P672) to the semantic
 * groups used by the property classifier. It is a heuristic, not a UMLS semantic
 * type lookup, but unlike a hash of the identifier it is derived from real data.
 */
export function groupFromTreeNumber(tree: string): SemanticGroup | null {
  const m = tree.trim().toUpperCase().match(/^([A-Z])(\d{2})/);
  if (!m) return null;
  const letter = m[1];
  const key = `${m[1]}${m[2]}`;

  switch (letter) {
    case 'A':
      return key === 'A10' || key === 'A11' ? 'Cell & Tissue' : 'Anatomical Structure';
    case 'B':
      return 'Organism & Model';
    case 'C':
      return key === 'C04' ? 'Neoplastic Process' : 'Disease & Syndrome';
    case 'D':
      if (key === 'D08' || key === 'D12' || key === 'D13') return 'Gene, Protein & Receptor';
      if (key === 'D01' || key === 'D20') return 'Environmental & Chemical';
      return 'Pharmacologic Substance';
    case 'E':
      if (key === 'E01' || key === 'E05') return 'Diagnostic & Lab Procedure';
      if (key === 'E02' || key === 'E03' || key === 'E04' || key === 'E06') return 'Therapeutic Procedure';
      return null;
    case 'F':
      return key === 'F03' ? 'Disease & Syndrome' : 'Biological Function';
    case 'G':
      return 'Biological Function';
    case 'H':
    case 'I':
    case 'J':
    case 'K':
    case 'L':
    case 'M':
    case 'N':
      return 'Epidemiology & Healthcare';
    default:
      return null;
  }
}

/** Most frequent group over all tree numbers of a descriptor (ties: first listed). */
export function groupFromTreeNumbers(trees: string[]): SemanticGroup | null {
  const counts = new Map<SemanticGroup, number>();
  const order: SemanticGroup[] = [];
  for (const t of trees) {
    const g = groupFromTreeNumber(t);
    if (!g) continue;
    if (!counts.has(g)) order.push(g);
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  let best: SemanticGroup | null = null;
  let bestCount = 0;
  for (const g of order) {
    const c = counts.get(g) || 0;
    if (c > bestCount) {
      best = g;
      bestCount = c;
    }
  }
  return best;
}
