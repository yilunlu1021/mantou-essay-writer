import { z } from 'zod';
import { hashValue } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { fail } from './files.js';
import { HUMANIER_METHOD_VERSION, reviewBindingsSchema, reviewBindings, reviewSpanSchema,
  reviewNoteSchema, fullReviewSpan, validateReviewSpan, type ReviewSpan } from './source-review.js';

const note = reviewNoteSchema;
const anchors = z.array(reviewSpanSchema).min(1).max(100);
export const answerReviewSchema = z.object({
  schemaVersion: z.literal('1.0.0'), methodVersion: z.literal(HUMANIER_METHOD_VERSION),
  bindings: reviewBindingsSchema, reviewerRole: z.literal('agent'),
  response: z.object({
    status: z.enum(['answered', 'unanswered', 'rework']), promptInterpretation: note,
    readerTakeaway: note, anchors, reason: note
  }).strict(),
  relations: z.array(z.object({
    from: reviewSpanSchema, to: reviewSpanSchema,
    type: z.enum(['chronology', 'cause', 'comparison', 'support', 'plan']),
    status: z.enum(['supported', 'missing-condition', 'overreach', 'rework']), reason: note
  }).strict()).max(200),
  relationsReason: note,
  conclusions: z.array(z.object({
    anchor: reviewSpanSchema, type: z.enum(['observation', 'feeling', 'plan', 'inference']),
    scope: note, status: z.enum(['proportionate', 'overreach', 'rework']), reason: note
  }).strict()).max(200),
  conclusionsReason: note,
  selection: z.object({ status: z.enum(['relevant', 'padding', 'rework']), anchors, reason: note }).strict(),
  standaloneRead: z.object({
    status: z.enum(['clear', 'unresolved', 'rework']), anchors, reason: note,
    questions: z.array(z.object({ anchor: reviewSpanSchema, question: note,
      status: z.enum(['resolved', 'unresolved']), reason: note }).strict()).max(100)
  }).strict(),
  projectRoles: z.object({
    status: z.enum(['clear', 'unresolved', 'rework']), reason: note,
    entries: z.array(z.object({ anchor: reviewSpanSchema,
      actor: z.enum(['self', 'teacher', 'tool', 'other']), contribution: note }).strict()).min(1).max(100)
  }).strict().optional(),
  recommendation: z.enum(['adopt', 'rework'])
}).strict();

export async function prepareAnswerReview(policyRoot: string, path: string) {
  const s = await loadSession(policyRoot, path);
  const documentAnchors = s.document.blocks.filter(block => block.text.trim()).map(fullReviewSpan);
  return {
    schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings: reviewBindings(s),
    instructions: [
      'Read the current prepare, prompt and source before editing. Diagnose the whole answer first and repeat this review after revision.',
      'Explain what this prompt asks and what the reader learns about the author. Anchor judgments to exact current text using Unicode codepoint offsets.',
      'Identify the key relationships as chronology, cause, comparison, support or plan. Mark missing conditions and overreach explicitly. A sequence need not be a causal growth story.',
      'Classify conclusions as observation, feeling, plan or inference and explain their supported scope. A subjective feeling need not become an objective ability claim.',
      'Explain why the selected material serves this answer. A sourced sentence can still need removal. Source Review separately checks passage and omission coverage.',
      'Read the answer without the editing justifications. Record remaining reader questions and whether the text resolves them. If relevant, distinguish the author, teacher and tool contributions.',
      'Use the array-level reasons to explain selection and genuine absence of key relations or conclusions. Empty notes are invalid. Do not invent material to fill this template.',
      'Save the completed record outside immutable version folders. The program verifies bindings, references and explicit states only. It cannot certify meaning, voice, independent reading, detector results or submission approval.'
    ],
    context: s.manifest.context, document: s.document,
    template: {
      schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings: reviewBindings(s), reviewerRole: 'agent',
      response: { status: 'unanswered', promptInterpretation: '', readerTakeaway: '', anchors: documentAnchors, reason: '' },
      relations: [], relationsReason: '', conclusions: [], conclusionsReason: '',
      selection: { status: 'rework', anchors: documentAnchors, reason: '' },
      standaloneRead: { status: 'unresolved', anchors: documentAnchors, reason: '', questions: [] },
      recommendation: 'rework'
    },
    containsDocumentText: true, requiresHumanReview: true, deliveryAuthorized: false
  };
}

export async function reviewAnswer(policyRoot: string, path: string, raw: unknown) {
  const s = await loadSession(policyRoot, path);
  const record = answerReviewSchema.parse(raw);
  if (hashValue(record.bindings) !== hashValue(reviewBindings(s)))
    fail('answer-review-stale', 'Prepare an answer review for the current original, version, context and policy.');

  let referenceCount = 0;
  const check = (span: ReviewSpan) => {
    validateReviewSpan(span, s.document.blocks, 'answer-review-span');
    if (!span.quote.trim()) fail('answer-review-span', 'Reference substantive current text.');
    referenceCount++;
  };
  record.response.anchors.forEach(check);
  for (const relation of record.relations) { check(relation.from); check(relation.to); }
  record.conclusions.forEach(conclusion => check(conclusion.anchor));
  record.selection.anchors.forEach(check);
  record.standaloneRead.anchors.forEach(check);
  record.standaloneRead.questions.forEach(question => check(question.anchor));
  record.projectRoles?.entries.forEach(entry => check(entry.anchor));

  const rework = {
    response: record.response.status !== 'answered',
    relations: record.relations.flatMap((relation, index) => relation.status !== 'supported' ? [index + 1] : []),
    conclusions: record.conclusions.flatMap((conclusion, index) => conclusion.status !== 'proportionate' ? [index + 1] : []),
    selection: record.selection.status !== 'relevant',
    standaloneRead: record.standaloneRead.status !== 'clear',
    unresolvedQuestions: record.standaloneRead.questions.flatMap((question, index) => question.status === 'unresolved' ? [index + 1] : []),
    projectRoles: record.projectRoles !== undefined && record.projectRoles.status !== 'clear',
    recommendation: record.recommendation !== 'adopt'
  };
  const needsRework = Object.values(rework).some(value => Array.isArray(value) ? value.length > 0 : value);
  return {
    schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings: reviewBindings(s), recordHash: hashValue(record),
    reviewDecision: needsRework ? 'needs-rework' : 'recorded', rework, referencesVerified: true, referenceCount,
    relationCount: record.relations.length, conclusionCount: record.conclusions.length,
    questionCount: record.standaloneRead.questions.length, projectRoleCount: record.projectRoles?.entries.length ?? 0,
    reviewerRole: 'agent', containsDocumentText: false, requiresHumanReview: true,
    semanticEquivalenceChecked: false, voiceCertified: false, reasoningCertified: false,
    independentReaderVerified: false, deliveryAuthorized: false
  };
}
