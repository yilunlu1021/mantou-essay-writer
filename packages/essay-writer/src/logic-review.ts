import { z } from 'zod';
import { hashValue } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { fail } from './files.js';
import { reviewBindings, reviewBindingsSchema, reviewSpanSchema, validateReviewSpan, type ReviewSpan } from './source-review.js';
import { logicalParagraphAnchors } from './style-review.js';

export const LOGIC_REVIEW_ENGINE = 'writing-logic-review@1' as const;
const text = z.string().trim().max(4000);
const span = reviewSpanSchema;
const judgment = z.enum(['clear', 'issue', 'unverified']);
const promptSpan = z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), quote: z.string().max(40000) }).strict();
const overallCheck = z.object({ status: judgment, reason: text, anchors: z.array(span).max(100) }).strict();
export const logicReviewSchema = z.object({
  schemaVersion: z.literal(LOGIC_REVIEW_ENGINE), bindings: reviewBindingsSchema,
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewer: z.object({ id: text, participatedInEditing: z.boolean(), independence: z.enum(['same-editor', 'separate-pass', 'independent-reader', 'unknown']) }).strict(),
  centralAnswer: text,
  requirements: z.array(z.object({ id: z.string().min(1), promptSpan, requirement: text,
    status: z.enum(['answered', 'partial', 'unanswered', 'unverified', 'not-applicable']),
    answerAnchors: z.array(span).max(100), reason: text }).strict()).max(200),
  paragraphs: z.array(z.object({ anchor: span, requirementIds: z.array(z.string()).max(200),
    role: z.enum(['context', 'event', 'judgment', 'response', 'consequence', 'plan']),
    contribution: text, status: z.enum(['supports-answer', 'material-pile', 'off-topic', 'unverified']),
    claimCoverageReason: text,
    claims: z.array(z.object({ anchor: span, kind: z.enum(['observation', 'feeling', 'inference', 'plan']),
      evidence: z.array(span).max(100), warrant: text, counterReading: text, scopeLimit: text,
      status: z.enum(['supported', 'unsupported', 'contradicted', 'unverified']) }).strict()).max(100),
    reason: text
  }).strict()).max(5000),
  bridges: z.array(z.object({ from: span, to: span,
    relation: z.enum(['chronology', 'cause', 'comparison', 'contrast', 'elaboration', 'continuation', 'plan']),
    fromPremise: text, whyFollows: text, addedConsequence: text, missingPremise: text,
    status: z.enum(['supported', 'missing-premise', 'forced-link', 'unverified'])
  }).strict()).max(5000),
  overall: z.object({ makesSense: overallCheck, convincing: overallCheck, answersPrompt: overallCheck,
    skepticalReading: text,
    questions: z.array(z.object({ question: text, anchor: span, material: z.boolean(), resolved: z.boolean(), reason: text }).strict()).max(200)
  }).strict(),
  recommendation: z.enum(['adopt', 'rework'])
}).strict();

function catalog(context: { prompt: string }, document: Parameters<typeof logicalParagraphAnchors>[0]) {
  const paragraphs = logicalParagraphAnchors(document);
  const bridges = paragraphs.slice(1).map((to, i) => ({ from: paragraphs[i]!, to }));
  const prompt = { start: 0, end: Array.from(context.prompt).length, quote: context.prompt };
  return { paragraphs, bridges, prompt, hash: hashValue({ engine: LOGIC_REVIEW_ENGINE, paragraphs, bridges, prompt }) };
}

export async function prepareLogicReview(policyRoot: string, path: string) {
  const s = await loadSession(policyRoot, path), c = catalog(s.manifest.context, s.document);
  return {
    schemaVersion: LOGIC_REVIEW_ENGINE, bindings: reviewBindings(s), catalogHash: c.hash,
    context: s.manifest.context, document: s.document, original: s.original,
    paragraphs: c.paragraphs, bridges: c.bridges,
    instructions: [
      'Read the exact question and current text independently of earlier scores and editing justifications. State a direct central answer before language polishing.',
      'Split the actual prompt into requirements with exact prompt spans and answer anchors. Cover the full prompt; conditions or optional parts need explicit grounds, not silent omission.',
      'Cover every logical paragraph and adjacent paragraph bridge in order. Explain its contribution to the answer, the starting premise, why the next step follows and what it adds. A chronology or stable relationship can be valid without a growth arc.',
      'Inspect every consequential claim: distinguish observation, feeling, inference and plan; quote current evidence, explain its warrant, strongest reasonable counter-reading and scope. Do not add boilerplate warrants to the essay itself.',
      'Evidence, more material, a shared keyword or a transition word does not establish a convincing argument. Missing conditions, a forced link, off-topic material or unanswered questions require rework.',
      'Do not require each feeling to prove an ability or lead to a new action. A source-supported feeling or concrete negotiated agreement may answer the question.',
      'Separate makesSense, convincing and answersPrompt. If material gaps remain, relevant 0-5 logic criteria cannot earn 4 or 5; this is not a new total score or a cap on unrelated strengths.',
      'These are reviewer declarations. The tool validates exact coverage, bindings and explicit gaps, not semantic truth, exhaustive claim discovery, independent reading or human approval. Keep raw records outside immutable version directories.'
    ],
    template: { schemaVersion: LOGIC_REVIEW_ENGINE, bindings: reviewBindings(s), catalogHash: c.hash,
      reviewer: { id: '', participatedInEditing: false, independence: 'unknown' }, centralAnswer: '',
      requirements: c.prompt.quote.trim() ? [{ id: 'q1', promptSpan: c.prompt, requirement: '', status: 'unverified', answerAnchors: [], reason: '' }] : [],
      paragraphs: c.paragraphs.map(anchor => ({ anchor, requirementIds: [], role: 'context', contribution: '', status: 'unverified',
        claimCoverageReason: '', claims: [], reason: '' })),
      bridges: c.bridges.map(pair => ({ ...pair, relation: 'continuation', fromPremise: '', whyFollows: '', addedConsequence: '', missingPremise: '', status: 'unverified' })),
      overall: { makesSense: { status: 'unverified', reason: '', anchors: [] }, convincing: { status: 'unverified', reason: '', anchors: [] },
        answersPrompt: { status: 'unverified', reason: '', anchors: [] }, skepticalReading: '', questions: [] }, recommendation: 'rework' },
    containsDocumentText: true, requiresHumanReview: true, reasoningCertified: false, deliveryAuthorized: false
  };
}

export async function reviewLogic(policyRoot: string, path: string, raw: unknown) {
  const s = await loadSession(policyRoot, path), r = logicReviewSchema.parse(raw), c = catalog(s.manifest.context, s.document);
  if (hashValue(r.bindings) !== hashValue(reviewBindings(s)) || r.catalogHash !== c.hash)
    fail('logic-review-stale', 'Prepare for the current question, source, document, policy and engine.');
  const failures: { id: string; code: string }[] = [], pending: { id: string; code: string }[] = [];
  const stop = (id: string, code: string) => failures.push({ id, code });
  const wait = (id: string, code: string) => pending.push({ id, code });
  const check = (a: ReviewSpan) => {
    validateReviewSpan(a, s.document.blocks, 'logic-review-span');
    if (!a.quote.trim()) fail('logic-review-span', 'Use substantive current essay evidence.');
  };
  if (!r.reviewer.id || !r.centralAnswer) wait('whole', 'missing-reader-or-central-answer');
  if (r.reviewer.independence === 'unknown') wait('whole', 'reader-process-unverified');
  if (r.reviewer.participatedInEditing && r.reviewer.independence === 'independent-reader')
    fail('logic-review-reader', 'An editor may record a separate pass, not declare an independent reader.');
  if (!s.manifest.context.prompt.trim()) wait('prompt', 'actual-prompt-missing');
  const promptChars = Array.from(s.manifest.context.prompt), coverage = new Uint8Array(promptChars.length);
  const ids = new Set<string>();
  for (const q of r.requirements) {
    if (ids.has(q.id)) fail('logic-review-prompt-coverage', 'Use unique prompt requirement IDs.');
    ids.add(q.id);
    const a = q.promptSpan;
    if (a.end <= a.start || a.end > promptChars.length || promptChars.slice(a.start, a.end).join('') !== a.quote || !a.quote.trim())
      fail('logic-review-prompt-span', 'Use exact, nonempty codepoint spans from the actual prompt.');
    for (let i = a.start; i < a.end; i++) coverage[i] = 1;
    q.answerAnchors.forEach(check);
    if (!q.requirement || !q.reason || q.status === 'unverified') wait(q.id, 'prompt-requirement-unverified');
    if (q.status === 'answered' && !q.answerAnchors.length) wait(q.id, 'answer-evidence-missing');
    if (q.status === 'partial' || q.status === 'unanswered') stop(q.id, 'prompt-not-answered');
  }
  if (promptChars.some((ch, i) => /\S/u.test(ch) && !coverage[i])) fail('logic-review-prompt-coverage', 'Account for the complete actual prompt.');
  if (!r.requirements.some(q => q.status !== 'not-applicable')) wait('prompt', 'actual-answer-requirement-missing');
  if (r.paragraphs.length !== c.paragraphs.length || r.paragraphs.some((p, i) => hashValue(p.anchor) !== hashValue(c.paragraphs[i])))
    fail('logic-review-paragraph-coverage', 'Cover every complete logical paragraph once in the current order.');
  r.paragraphs.forEach((p, i) => {
    check(p.anchor); const id = `paragraph-${i + 1}`;
    if (new Set(p.requirementIds).size !== p.requirementIds.length || p.requirementIds.some(id => !ids.has(id)))
      fail('logic-review-requirement-link', 'Reference unique declared prompt requirement IDs.');
    if (!p.requirementIds.length || !p.contribution || !p.reason || !p.claimCoverageReason || p.status === 'unverified') wait(id, 'paragraph-unverified');
    if (p.status === 'material-pile' || p.status === 'off-topic') stop(id, p.status);
    for (const claim of p.claims) {
      check(claim.anchor); claim.evidence.forEach(check);
      if (claim.anchor.blockId !== p.anchor.blockId || claim.anchor.start < p.anchor.start || claim.anchor.end > p.anchor.end)
        fail('logic-review-claim-scope', 'Place a claim in the paragraph being reviewed.');
      if (!claim.warrant || !claim.counterReading || !claim.scopeLimit || !claim.evidence.length || claim.status === 'unverified') wait(id, 'claim-unverified');
      if (claim.status === 'unsupported' || claim.status === 'contradicted') stop(id, `claim-${claim.status}`);
    }
  });
  if (r.bridges.length !== c.bridges.length || r.bridges.some((b, i) =>
    hashValue({ from: b.from, to: b.to }) !== hashValue(c.bridges[i])))
    fail('logic-review-bridge-coverage', 'Review every adjacent logical paragraph bridge in order.');
  r.bridges.forEach((b, i) => {
    check(b.from); check(b.to); const id = `bridge-${i + 1}`;
    if (!b.fromPremise || !b.whyFollows || !b.addedConsequence || b.status === 'unverified') wait(id, 'bridge-unverified');
    if (b.status === 'missing-premise' || b.status === 'forced-link' || b.missingPremise.trim()) stop(id, 'bridge-missing-or-forced');
  });
  for (const key of ['makesSense', 'convincing', 'answersPrompt'] as const) {
    const item = r.overall[key]; item.anchors.forEach(check);
    if (!item.reason || !item.anchors.length || item.status === 'unverified') wait(key, 'overall-unverified');
    if (item.status === 'issue') stop(key, 'overall-issue');
  }
  if (!r.overall.skepticalReading) wait('whole', 'skeptical-reading-missing');
  for (const [i, q] of r.overall.questions.entries()) {
    check(q.anchor);
    if (!q.question || !q.reason) wait(`question-${i + 1}`, 'question-unverified');
    if (q.material && !q.resolved) stop(`question-${i + 1}`, 'material-reader-question');
  }
  if (r.recommendation === 'rework') stop('whole', 'reviewer-rework');
  return { schemaVersion: LOGIC_REVIEW_ENGINE, bindings: reviewBindings(s), catalogHash: c.hash, recordHash: hashValue(r),
    reviewDecision: failures.length ? 'needs-rework' : pending.length ? 'needs-review' : 'recorded',
    failures, pending, paragraphCount: r.paragraphs.length, bridgeCount: r.bridges.length, promptRequirementCount: r.requirements.length,
    relevantLogicScoreCeiling: failures.some(item => item.code !== 'reviewer-rework') ? 3 : null, scoreScale: 'related 0-5 criteria only; no total score assigned',
    coverageVerified: true, claimCoverageCertified: false, reasoningCertified: false, independentReaderVerified: false,
    containsDocumentText: false, requiresHumanReview: true, deliveryAuthorized: false };
}
