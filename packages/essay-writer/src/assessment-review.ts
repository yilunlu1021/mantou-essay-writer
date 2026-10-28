import { z } from 'zod';
import { hashValue } from '@mantou/text-quality';
import { benchmarkProfileSchema, benchmarkReviewSchema, BENCHMARK_DIMENSION_IDS,
  prepareBenchmarkReview, reviewBenchmark } from './benchmark-review.js';
import { getEssayAssessmentProtocol, ESSAY_ASSESSMENT_PROTOCOL_VERSION } from './assessment-protocol.js';
import { reviewNoteSchema as note, reviewSpanSchema, validateReviewSpan } from './source-review.js';
import { fail } from './files.js';

const dimension = z.enum(BENCHMARK_DIMENSION_IDS);
const readinessIds = ['prompt', 'source', 'authorship', 'edit-authority', 'school-facts', 'length-mechanics', 'student-final-review'] as const;
export const assessmentReviewSchema = z.object({
  schemaVersion: z.literal('1.1.0'), protocolVersion: z.literal(ESSAY_ASSESSMENT_PROTOCOL_VERSION),
  protocolHash: z.string().regex(/^[a-f0-9]{64}$/), benchmarkReview: benchmarkReviewSchema,
  reading: z.object({ task: note, readerUnderstanding: note, anchors: z.array(reviewSpanSchema).min(1).max(100),
    applicationRoleOrLimitation: note, questions: z.array(z.object({ question: note, issueId: note }).strict()).max(100) }).strict(),
  calibration: z.object({ taskValue: note, evidenceLimits: note, presentationVsContent: note,
    highestLevelJustifications: z.array(z.object({ dimensionId: dimension, whyAboveLevel3: note,
      counterevidenceOrLimit: note }).strict()).max(BENCHMARK_DIMENSION_IDS.length) }).strict(),
  issues: z.array(z.object({ id: note, description: note, primaryDimension: dimension,
    secondaryEffects: z.array(z.object({ dimensionId: dimension, effect: note }).strict()).max(5),
    anchors: z.array(reviewSpanSchema).min(1).max(100), severity: z.enum(['optional', 'material']),
    decision: z.enum(['retain-with-reason', 'revise', 'needs-source']), reason: note }).strict()).max(100),
  target: z.object({ school: z.object({ name: note, status: z.enum(['confirmed', 'unverified']), sourceRef: note }).strict().nullable(),
    applicantContext: note, minimumScore100: z.number().min(0).max(100).nullable(), rationale: note }).strict(),
  acceptance: z.object({ decision: z.enum(['proposed', 'accepted', 'declined']),
    byRole: z.enum(['agent', 'advisor', 'business-owner']), sourceRef: note,
    acceptedIssueIds: z.array(note).max(100) }).strict(),
  readiness: z.array(z.object({ checkId: z.enum(readinessIds),
    status: z.enum(['clear', 'issue', 'unverified', 'not-applicable']), reason: note, sourceRef: note }).strict()).length(readinessIds.length)
}).strict();

export async function prepareAssessmentReview(policyRoot: string, path: string, rawProfile: unknown) {
  const profile = benchmarkProfileSchema.parse(rawProfile);
  const benchmark = await prepareBenchmarkReview(policyRoot, path, profile);
  const protocol = getEssayAssessmentProtocol();
  return { ...benchmark, ...protocol,
    instructions: [...benchmark.instructions,
      ...Object.values(protocol.protocol),
      'Use the assessment record for new work. Legacy benchmark needs-rework remains visible. Human acceptance of explicitly documented optional limitations is a separate editorial decision.',
      'Readiness declarations and human-role labels are not verified approval or authorship. Keep unverified source, authorship and student-final-review explicit.'],
    template: { schemaVersion: '1.1.0', protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash,
      benchmarkReview: benchmark.template,
      reading: { task: '', readerUnderstanding: '', anchors: [], applicationRoleOrLimitation: '', questions: [] }, issues: [],
      calibration: { taskValue: '', evidenceLimits: '', presentationVsContent: '', highestLevelJustifications: [] },
      target: { school: null, applicantContext: '', minimumScore100: null, rationale: '' },
      acceptance: { decision: 'proposed', byRole: 'agent', sourceRef: '', acceptedIssueIds: [] },
      readiness: readinessIds.map(checkId => ({ checkId, status: 'unverified', reason: '', sourceRef: '' })) },
    submissionAuthorized: false };
}

export async function reviewAssessment(policyRoot: string, path: string, raw: unknown) {
  const record = assessmentReviewSchema.parse(raw), protocol = getEssayAssessmentProtocol();
  if (record.protocolHash !== protocol.protocolHash) fail('assessment-stale', 'Prepare using the current assessment protocol.');
  const prepared = await prepareBenchmarkReview(policyRoot, path, record.benchmarkReview.profile);
  const benchmark = await reviewBenchmark(policyRoot, path, record.benchmarkReview);
  const fullMarkIds = record.benchmarkReview.dimensions.filter(item => item.level === 4).map(item => item.dimensionId);
  const justifiedIds = record.calibration.highestLevelJustifications.map(item => item.dimensionId);
  if (new Set(justifiedIds).size !== justifiedIds.length || justifiedIds.length !== fullMarkIds.length ||
      justifiedIds.some(id => !fullMarkIds.includes(id)))
    fail('assessment-calibration', 'Justify every level 4 once, and only level 4 dimensions, against level 3 and its limits.');
  const ids = new Set<string>();
  const checkSpan = (span: z.infer<typeof reviewSpanSchema>) => validateReviewSpan(span, prepared.document.blocks, 'assessment-span');
  record.reading.anchors.forEach(checkSpan);
  for (const issue of record.issues) {
    if (ids.has(issue.id)) fail('assessment-issue', 'Use unique issue IDs.');
    ids.add(issue.id); issue.anchors.forEach(checkSpan);
    const dimensions = new Set([issue.primaryDimension]);
    for (const effect of issue.secondaryEffects) {
      if (dimensions.has(effect.dimensionId)) fail('assessment-issue', 'Give each additional dimension one distinct effect.');
      dimensions.add(effect.dimensionId);
    }
  }
  if (record.reading.questions.some(question => !ids.has(question.issueId)))
    fail('assessment-question', 'Every remaining reader question must reference an explicit issue.');
  const accepted = new Set(record.acceptance.acceptedIssueIds);
  if (accepted.size !== record.acceptance.acceptedIssueIds.length || [...accepted].some(id => !ids.has(id)))
    fail('assessment-acceptance', 'Accept only unique, declared issue IDs.');
  if (record.acceptance.decision === 'accepted' && record.acceptance.byRole === 'agent')
    fail('assessment-acceptance', 'An agent cannot supply human acceptance.');
  for (const [index, item] of record.readiness.entries()) {
    if (item.checkId !== readinessIds[index]) fail('assessment-readiness', 'Complete all readiness checks once in the prepared order.');
    if (item.status === 'not-applicable' && (item.checkId !== 'school-facts' || record.benchmarkReview.profile.essayType === 'why-school'))
      fail('assessment-readiness', 'Only inapplicable school facts may be skipped.');
  }
  const readiness = new Map(record.readiness.map(item => [item.checkId, item]));
  const paired = { 'source-fidelity': 'source', 'edit-authority': 'edit-authority', 'answer-relations': 'prompt', 'school-facts': 'school-facts', 'length-mechanics': 'length-mechanics' } as const;
  for (const check of record.benchmarkReview.checks) {
    const key = paired[check.checkId as keyof typeof paired];
    if (key && check.status === 'issue' && readiness.get(key)?.status !== 'issue')
      fail('assessment-readiness', 'Known benchmark issues must remain issues in readiness.');
    if (key && check.status === 'unverified' && readiness.get(key)?.status === 'clear')
      fail('assessment-readiness', 'Resolve the benchmark evidence before claiming readiness clear.');
  }
  for (const rated of record.benchmarkReview.dimensions) {
    const flagged = rated.level !== null && rated.level <= 2 || rated.decision !== 'retain';
    if (flagged && !record.issues.some(issue => issue.primaryDimension === rated.dimensionId || issue.secondaryEffects.some(effect => effect.dimensionId === rated.dimensionId)))
      fail('assessment-issue-coverage', 'Explain each low-rated or unresolved dimension in the issue ledger.');
  }
  if (record.issues.some(issue => accepted.has(issue.id) && (issue.severity !== 'optional' || issue.decision !== 'retain-with-reason')))
    fail('assessment-acceptance', 'Human acceptance may retain only explicitly optional limitations.');
  const materialIssues = record.issues.filter(issue => issue.severity === 'material' || issue.decision !== 'retain-with-reason');
  const unacceptedIssues = record.issues.filter(issue => !accepted.has(issue.id));
  const severeDimensions = record.benchmarkReview.dimensions.filter(item => item.level !== null && item.level <= 1).map(item => item.dimensionId);
  const unresolvedDimensions = record.benchmarkReview.dimensions.filter(item => ['needs-source', 'unresolved'].includes(item.decision)).map(item => item.dimensionId);
  if (record.benchmarkReview.dimensions.some(item => item.decision === 'needs-source') &&
      !['issue', 'unverified'].includes(readiness.get('source')!.status))
    fail('assessment-readiness', 'A dimension requiring sources cannot have clear source readiness.');
  const fullScore = benchmark.percentage.fullScore100;
  const targetMet = fullScore !== null && record.target.minimumScore100 !== null && fullScore >= record.target.minimumScore100;
  const knownReadinessIssues = record.readiness.filter(item => item.status === 'issue');
  const editorialAccepted = record.acceptance.decision === 'accepted' && targetMet && materialIssues.length === 0 &&
    unacceptedIssues.length === 0 && severeDimensions.length === 0 && unresolvedDimensions.length === 0 && knownReadinessIssues.length === 0;
  const pendingReadiness = record.readiness.filter(item => !['clear', 'not-applicable'].includes(item.status)).map(item => item.checkId);
  const targetConfirmed = record.target.school?.status === 'confirmed';
  const submissionReady = editorialAccepted && pendingReadiness.length === 0 && targetConfirmed;
  return { schemaVersion: '1.1.0', protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash, bindings: benchmark.bindings,
    recordHash: hashValue(record), benchmark,
    editorialStatus: editorialAccepted ? 'content-accepted' : record.target.minimumScore100 === null ? 'target-needed' : 'rework',
    submissionStatus: submissionReady ? 'ready-for-human-submission' : 'blocked', targetMet,
    knownLimitationIds: editorialAccepted ? [...accepted] : [],
    unresolvedIssueIds: [...new Set([...materialIssues, ...unacceptedIssues].map(item => item.id))],
    severeDimensions, unresolvedDimensions, pendingReadiness, targetConfirmed,
    containsDocumentText: false, humanApprovalVerified: false, authorshipCertified: false,
    submissionAuthorized: false, deliveryAuthorized: false, admissionsOutcomePredicted: false };
}
