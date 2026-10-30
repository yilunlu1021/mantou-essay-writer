/** Check declared material logic gaps against declared 0-5 ratings. Does not grade text. */
export function logicScoreConsistency(record: {
  items: { id: string; score: number | null }[];
  criticalChecks: { id: string; status: string }[];
  issues: { id: string; itemIds: string[]; severity: string; decision: string }[];
}) {
  const groups: Record<string, string[]> = {
    'causal-chain': ['P1.4', 'C2.1', 'C2.2', 'C2.3', 'C2.4', 'C2.5'],
    'action-evidence': ['E3.1', 'E3.2', 'E3.3', 'E3.4', 'E3.5'],
    'first-read': ['N4.1', 'N4.2', 'P1.3', 'P1.5']
  };
  const logicIds = new Set(Object.values(groups).flat()), scores = new Map(record.items.map(i => [i.id, i.score]));
  const material = record.issues.filter(i => i.severity === 'material');
  const conflicts: { id: string; itemIds: string[]; code: string }[] = [];
  for (const issue of material) {
    const inflated = issue.itemIds.filter(id => logicIds.has(id) && (scores.get(id) ?? 0) > 3);
    if (inflated.length) conflicts.push({ id: issue.id, itemIds: inflated, code: 'material-logic-gap-score-above-three' });
  }
  for (const check of record.criticalChecks.filter(c => c.status === 'needs-rework')) {
    const affected = groups[check.id] ?? [];
    if (!material.some(issue => issue.itemIds.some(id => affected.includes(id))))
      conflicts.push({ id: check.id, itemIds: [], code: 'material-logic-gap-needs-criterion-attribution' });
  }
  return { engine: 'logic-score-consistency@1', conflicts, verified: conflicts.length === 0,
    semanticRatingCertified: false, automaticScoreAdjustment: false };
}
