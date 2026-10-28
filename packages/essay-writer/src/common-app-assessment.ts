import { z } from 'zod';
import { countText, hashValue } from '@mantou/text-quality';
import { COMMON_APP_V2_ITEMS } from './common-app-v2-rubric-data.js';
import { COMMON_APP_V2_PROTOCOL } from './common-app-v2-protocol-data.js';
import { loadSession } from './sessions.js';
import { fail } from './files.js';
import { reviewBindings, reviewNoteSchema as note, reviewSpanSchema, validateReviewSpan } from './source-review.js';
import { benchmarkProfileSchema } from './benchmark-review.js';
import { prepareAssessmentReview, reviewAssessment } from './assessment-review.js';
import { logicalParagraphAnchors } from './style-review.js';

export const COMMON_APP_ASSESSMENT_VERSION = 'judgment-evidence-assessment@3' as const;
export const COMMON_APP_RUBRIC_VERSION = 'judgment-evidence-95plus5-2.1' as const;
export const COMMON_APP_QUALITY_FLOOR = 83;
export const COMMON_APP_CRITICAL_ITEMS = Object.freeze(['P1.3', 'P1.5', 'C2.2', 'C2.3', 'C2.4', 'E3.1', 'E3.2', 'E3.3', 'E3.5', 'N4.1'] as const);
// The exported data module and returned catalogs must not share the live rules.
const COMMON_APP_ITEMS = structuredClone(COMMON_APP_V2_ITEMS);
const scoringInstructions = [
  'Read the frozen prompt and whole current text before grading. Record personal judgment, causal reconstruction, actual actions and unresolved first-reader questions. Do not fit a prior score or target.',
  'Score 19 main items and one holistic extra item independently. Main maximum 95 plus holistic extra maximum 5 equals 100. Never add route-specific bonuses or normalize null items.',
  'For each 5 justify positive completion, the strongest contrary reading, and why the specific evidence exceeds band 4. No observed error is not sufficient positive proof.',
  'Distinguish narrative change from an actual departure from the reader expectation immediately before the event. Repeated literal actions are not automatically symbolism. Activity category lists do not establish relative rarity.',
  'An effective extra route must add a specific understanding beyond the main criteria. Plain, ordinary and stable-character stories may earn all 95 main points without conflict, growth, rarity or ornament.',
  'The fixed student quality floor is 83 and all prepared critical items require at least 4. Three critical checks and all material issues also gate student review. An advisor target cannot lower the floor.',
  'Keep student review, human acceptance, source truth, author confirmation, final submission, length and detector evidence separate. Record editing participation and authorized reconstruction honestly.',
  'Before item scoring, complete storyDiagnosis for every exact logical paragraph. Distinguish clear actions from sufficient personal understanding. Repeating the same level of growth through different actions is a material selection problem until resolved.',
  'Explain the personal stakes, the real test of a changed or stable position, and the actual role of a turn. Single experiences, stable character and no reader surprise can be sufficient. Multiple experiences or unexpected events are never required.',
] as const;
const readinessIds = ['prompt', 'source', 'authorship', 'professionalism', 'edit-authority', 'length-mechanics', 'student-final-review'] as const;
const itemIds = COMMON_APP_ITEMS.map(item => item.id);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object({ title: note, url: z.url().refine(url => new URL(url).protocol === 'https:'), checkedAt: z.iso.date(), values: note }).strict();
const status = z.enum(['clear', 'issue', 'unverified']);
const criticalCheckIds = ['causal-chain', 'action-evidence', 'first-read'] as const;
const fullMarkTest = z.object({ positiveProof: note, counterReading: note, whyFourInsufficient: note }).strict();
const contribution = { contribution: note };
const storyDiagnosisSchema = z.object({
  scope: z.enum(['single-experience', 'linked-experiences']), personalStakes: note,
  paragraphProgression: z.array(z.object({ anchor: reviewSpanSchema, function: note, addedUnderstanding: note,
    status: z.enum(['distinct', 'necessary-context', 'repeats', 'unresolved']), reason: note }).strict()).min(1).max(5000),
  development: z.object({ kind: z.enum(['change', 'stable-character']), initialPosition: note,
    testEvidence: z.array(reviewSpanSchema).min(1).max(100), responseAndScope: note,
    status: z.enum(['supported', 'needs-rework', 'unverified']) }).strict(),
  turn: z.object({ kind: z.enum(['reader-expectation', 'self-expectation', 'relationship-development', 'none']),
    setup: note, actual: note, contribution: note, anchors: z.array(reviewSpanSchema).max(100) }).strict(),
  verdict: z.enum(['sufficient', 'needs-rework', 'unverified']), reason: note,
}).strict();
const bonusBasis = z.discriminatedUnion('route', [
  z.object({ route: z.literal('none'), finding: note }).strict(),
  z.object({ route: z.literal('unassessed'), reason: note }).strict(),
  z.object({ route: z.literal('symbol'), carrier: note, correspondence: note, ...contribution }).strict(),
  z.object({ route: z.literal('expectation'), expected: note, establishedBy: z.array(reviewSpanSchema).min(1), actual: note, ...contribution }).strict(),
  z.object({ route: z.literal('insight'), observation: note, inference: note, ...contribution }).strict(),
  z.object({ route: z.literal('relative-experience'), reference: source, commonPath: note, difference: note, comparisonLimits: note, ...contribution }).strict(),
  z.object({ route: z.literal('value-practice'), value: note, choice: note, method: note, consequence: note, ...contribution }).strict(),
]);

export function getCommonAppBenchmark() {
  const rubric = structuredClone({ version: COMMON_APP_RUBRIC_VERSION, sourceUrl: 'docs/benchmarks/common-app-judgment-evidence-v2.md',
    createdAt: '2026-10-25', status: 'project-adopted-real-calibration-pending', items: COMMON_APP_ITEMS,
    protocolVersion: 'judgment-evidence-protocol-2.1', protocolSections: [COMMON_APP_V2_PROTOCOL],
    instructions: scoringInstructions, baseMax: 95, bonusRawMax: 5, bonusCap: 5, totalMax: 100,
    qualityFloor: COMMON_APP_QUALITY_FLOOR, criticalItems: COMMON_APP_CRITICAL_ITEMS, criticalMinimum: 4,
    arithmetic: 'Sum 19 main integer scores and one holistic extra integer score. Any unrated item leaves the full total null. No normalization or route stacking.',
    language: 'Text voice and precision are V5.1/V5.2. Source truth, author identity, detector outputs and submission responsibility remain separate.',
    applicability: 'Common App and similar personal narratives. Other essay types retain their versioned rubric until separately updated.' });
  return { ...rubric, rubricHash: hashValue(rubric), assessmentVersion: COMMON_APP_ASSESSMENT_VERSION };
}

export const commonAppAssessmentSchema = z.object({
  schemaVersion: z.literal(COMMON_APP_ASSESSMENT_VERSION), rubricVersion: z.literal(COMMON_APP_RUBRIC_VERSION), rubricHash: digest,
  bindings: z.object({ sessionHash: digest, versionHash: digest, originalHash: digest, documentHash: digest, contextHash: digest, policyHash: digest }).strict(),
  profile: z.object({ essayType: z.literal('common-app'), promptStatus: z.enum(['supplied', 'unselected', 'missing']) }).strict(),
  reviewer: z.object({ id: note, role: z.enum(['agent', 'advisor']), participatedInEditing: z.boolean() }).strict(),
  reading: z.object({ task: note, personUnderstood: note, causalChain: note, keyActions: note,
    questions: z.array(z.object({ question: note, material: z.boolean() }).strict()).max(40),
    evidenceLimits: note, presentationVsContent: note, anchors: z.array(reviewSpanSchema).min(1).max(100) }).strict(),
  storyDiagnosis: storyDiagnosisSchema,
  items: z.array(z.object({ id: z.string().min(1), score: z.number().int().min(0).max(5).nullable(),
    anchors: z.array(reviewSpanSchema).max(100), bandReason: note, nextBandCondition: note, limitation: note,
    unratedReason: z.string().max(4000), absenceReason: z.string().max(4000), fullMarkTest: fullMarkTest.nullable() }).strict()).length(20),
  bonusBasis,
  criticalChecks: z.array(z.object({ id: z.enum(criticalCheckIds), status: z.enum(['clear', 'needs-rework', 'unverified']),
    reason: note, anchors: z.array(reviewSpanSchema).min(1).max(100) }).strict()).length(3),
  issues: z.array(z.object({ id: note, itemIds: z.array(z.string().min(1)).min(1).max(20), description: note,
    anchors: z.array(reviewSpanSchema).min(1).max(100), severity: z.enum(['optional', 'material']),
    decision: z.enum(['retain-with-reason', 'revise', 'needs-source']), reason: note }).strict()).max(100),
  target: z.object({ school: z.object({ name: note, status: z.enum(['confirmed', 'unverified']), sourceRef: note }).strict().nullable(),
    minimumScore100: z.number().int().min(0).max(100).nullable(), rationale: note }).strict(),
  acceptance: z.object({ decision: z.enum(['proposed', 'accepted', 'declined']), byRole: z.enum(['agent', 'advisor', 'business-owner']),
    sourceRef: note, acceptedIssueIds: z.array(note).max(100) }).strict(),
  readiness: z.array(z.object({ checkId: z.enum(readinessIds), status, reason: note, sourceRef: note }).strict()).length(readinessIds.length)
}).strict();
export type CommonAppAssessment = z.infer<typeof commonAppAssessmentSchema>;

export async function prepareCommonAppAssessment(policyRoot: string, path: string, rawProfile: unknown) {
  const profile = benchmarkProfileSchema.parse(rawProfile);
  if (profile.essayType !== 'common-app') fail('assessment-profile', 'Use this rubric only for Common App or explicitly identified personal narratives.');
  const s = await loadSession(policyRoot, path), rubric = getCommonAppBenchmark();
  if (profile.promptStatus === 'supplied' && !s.manifest.context.prompt.trim()) fail('assessment-prompt', 'Supply the actual prompt or mark it missing/unselected.');
  return { schemaVersion: COMMON_APP_ASSESSMENT_VERSION, rubricVersion: rubric.version, rubricHash: rubric.rubricHash,
    bindings: reviewBindings(s), rubric, context: s.manifest.context, document: s.document, original: s.original,
    instructions: rubric.instructions,
    template: { schemaVersion: COMMON_APP_ASSESSMENT_VERSION, rubricVersion: rubric.version, rubricHash: rubric.rubricHash,
      bindings: reviewBindings(s), profile: { essayType: 'common-app', promptStatus: profile.promptStatus },
      reviewer: { id: '', role: 'agent', participatedInEditing: false }, reading: { task: '', personUnderstood: '', causalChain: '', keyActions: '', questions: [], evidenceLimits: '', presentationVsContent: '', anchors: [] },
      storyDiagnosis: { scope: 'single-experience', personalStakes: '',
        paragraphProgression: logicalParagraphAnchors(s.document).map(anchor => ({ anchor, function: '', addedUnderstanding: '', status: 'unresolved', reason: '' })),
        development: { kind: 'change', initialPosition: '', testEvidence: [], responseAndScope: '', status: 'unverified' },
        turn: { kind: 'none', setup: '', actual: '', contribution: '', anchors: [] }, verdict: 'unverified', reason: '' },
      items: COMMON_APP_ITEMS.map(item => ({ id: item.id, score: null, anchors: [], bandReason: '', nextBandCondition: '', limitation: '', unratedReason: '', absenceReason: '', fullMarkTest: null })),
      bonusBasis: { route: 'unassessed', reason: '' }, criticalChecks: criticalCheckIds.map(id => ({ id, status: 'unverified', reason: '', anchors: [] })),
      issues: [], target: { school: null, minimumScore100: COMMON_APP_QUALITY_FLOOR, rationale: '' },
      acceptance: { decision: 'proposed', byRole: 'agent', sourceRef: '', acceptedIssueIds: [] },
      readiness: readinessIds.map(checkId => ({ checkId, status: 'unverified', reason: '', sourceRef: '' })) },
    containsDocumentText: true, requiresHumanReview: true, automaticRewrite: false, submissionAuthorized: false };
}

export async function reviewCommonAppAssessment(policyRoot: string, path: string, raw: unknown) {
  const r = commonAppAssessmentSchema.parse(raw), s = await loadSession(policyRoot, path), rubric = getCommonAppBenchmark();
  if (r.rubricHash !== rubric.rubricHash || hashValue(r.bindings) !== hashValue(reviewBindings(s)))
    fail('assessment-stale', 'Prepare the current rubric for the actual session and version. Historical records are not converted.');
  if (r.profile.promptStatus === 'supplied' && !s.manifest.context.prompt.trim()) fail('assessment-prompt', 'The supplied prompt must exist.');
  const checkSpan = (a: z.infer<typeof reviewSpanSchema>) => {
    if (!a.quote.trim()) fail('assessment-span', 'Use non-whitespace current essay evidence.');
    return validateReviewSpan(a, s.document.blocks, 'assessment-span');
  };
  r.reading.anchors.forEach(checkSpan);
  const paragraphs = logicalParagraphAnchors(s.document), diagnosis = r.storyDiagnosis;
  if (diagnosis.paragraphProgression.length !== paragraphs.length || diagnosis.paragraphProgression.some((p, index) => hashValue(p.anchor) !== hashValue(paragraphs[index])))
    fail('assessment-story-coverage', 'Review every complete logical paragraph exactly once in the prepared order.');
  diagnosis.paragraphProgression.forEach(p => checkSpan(p.anchor));
  diagnosis.development.testEvidence.forEach(checkSpan);
  diagnosis.turn.anchors.forEach(checkSpan);
  if (diagnosis.turn.kind !== 'none' && !diagnosis.turn.anchors.length)
    fail('assessment-story-turn', 'A claimed turn requires current text evidence. No turn is a valid explicit choice.');
  for (const [index, item] of r.items.entries()) {
    const rule = COMMON_APP_ITEMS[index]!;
    if (item.id !== rule.id || (item.score !== null && item.score > rule.max)) fail('assessment-item', 'Use each prepared item once, in order, within its integer maximum.');
    item.anchors.forEach(checkSpan);
    if (item.score === null && !item.unratedReason.trim()) fail('assessment-unrated', 'State why this item is unrated.');
    if (item.score !== null && item.unratedReason.trim()) fail('assessment-unrated', 'A rated zero is not an unrated item.');
    if (item.score !== null && item.score > 0 && item.anchors.length === 0) fail('assessment-evidence', 'Positive scores require exact current essay evidence.');
    if (item.score === 0 && !item.anchors.length && !item.absenceReason.trim()) fail('assessment-evidence', 'Explain the observed absence for a zero without a quote.');
    if ((item.score === 5) !== (item.fullMarkTest !== null)) fail('assessment-full-mark', 'Every and only a maximum score needs positive proof, counter-reading and a band-4 comparison.');
  }
  const byId = new Map(r.items.map(item => [item.id, item]));
  const bonus = byId.get('X6.1')!;
  if ((bonus.score === null) !== (r.bonusBasis.route === 'unassessed')) fail('assessment-bonus-basis', 'An unassessed extra needs its explicit missing basis.');
  if (bonus.score === 0 && r.bonusBasis.route !== 'none') fail('assessment-bonus-basis', 'An absent effective extra is recorded as none, not a positive route.');
  if (bonus.score !== null && bonus.score > 0 && ['none', 'unassessed'].includes(r.bonusBasis.route)) fail('assessment-bonus-basis', 'A positive holistic extra needs one supported route.');
  if (diagnosis.turn.kind === 'none' && r.bonusBasis.route === 'expectation')
    fail('assessment-story-turn', 'An expectation bonus requires a declared turn. No-turn stories can use other supported extra routes.');
  if (r.bonusBasis.route === 'expectation') r.bonusBasis.establishedBy.forEach(checkSpan);
  r.criticalChecks.forEach((check, i) => { if (check.id !== criticalCheckIds[i]) fail('assessment-critical-check', 'Complete the fixed checks in prepared order.'); check.anchors.forEach(checkSpan); });
  const issueIds = new Set<string>();
  for (const issue of r.issues) {
    if (issueIds.has(issue.id) || new Set(issue.itemIds).size !== issue.itemIds.length || issue.itemIds.some(id => !itemIds.includes(id as typeof itemIds[number])))
      fail('assessment-issue', 'Use unique issues and declared criterion IDs.');
    issueIds.add(issue.id); issue.anchors.forEach(checkSpan);
  }
  if (r.acceptance.decision === 'accepted' && r.acceptance.byRole === 'agent') fail('assessment-acceptance', 'The scoring agent cannot supply human acceptance.');
  const accepted = new Set(r.acceptance.acceptedIssueIds);
  if (accepted.size !== r.acceptance.acceptedIssueIds.length || [...accepted].some(id => !issueIds.has(id))) fail('assessment-acceptance', 'Accept only unique declared issues.');
  for (const issue of r.issues) if (accepted.has(issue.id) && (issue.severity !== 'optional' || issue.decision !== 'retain-with-reason'))
    fail('assessment-acceptance', 'Material gaps cannot be accepted away.');
  r.readiness.forEach((check, i) => { if (check.checkId !== readinessIds[i]) fail('assessment-readiness', 'Use all separate checks in prepared order.'); });
  if (r.profile.promptStatus !== 'supplied' && r.readiness[0]!.status === 'clear') fail('assessment-readiness', 'A missing or unselected actual prompt is not clear.');
  const words = countText(s.document.blocks.map(b => b.text).join('\n\n')).englishWords;
  const mechanical = await import('./sessions.js').then(module => module.auditSession(policyRoot, path));
  if (r.readiness.find(c => c.checkId === 'length-mechanics')!.status === 'clear' && (words < 635 || words > 650 || mechanical.qualityDecision === 'blocked'))
    fail('assessment-readiness', 'A clear length/mechanics check requires 635–650 words and no mechanical blocker.');
  const sum = (items: typeof r.items) => items.some(item => item.score === null) ? null : items.reduce((total, item) => total + item.score!, 0);
  const base = sum(r.items.slice(0, 19)), bonusRaw = bonus.score, bonusCounted = bonusRaw;
  const total = base === null || bonusCounted === null ? null : Math.min(rubric.totalMax, base + bonusCounted);
  const groups = Object.fromEntries(['P1', 'C2', 'E3', 'N4', 'V5', 'X6'].map(group => [group, sum(r.items.filter(item => item.id.startsWith(group + '.')))]));
  const effectiveTarget = Math.max(COMMON_APP_QUALITY_FLOOR, r.target.minimumScore100 ?? COMMON_APP_QUALITY_FLOOR);
  const targetMet = total !== null && total >= effectiveTarget;
  const pendingReadiness = r.readiness.filter(check => check.status !== 'clear').map(check => check.checkId);
  const material = r.issues.filter(issue => issue.severity === 'material' || issue.decision !== 'retain-with-reason');
  const unaccepted = r.issues.filter(issue => !accepted.has(issue.id));
  const criticalFailures = COMMON_APP_CRITICAL_ITEMS.filter(id => byId.get(id)!.score === null || byId.get(id)!.score! < 4);
  const qualityBlockers = [
    ...(diagnosis.verdict !== 'sufficient' ? ['story-selection-not-sufficient'] : []),
    ...(diagnosis.development.status !== 'supported' ? ['story-development-not-supported'] : []),
    ...diagnosis.paragraphProgression.flatMap((p, index) => ['repeats', 'unresolved'].includes(p.status) ? [`story-paragraph-${index + 1}-${p.status}`] : []),
    ...(total === null ? ['incomplete-assessment'] : total < COMMON_APP_QUALITY_FLOOR ? ['below-quality-floor-83'] : []),
    ...criticalFailures.map(id => `critical-item-${id}`),
    ...r.criticalChecks.filter(c => c.status !== 'clear').map(c => `critical-check-${c.id}`),
    ...(r.reading.questions.some(q => q.material) ? ['material-reader-question'] : []),
    ...material.map(issue => `material-issue-${issue.id}`),
  ];
  const qualityPassed = qualityBlockers.length === 0;
  const studentReviewBlockers = [...qualityBlockers,
    ...(words < 635 || words > 650 || mechanical.qualityDecision === 'blocked' ? ['length-or-mechanics'] : []),
    ...r.readiness.filter(c => c.status === 'issue' && c.checkId !== 'student-final-review').map(c => `readiness-${c.checkId}`),
  ];
  const contentAccepted = qualityPassed && targetMet && r.acceptance.decision === 'accepted' && !material.length && !unaccepted.length && !r.readiness.some(check => check.status === 'issue');
  const targetConfirmed = r.target.school?.status === 'confirmed';
  return { schemaVersion: COMMON_APP_ASSESSMENT_VERSION, rubricVersion: rubric.version, rubricHash: rubric.rubricHash,
    bindings: r.bindings, recordHash: hashValue(r), score: { base, bonusRaw, bonusCounted, total, groups,
      assessedItems: r.items.filter(item => item.score !== null).length, unratedItems: r.items.filter(item => item.score === null).map(item => item.id) },
    editorialStatus: contentAccepted ? 'content-accepted' : qualityPassed ? 'quality-qualified' : 'rework',
    submissionStatus: contentAccepted && !pendingReadiness.length && targetConfirmed ? 'ready-for-human-submission' : 'blocked',
    qualityFloor: COMMON_APP_QUALITY_FLOOR, qualityPassed, qualityBlockers, criticalFailures,
    studentReviewEligible: studentReviewBlockers.length === 0, studentReviewBlockers, effectiveTarget,
    targetMet, targetConfirmed, pendingReadiness, unresolvedIssueIds: [...new Set([...material, ...unaccepted].map(issue => issue.id))],
    words, containsDocumentText: false, reasoningCertified: false, sourceTruthVerified: false, authorshipCertified: false,
    humanApprovalVerified: false, submissionAuthorized: false, detectorReplicated: false };
}

export async function prepareCurrentAssessmentReview(policyRoot: string, path: string, profile: unknown) {
  const p = benchmarkProfileSchema.parse(profile);
  return p.essayType === 'common-app' ? prepareCommonAppAssessment(policyRoot, path, p) : prepareAssessmentReview(policyRoot, path, p);
}
export async function reviewCurrentAssessment(policyRoot: string, path: string, raw: unknown) {
  if (['75+25-assessment@1', 'judgment-evidence-assessment@2'].includes(String((raw as { schemaVersion?: unknown })?.schemaVersion)))
    fail('historical-common-app-rubric', 'This Common App record is historical. Prepare v2.1 and assess the actual text; no score conversion.');
  if ((raw as { schemaVersion?: unknown })?.schemaVersion === COMMON_APP_ASSESSMENT_VERSION) {
    return reviewCommonAppAssessment(policyRoot, path, raw);
  }
  if ((raw as { benchmarkReview?: { profile?: { essayType?: unknown } } })?.benchmarkReview?.profile?.essayType === 'common-app')
    fail('historical-common-app-rubric', 'The six-dimension Common App record is historical. Prepare and independently score v2.1. Legacy SDK replay remains available.');
  return reviewAssessment(policyRoot, path, raw);
}
