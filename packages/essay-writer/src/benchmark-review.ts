import { z } from 'zod';
import { auditText, hashValue } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { fail } from './files.js';
import { getEssayAssessmentProtocol } from './assessment-protocol.js';
import { HUMANIER_METHOD_VERSION, reviewBindings, reviewBindingsSchema, reviewSpanSchema,
  reviewNoteSchema, fullReviewSpan, validateReviewSpan } from './source-review.js';

export const BENCHMARK_RUBRIC_VERSION = '1.0.0' as const;
export const BENCHMARK_DIMENSION_IDS = ['prompt-selection', 'genre-task', 'reasoning-discourse',
  'author-voice', 'information-language', 'ending-economy'] as const;
export const BENCHMARK_CHECK_IDS = ['source-fidelity', 'edit-authority', 'answer-relations', 'school-facts', 'length-mechanics'] as const;
const essayTypes = ['common-app', 'why-major', 'why-school', 'supplement'] as const;
const note = reviewNoteSchema;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const benchmarkProfileSchema = z.object({ essayType: z.enum(essayTypes),
  promptStatus: z.enum(['supplied', 'unselected', 'missing']), task: note.optional()
}).strict().superRefine((profile, ctx) => {
  if (profile.essayType === 'supplement' && !profile.task)
    ctx.addIssue({ code: 'custom', path: ['task'], message: 'State the actual supplemental task.' });
  if (profile.essayType !== 'supplement' && profile.task !== undefined)
    ctx.addIssue({ code: 'custom', path: ['task'], message: 'Use task only for a supplemental essay.' });
});
export type BenchmarkProfile = z.infer<typeof benchmarkProfileSchema>;
const weights = {
  'common-app': [15, 25, 20, 15, 15, 10], 'why-major': [15, 35, 20, 10, 15, 5],
  'why-school': [15, 35, 20, 10, 15, 5], supplement: [25, 25, 20, 10, 15, 5]
} as const;
const rubric = {
  rubricVersion: BENCHMARK_RUBRIC_VERSION,
  dimensions: [
    { id: 'prompt-selection', title: 'Prompt response and material selection',
      question: 'Does the selected material answer the actual prompt? A missing or unselected prompt remains unrated.',
      levelAnchors: [
        { level: 0, description: 'The material answers a different question.' },
        { level: 1, description: 'The material only discusses the general topic.' },
        { level: 2, description: 'The response is partial and lacks key material.' },
        { level: 3, description: 'Direct material addresses the main requirements.' },
        { level: 4, description: 'Material closely serves the prompt, and selection makes the reader understanding more specific.' }
      ] },
    { id: 'genre-task', title: 'Completion of the actual genre task',
      question: 'Judge the task for this essay type, not a universal scene, growth or achievement template.',
      levelAnchors: [
        { level: 0, description: 'The essay performs a different kind of task.' },
        { level: 1, description: 'A generic declaration or activity list substitutes for the answer.' },
        { level: 2, description: 'Part of the task works but its core remains weak.' },
        { level: 3, description: 'The key task of this specific question is concretely completed.' },
        { level: 4, description: 'The task is fully completed and leaves an understanding specific to this author.' }
      ] },
    { id: 'reasoning-discourse', title: 'Reasoning and discourse relationships',
      question: 'Can a reader recover reasons, limits, comparisons, time and consequences from the text? Do not turn chronology into cause.',
      levelAnchors: [
        { level: 0, description: 'A key relationship is broken or contradictory.' },
        { level: 1, description: 'Change is asserted without its actual conditions.' },
        { level: 2, description: 'Some relationships are recoverable but an important jump remains.' },
        { level: 3, description: 'Motives, sequence and comparisons are clear, and conclusions stay within their support.' },
        { level: 4, description: 'Continuous reading gives sufficient relationships without repeatedly explaining the same meaning.' }
      ] },
    { id: 'author-voice', title: 'Author voice and judgment strength',
      question: 'Compare the supplied original, direct judgments and actual audience. Do not reward added polish, invented psychology or unsupported authorship claims.',
      levelAnchors: [
        { level: 0, description: 'Core judgments cannot be attributed to the author.' },
        { level: 1, description: 'Template evaluations dominate the account.' },
        { level: 2, description: 'Some personal expression remains alongside advisor-like phrasing.' },
        { level: 3, description: 'The author concrete objects, judgments and degree of force are clear.' },
        { level: 4, description: 'Selection and wording are distinctive, and the author can explain and take responsibility for them.' }
      ] },
    { id: 'information-language', title: 'Sentence-group information and natural expression',
      question: 'Read sentence groups for distinct information and useful connections. Plain sentences, necessary clauses, terminology and temporal connectors can score highly.',
      levelAnchors: [
        { level: 0, description: 'Expression obscures the main meaning.' },
        { level: 1, description: 'Generic explanation or repeated meaning dominates.' },
        { level: 2, description: 'Useful information coexists with repeated explanatory tails.' },
        { level: 3, description: 'Objects are identifiable, and sentences add information or necessary connections.' },
        { level: 4, description: 'Deletion or merging comparisons justify retention, and rhythm follows the information.' }
      ] },
    { id: 'ending-economy', title: 'Ending and use of space',
      question: 'Does the ending finish this task without repeating meaning or padding? A direct short answer needs no scene or callback.',
      levelAnchors: [
        { level: 0, description: 'The allocation of space prevents completion of the task.' },
        { level: 1, description: 'The ending lists qualities or gives a generic future outlook.' },
        { level: 2, description: 'The answer is present, but repetition consumes useful space.' },
        { level: 3, description: 'Important material receives space, and the text stops when the task is complete.' },
        { level: 4, description: 'The ending adds necessary content or meaning with a proportion suited to this question.' }
      ] }
  ],
  levels: [
    { level: 0, description: 'The dimension is not completed.' },
    { level: 1, description: 'The dimension is mainly asserted without adequate support.' },
    { level: 2, description: 'The dimension partly works but has a key weakness.' },
    { level: 3, description: 'The dimension is clear and specifically supported.' },
    { level: 4, description: 'The dimension is fully supported with effective selection and restraint.' }
  ],
  profiles: [
    { essayType: 'common-app', weights: weights['common-app'],
      task: 'Let the reader understand this person through actual experiences, choices and judgments. Growth or a realization is not compulsory.' },
    { essayType: 'why-major', weights: weights['why-major'],
      task: 'Connect actual academic work and questions to reasons for continued study. Praise for a subject or activity counts is insufficient.' },
    { essayType: 'why-school', weights: weights['why-school'],
      task: 'Connect the author needs to verified institutional resources and specific intended use. More resource names do not earn points.' },
    { essayType: 'supplement', weights: weights.supplement,
      task: 'Assess the actual question stated in the profile. A direct short answer can be complete without a personal growth story.' }
  ],
  checks: [...BENCHMARK_CHECK_IDS],
  total: { method: 'Sum manual level times profile weight, divide by four, and expose only the enclosing five-point interval. Levels zero through two always require rework.',
    bands: '[0,5), [5,10), ..., [90,95), [95,100]', missing: 'Any null level leaves the total band null. Never redistribute weights.' },
  calibration: 'Weights and bands are this versioned benchmark, not a recovered historical scale. Real advisor calibration and cross-author effects remain unverified.',
  profileSelection: 'Read the full prompt and all its parts. Choose the most specific applicable profile; Why Major and Why School are specialized supplemental tasks. A combined major-and-school question must cover both parts within prompt-selection and genre-task, or use Supplement with the explicit combined task. Profile selection cannot omit a requirement.',
  prestige: 'Prestige, achievement size, scale or rarity alone earns no points. A classroom, small project, everyday choice or sustained question can score highly when it fulfills the actual prompt with the author own support.',
  comparison: 'Compare only the same prompt, profile, rubric and scope. Retain reviewer identity; resolve material disagreements individually instead of averaging away gaps.'
};
const flags = { reasoningCertified: false, judgmentsVerified: false, semanticEquivalenceChecked: false,
  independentReaderVerified: false, voiceCertified: false, sourceTruthVerified: false,
  officialSourcesVerified: false, detectorReplicated: false, automaticRewrite: false,
  admissionsOutcomePredicted: false, deliveryAuthorized: false, replacesExistingReviews: false } as const;
// This additive reporting view leaves the rubric, bound inputs and legacy band calculation unchanged.
const scoreReporting = {
  version: '1.0.0',
  method: 'Earned points sum each rated level times its unchanged profile weight divided by four. Round displayed percentage scores to one decimal place.',
  full: 'fullScore100 is earned points only when all six dimensions are rated. Otherwise it is null and scope is partial.',
  partial: 'assessedScore100 is earned points divided by assessedWeight times 100. It describes only rated dimensions, not the full essay. No assessed weight leaves it null.',
  missing: 'Keep unrated dimensions and their original weights visible. A rated zero counts as assessed. The legacy totalBand remains null whenever any dimension is unrated.',
  limits: 'This is an arithmetic presentation of manual grades, not finer editorial calibration, a school ranking comparison or an admission prediction.'
} as const;
export function getEssayQualityBenchmark() {
  return { schemaVersion: '1.0.0', rubricVersion: BENCHMARK_RUBRIC_VERSION,
    rubricHash: hashValue(rubric), rubric: structuredClone(rubric),
    scoreReportingVersion: scoreReporting.version, scoreReporting: structuredClone(scoreReporting),
    assessmentProtocol: getEssayAssessmentProtocol(),
    requiresHumanReview: true, containsDocumentText: false, ...flags };
}
const officialSourceSchema = z.object({
  url: z.url().refine(value => new URL(value).protocol === 'https:', { message: 'Declare an HTTPS official-source URL.' }),
  checkedAt: z.iso.date()
}).strict();
const bindingsSchema = reviewBindingsSchema.extend({ rubricVersion: z.string().min(1), rubricHash: digest, profileHash: digest }).strict();
export const benchmarkReviewSchema = z.object({
  schemaVersion: z.literal('1.0.0'), methodVersion: z.literal(HUMANIER_METHOD_VERSION), profile: benchmarkProfileSchema,
  bindings: bindingsSchema, reviewerRole: z.enum(['agent', 'advisor']), reviewerId: note,
  dimensions: z.array(z.object({ dimensionId: z.enum(BENCHMARK_DIMENSION_IDS), weight: z.number().int().min(0).max(100),
    level: z.number().int().min(0).max(4).nullable(), anchors: z.array(reviewSpanSchema).max(2000), absenceReason: note.optional(),
    reason: note, limitation: note, retainCounterexample: note,
    decision: z.enum(['retain', 'revise', 'needs-source', 'unresolved'])
  }).strict()).length(BENCHMARK_DIMENSION_IDS.length),
  checks: z.array(z.object({ checkId: z.enum(BENCHMARK_CHECK_IDS), status: z.enum(['clear', 'issue', 'unverified', 'not-applicable']),
    anchors: z.array(reviewSpanSchema).max(2000), reason: note, officialSources: z.array(officialSourceSchema).max(100).optional()
  }).strict()).length(BENCHMARK_CHECK_IDS.length), recommendation: z.enum(['adopt', 'rework'])
}).strict();

export async function prepareBenchmarkReview(policyRoot: string, path: string, rawProfile: unknown) {
  const session = await loadSession(policyRoot, path), profile = benchmarkProfileSchema.parse(rawProfile);
  if (profile.promptStatus === 'supplied' && !session.manifest.context.prompt.trim())
    fail('benchmark-prompt', 'A supplied prompt profile requires a nonempty prompt in the bound session.');
  const catalog = getEssayQualityBenchmark();
  const bindings = { ...reviewBindings(session), rubricVersion: BENCHMARK_RUBRIC_VERSION,
    rubricHash: catalog.rubricHash, profileHash: hashValue(profile) };
  const audit = auditText({ schemaVersion: '1.0.0', context: session.manifest.context,
    original: session.original, document: session.document }, session.policy);
  const changedFromOriginal = bindings.documentHash !== bindings.originalHash;
  const anchors = session.document.blocks.filter(block => block.text.trim()).map(fullReviewSpan);
  return { schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings, profile,
    rubric: catalog.rubric, context: session.manifest.context, original: session.original, document: session.document,
    scoreReportingVersion: catalog.scoreReportingVersion, scoreReporting: catalog.scoreReporting,
    observedMechanicalErrors: audit.observedErrors, changedFromOriginal,
    instructions: [
      'Read the entire current document, actual prompt, original and current prepare before assigning manual levels. The catalog provides criteria rather than a detector or an automatic semantic score.',
      'Read all prompt parts and choose the most specific applicable profile. Combined major-and-school prompts still require both parts in prompt-selection and genre-task, or Supplement with the explicit combined task. Choosing a profile never removes a prompt requirement.',
      'Rate all six dimensions once in the exact prepared order and keep the exact profile weights. Each dimension needs exact current codepoint anchors or an explicit absence reason, plus a reason, limitation, retention counterexample and editing decision. Absence supports only zero or null; positive levels require actual current text.',
      'Use null for an unassessed dimension. If the prompt is missing or unselected, prompt-selection must be null and answer-relations must remain issue or unverified. The total band stays null whenever any dimension is null; no weights are redistributed.',
      'Assess the actual genre task. Common App need not contain a growth arc, academic plans may be stated directly, one useful school resource can suffice, and a short supplemental answer needs no scene or callback.',
      'Do not deduct solely for subject-verb-object syntax, short sentences, necessary wh clauses, technical words, time connectors, a strong supplied judgment or the absence of literary devices. Varied grammar does not excuse repeated meaning.',
      'Complete all five checks in order. Not-applicable needs a concrete reason and cannot hide missing prompt, known mechanical errors or actual edits. Source-fidelity and edit-authority can be not-applicable only when the current document is unchanged; answer-relations and length-mechanics always apply.',
      'Why School school-facts cannot be not-applicable. A clear school-facts claim needs an HTTPS official URL and calendar date. These declarations do not prove the page was read or is official. No network request is made.',
      'Observed mechanical errors require length-mechanics issue even if other manual judgments are favorable. Levels zero through two, explicit revise, needs-source, unresolved, unrated, issue or unverified states override an adopt recommendation.',
      'Preserve scorer identity in the record. Compare before and after only under the same prompt, profile, rubric and scope; resolve substantial disagreement rather than averaging it away. Current weights still require actual advisor calibration.',
      'Save outside immutable session folders. This layer does not replace Source, Answer, Style, Linguistic or Discourse Review and never authorizes submission. External detector records stay separate and untested drafts receive no invented label.'
    ],
    template: { schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, profile, bindings,
      reviewerRole: 'agent', reviewerId: '',
      dimensions: BENCHMARK_DIMENSION_IDS.map((dimensionId, index) => ({ dimensionId, weight: weights[profile.essayType][index]!,
        level: null, anchors, reason: '', limitation: '', retainCounterexample: '', decision: 'unresolved' })),
      checks: BENCHMARK_CHECK_IDS.map(checkId => ({ checkId, status: 'unverified', anchors, reason: '',
        ...(checkId === 'school-facts' ? { officialSources: [] } : {}) })), recommendation: 'rework' },
    containsDocumentText: true, requiresHumanReview: true, ...flags };
}

export async function reviewBenchmark(policyRoot: string, path: string, raw: unknown) {
  const record = benchmarkReviewSchema.parse(raw);
  const prepared = await prepareBenchmarkReview(policyRoot, path, record.profile);
  if (hashValue(record.bindings) !== hashValue(prepared.bindings))
    fail('benchmark-review-stale', 'Prepare for the current session, original, document, context, policy, rubric and profile.');
  const session = await loadSession(policyRoot, path);
  let referenceCount = 0;
  const checkSpan = (span: z.infer<typeof reviewSpanSchema>) => {
    validateReviewSpan(span, session.document.blocks, 'benchmark-review-span');
    if (!span.quote.trim()) fail('benchmark-review-span', 'Use substantive exact current codepoint spans.');
    referenceCount++;
  };
  record.dimensions.forEach((dimension, index) => {
    if (dimension.dimensionId !== BENCHMARK_DIMENSION_IDS[index] || dimension.weight !== weights[record.profile.essayType][index])
      fail('benchmark-review-dimensions', 'Rate every dimension once in the prepared order with its exact profile weight.');
    dimension.anchors.forEach(checkSpan);
    if (dimension.anchors.length === 0 && !dimension.absenceReason)
      fail('benchmark-review-absence', 'Use exact current evidence or explicitly explain the absent target content.');
    if (dimension.anchors.length > 0 && dimension.absenceReason !== undefined)
      fail('benchmark-review-absence', 'Use current evidence or an absence reason, without claiming both.');
    if (dimension.anchors.length === 0 && dimension.level !== null && dimension.level > 0)
      fail('benchmark-review-absence', 'Positive levels require actual current text; absence supports only zero or unrated.');
  });
  if (record.profile.promptStatus !== 'supplied' && record.dimensions[0]!.level !== null)
    fail('benchmark-review-prompt', 'Keep prompt-selection unrated when the prompt is unselected or missing.');
  record.checks.forEach((check, index) => {
    if (check.checkId !== BENCHMARK_CHECK_IDS[index])
      fail('benchmark-review-checks', 'Complete all five checks once in their prepared order.');
    check.anchors.forEach(checkSpan);
    if (check.checkId === 'answer-relations') {
      if (check.status === 'not-applicable' || (record.profile.promptStatus !== 'supplied' && check.status === 'clear'))
        fail('benchmark-review-prompt', 'An answer check cannot be skipped or clear when the prompt is not selected or supplied.');
    }
    if (['source-fidelity', 'edit-authority'].includes(check.checkId) && check.status === 'not-applicable' && prepared.changedFromOriginal)
      fail('benchmark-review-applicability', 'Actual edits require a source and editing-authority judgment.');
    if (check.checkId === 'length-mechanics' && (check.status === 'not-applicable' ||
        (prepared.observedMechanicalErrors > 0 && check.status !== 'issue')))
      fail('benchmark-review-mechanics', 'Length and mechanics apply; observed mechanical errors require an issue status.');
    if (check.checkId === 'school-facts') {
      if (record.profile.essayType === 'why-school' && check.status === 'not-applicable')
        fail('benchmark-review-school', 'Why School requires a school-facts judgment.');
      if (record.profile.essayType === 'why-school' && check.status === 'clear' && !check.officialSources?.length)
        fail('benchmark-review-school', 'Declare an official-source HTTPS URL and checked date for clear Why School facts.');
    }
  });
  const rework = {
    dimensions: record.dimensions.filter(dimension => dimension.decision !== 'retain').map(dimension => dimension.dimensionId),
    unratedDimensions: record.dimensions.filter(dimension => dimension.level === null).map(dimension => dimension.dimensionId),
    lowRatedDimensions: record.dimensions.filter(dimension => dimension.level !== null && dimension.level <= 2).map(dimension => dimension.dimensionId),
    checks: record.checks.filter(check => check.status === 'issue' || check.status === 'unverified').map(check => check.checkId),
    recommendation: record.recommendation !== 'adopt'
  };
  let totalBand: { min: number; max: number; maxInclusive: boolean } | null = null;
  if (rework.unratedDimensions.length === 0) {
    const weighted = record.dimensions.reduce((sum, dimension) => sum + dimension.level! * dimension.weight, 0);
    const min = Math.min(95, Math.floor(weighted / 20) * 5);
    totalBand = { min, max: min + 5, maxInclusive: min === 95 };
  }
  const assessed = record.dimensions.filter(dimension => dimension.level !== null);
  const assessedWeight = assessed.reduce((sum, dimension) => sum + dimension.weight, 0);
  const earned = assessed.reduce((sum, dimension) => sum + dimension.level! * dimension.weight / 4, 0);
  const full = rework.unratedDimensions.length === 0;
  const roundOne = (value: number) => Math.round(value * 10) / 10;
  const percentage = { scope: full ? 'full' as const : 'partial' as const,
    fullScore100: full ? roundOne(earned) : null,
    assessedScore100: assessedWeight > 0 ? roundOne(earned / assessedWeight * 100) : null,
    assessedWeight, unassessedWeight: 100 - assessedWeight };
  const needsRework = rework.dimensions.length > 0 || rework.unratedDimensions.length > 0 || rework.lowRatedDimensions.length > 0 || rework.checks.length > 0 || rework.recommendation;
  return { schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings: prepared.bindings,
    recordHash: hashValue(record), reviewerRole: record.reviewerRole, reviewerHash: hashValue({ role: record.reviewerRole, id: record.reviewerId }),
    dimensions: record.dimensions.map(({ dimensionId, weight, level }) => ({ dimensionId, weight, level })), totalBand,
    scoreReportingVersion: scoreReporting.version, percentage,
    reviewDecision: needsRework ? 'needs-rework' : 'recorded', rework,
    dimensionCount: record.dimensions.length, checkCount: record.checks.length, referenceCount,
    observedMechanicalErrors: prepared.observedMechanicalErrors,
    reworkCount: rework.dimensions.length + rework.unratedDimensions.length + rework.lowRatedDimensions.length + rework.checks.length + Number(rework.recommendation),
    referencesVerified: true, coverageVerified: true, calculationVerified: true,
    containsDocumentText: false, requiresHumanReview: true, ...flags };
}
