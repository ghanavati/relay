export type ComplexityTier = 'simple' | 'moderate' | 'complex';

const SIMPLE_KEYWORDS = [
  'fix typo', 'rename', 'comment', 'format', 'lint', 'style',
  'bump version', 'update version', 'fix spelling', 'fix whitespace',
];

const COMPLEX_KEYWORDS = [
  'refactor', 'migrate', 'redesign', 'rewrite', 'architecture',
  'multi-file', 'schema change', 'database migration', 'breaking change',
];

export function classifyTaskComplexity(task: string): ComplexityTier {
  const lower = task.toLowerCase();
  if (COMPLEX_KEYWORDS.some(k => lower.includes(k))) return 'complex';
  if (SIMPLE_KEYWORDS.some(k => lower.includes(k))) return 'simple';
  return 'moderate';
}

export function getAllowedLayersForTier(tier: ComplexityTier): Set<string> | null {
  if (tier === 'simple') {
    return new Set([
      'worker_constraints',
      'agents',
      'caller_context',
      'project_knowledge',
    ]);
  }
  return null;
}
