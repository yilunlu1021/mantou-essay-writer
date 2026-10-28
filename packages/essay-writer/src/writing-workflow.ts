import { z } from 'zod';
import { auditText, hashValue } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { fail } from './files.js';
import { reviewBindings, reviewBindingsSchema } from './source-review.js';
import { reviewSource } from './source-review.js';
import { reviewAnswer } from './answer-review.js';
import { reviewStyle, styleEvidenceSchema } from './style-review.js';
import { reviewLinguistic } from './linguistic-review.js';
import { reviewDiscourse } from './discourse-review.js';
import { prepareRuleReview, reviewRules } from './rule-review.js';

export const WRITING_WORKFLOW_VERSION = 'writing-workflow@1' as const;
const reviewNames = ['rules', 'source', 'answer', 'style', 'linguistic', 'discourse'] as const;
export const writingWorkflowSchema = z.object({
  schemaVersion: z.literal(WRITING_WORKFLOW_VERSION), bindings: reviewBindingsSchema,
  reviews: z.object({ rules: z.unknown().nullable(), source: z.unknown().nullable(), answer: z.unknown().nullable(),
    style: z.unknown().nullable(), linguistic: z.unknown().nullable(), discourse: z.unknown().nullable() }).strict(),
  evidence: z.unknown().nullable()
}).strict();

export async function prepareWritingWorkflow(policyRoot: string, path: string) {
  const s = await loadSession(policyRoot, path), rules = await prepareRuleReview(policyRoot, path);
  return {
    schemaVersion: WRITING_WORKFLOW_VERSION, bindings: reviewBindings(s),
    stages: [
      { id: 'task', instruction: 'Read the prompt, original, complete current policy and task-specific preparation.' },
      { id: 'diagnose', commands: ['prepare-answer-review', 'prepare-source-review'], instruction: 'Diagnose before editing. Preserve source facts and author voice.' },
      { id: 'edit', commands: ['prepare', 'revise'], instruction: 'Apply exact, justified patches. Keep the original and completed versions unchanged.' },
      { id: 'syntax', commands: ['prepare-rule-review', 'review-rules'], instruction: 'Cover each unit and all grammar inventory items. Declare missing evidence instead of manufacturing it.' },
      { id: 'content', commands: ['review-source', 'review-answer', 'review-style', 'review-linguistic', 'review-discourse'], instruction: 'Use the existing prepare commands and validate current records. Keep every explicit local failure.' },
      { id: 'repair', instruction: 'Repair with a new patch and regenerate records for the complete current version. If repairs stall, report exact blockers; do not weaken rules or invent material.' },
      { id: 'check', commands: ['check-workflow'], instruction: 'Assemble the six full review input records into this template, not their output summaries. Ready means ready for human review only.' }
    ],
    ruleReview: rules,
    template: { schemaVersion: WRITING_WORKFLOW_VERSION, bindings: reviewBindings(s),
      reviews: { rules: null, source: null, answer: null, style: null, linguistic: null, discourse: null }, evidence: null },
    containsDocumentText: true, requiresHumanReview: true, deliveryAuthorized: false
  };
}

export async function checkWritingWorkflow(policyRoot: string, path: string, raw: unknown) {
  const s = await loadSession(policyRoot, path), record = writingWorkflowSchema.parse(raw);
  if (hashValue(record.bindings) !== hashValue(reviewBindings(s)))
    fail('writing-workflow-stale', 'Prepare for the current original, version, task and policy.');
  const evidence = record.evidence === null ? undefined : styleEvidenceSchema.parse(record.evidence);
  const validators = {
    rules: (value: unknown) => reviewRules(policyRoot, path, value),
    source: (value: unknown) => reviewSource(policyRoot, path, value),
    answer: (value: unknown) => reviewAnswer(policyRoot, path, value),
    style: (value: unknown) => reviewStyle(policyRoot, path, value, evidence),
    linguistic: (value: unknown) => reviewLinguistic(policyRoot, path, value, evidence),
    discourse: (value: unknown) => reviewDiscourse(policyRoot, path, value)
  };
  const summaries: { name: string; state: string; recordHash: string | null }[] = [];
  for (const name of reviewNames) {
    const value = record.reviews[name];
    if (value === null || value === undefined) { summaries.push({ name, state: 'missing', recordHash: null }); continue; }
    const result = await validators[name](value);
    summaries.push({ name, state: result.reviewDecision, recordHash: result.recordHash });
  }
  const audit = auditText({ schemaVersion: '1.0.0', context: s.manifest.context, document: s.document, original: s.original }, s.policy);
  const mechanicalErrors = audit.findings.filter(finding => finding.severity === 'error').map(finding => ({ ruleId: finding.ruleId, code: finding.code }));
  if (audit.observedErrors > mechanicalErrors.length || (audit.qualityDecision === 'blocked' && !mechanicalErrors.length))
    mechanicalErrors.push({ ruleId: 'audit', code: 'additional-mechanical-errors' });
  const blocked = audit.qualityDecision === 'blocked' || audit.observedErrors > 0 || summaries.some(item => item.state === 'needs-rework');
  const pending = audit.findingsTruncated || summaries.some(item => item.state !== 'recorded');
  return {
    schemaVersion: WRITING_WORKFLOW_VERSION, bindings: reviewBindings(s), recordHash: hashValue(record),
    workflowStatus: blocked ? 'needs-rework' : pending ? 'needs-review' : 'ready-for-human-review',
    reviews: summaries, mechanicalErrors, mechanicalErrorsObserved: audit.observedErrors,
    findingsTruncated: audit.findingsTruncated, metrics: audit.metrics,
    recordsComplete: !pending, modelExecutionVerified: false, atomicCoverageCertified: false,
    factsCertified: false, syntaxCertified: false, voiceCertified: false,
    containsDocumentText: false, requiresHumanReview: true, deliveryAuthorized: false
  };
}
