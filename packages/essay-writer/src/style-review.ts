import { z } from 'zod';
import { documentSchema, hashValue, type TextDocument } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { fail } from './files.js';
import { HUMANIER_METHOD_VERSION, reviewBindingsSchema, reviewBindings, reviewSpanSchema,
  reviewNoteSchema, validateReviewSpan, type ReviewSpan } from './source-review.js';

const note = reviewNoteSchema;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/);
const optionalText = z.string().min(1).max(4000).nullable();
export const styleEvidenceSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  references: z.array(z.object({
    id: identifier,
    origin: z.enum(['student-original', 'user-confirmed-edit', 'advisor-example', 'external-example']),
    authorRole: z.enum(['student', 'advisor', 'unknown']),
    approval: z.enum(['user-confirmed', 'unconfirmed']), document: documentSchema, note
  }).strict()).max(100),
  reports: z.array(z.object({
    id: identifier, toolName: note, modelVersion: optionalText, observedAt: optionalText,
    testedDocument: documentSchema, testedDocumentHash: digest,
    documentLabel: z.enum(['human', 'mixed', 'ai-generated', 'unknown']),
    labelSource: z.enum(['visible', 'user-reported', 'not-provided']), rawScore: optionalText,
    comments: z.array(z.object({
      anchor: reviewSpanSchema, featureTags: z.array(note).max(100),
      explanation: optionalText, observedStrength: optionalText,
      sourceObservation: z.object({
        artifactSha256: digest,
        visibility: z.enum(['expanded', 'collapsed', 'collapsed-truncated']),
        visibleText: note,
        anchorRelation: z.enum(['exact', 'prefix', 'fragment']),
        transcription: z.literal('agent-transcribed')
      }).strict().optional()
    }).strict()).max(2000),
    sourceArtifacts: z.array(z.object({ kind: z.enum(['image', 'report']), sha256: digest }).strict()).max(100)
  }).strict()).max(100)
}).strict().superRefine((evidence, context) => {
  evidence.reports.forEach((report, reportIndex) => report.comments.forEach((comment, commentIndex) => {
    if (comment.sourceObservation && !report.sourceArtifacts.some(artifact => artifact.sha256 === comment.sourceObservation!.artifactSha256))
      context.addIssue({ code: 'custom', path: ['reports', reportIndex, 'comments', commentIndex, 'sourceObservation', 'artifactSha256'],
        message: 'Declare the observation screenshot among this report source artifacts.' });
    if (comment.sourceObservation?.visibility !== undefined && comment.sourceObservation.visibility !== 'expanded' &&
      (comment.explanation !== null || comment.featureTags.length > 0))
      context.addIssue({ code: 'custom', path: ['reports', reportIndex, 'comments', commentIndex],
        message: 'Collapsed observations keep unseen explanations and feature tags unknown.' });
  }));
});
export type StyleEvidence = z.infer<typeof styleEvidenceSchema>;
export const EMPTY_STYLE_EVIDENCE: Readonly<StyleEvidence> = Object.freeze({
  schemaVersion: '1.0.0', references: Object.freeze([]) as unknown as StyleEvidence['references'],
  reports: Object.freeze([]) as unknown as StyleEvidence['reports']
});
const styleBindingsSchema = reviewBindingsSchema.extend({ evidenceHash: digest }).strict();
const spans = z.array(reviewSpanSchema).max(2000);
export const LANGUAGE_REVIEW_DIMENSIONS = ['main-clause', 'attachments', 'diction', 'stance', 'cadence', 'information'] as const;
const languageCheckSchema = z.object({
  dimension: z.enum(LANGUAGE_REVIEW_DIMENSIONS), anchors: spans.min(1),
  observation: note, decision: z.enum(['retain', 'revise', 'unresolved']),
  reason: note, retainCounterexample: note
}).strict();
export const styleReviewSchema = z.object({
  schemaVersion: z.literal('1.0.0'), methodVersion: z.literal(HUMANIER_METHOD_VERSION),
  bindings: styleBindingsSchema, reviewerRole: z.literal('agent'),
  paragraphs: z.array(z.object({
    anchor: reviewSpanSchema, purpose: note, concreteContent: note,
    status: z.enum(['distinct', 'repetitive', 'generic', 'unresolved']), reason: note
  }).strict()).max(5000),
  languageChecks: z.array(languageCheckSchema).length(LANGUAGE_REVIEW_DIMENSIONS.length),
  patterns: z.array(z.object({
    kind: z.enum(['repeated-function', 'explanatory-tail', 'generic-plan', 'register-shift', 'syntax-cadence', 'other']),
    anchors: spans.min(1), assessment: z.enum(['retain', 'revise', 'unresolved']), explanation: note
  }).strict()).max(2000), patternsReason: note,
  voice: z.object({
    status: z.enum(['available', 'unavailable', 'unresolved']),
    anchors: z.array(z.object({ candidate: reviewSpanSchema,
      reference: z.object({ referenceId: identifier, span: reviewSpanSchema }).strict()
    }).strict()).max(2000), preserve: note, avoidCopying: note, reason: note
  }).strict(),
  feedback: z.array(z.object({
    reportId: identifier, commentIndex: z.number().int().nonnegative(), scope: z.enum(['current', 'historical']),
    anchors: spans, hypothesis: note, qualityDecision: z.enum(['retain', 'revise', 'unresolved']),
    reason: note, retainCounterexample: note
  }).strict()).max(10000), feedbackReason: note,
  protectedChoices: z.array(z.object({ anchor: reviewSpanSchema, reason: note,
    source: z.enum(['author', 'prompt', 'domain']) }).strict()).min(1).max(2000),
  overall: z.object({ status: z.enum(['retain', 'revise', 'unresolved']), reason: note }).strict(),
  recommendation: z.enum(['adopt', 'rework'])
}).strict();

type Session = Awaited<ReturnType<typeof loadSession>>;
function substantiveSpan(span: ReviewSpan, document: TextDocument, code: string) {
  validateReviewSpan(span, document.blocks, code);
  if (!span.quote.trim()) fail(code, 'Reference substantive text using exact Unicode codepoint offsets.');
}
function evidenceValue(raw: unknown): StyleEvidence {
  const evidence = styleEvidenceSchema.parse(raw === undefined ? EMPTY_STYLE_EVIDENCE : raw);
  for (const values of [evidence.references, evidence.reports])
    if (new Set(values.map(value => value.id)).size !== values.length)
      fail('style-evidence-id', 'Use unique reference IDs and unique report IDs.');
  for (const report of evidence.reports) {
    if (hashValue(report.testedDocument) !== report.testedDocumentHash)
      fail('style-evidence-hash', 'Bind each report to the exact tested document snapshot.');
    if (report.labelSource === 'not-provided' && (report.documentLabel !== 'unknown' || report.rawScore !== null))
      fail('style-evidence-score', 'Use an unknown label and null score when the document result was not provided.');
    for (const comment of report.comments) substantiveSpan(comment.anchor, report.testedDocument, 'style-evidence-span');
  }
  return evidence;
}
function bindings(s: Session, evidence: StyleEvidence) { return { ...reviewBindings(s), evidenceHash: hashValue(evidence) }; }
function reportScopes(documentHash: string, evidence: StyleEvidence) {
  return evidence.reports.map(report => ({ reportId: report.id,
    scope: report.testedDocumentHash === documentHash ? 'current' as const : 'historical' as const,
    commentCount: report.comments.length }));
}

// Detect blank lines without normalizing CRLF or measuring offsets in UTF-16 units.
export function logicalParagraphAnchors(document: TextDocument): ReviewSpan[] {
  const result: ReviewSpan[] = [];
  for (const block of document.blocks) {
    const chars = Array.from(block.text);
    const newlineEnd = (i: number): number | undefined => chars[i] === '\r' ? i + (chars[i + 1] === '\n' ? 2 : 1) :
      chars[i] === '\n' ? i + 1 : undefined;
    const add = (begin: number, end: number) => {
      while (begin < end && /\s/u.test(chars[begin]!)) begin++;
      while (end > begin && /\s/u.test(chars[end - 1]!)) end--;
      if (begin < end) result.push({ blockId: block.id, start: begin, end, quote: chars.slice(begin, end).join('') });
    };
    let begin = 0, i = 0;
    while (i < chars.length) {
      const first = newlineEnd(i);
      if (first === undefined) { i++; continue; }
      let j = first;
      while (j < chars.length && newlineEnd(j) === undefined && /\s/u.test(chars[j]!)) j++;
      const second = newlineEnd(j);
      if (second === undefined) { i = first; continue; }
      add(begin, i); begin = second; i = second;
    }
    add(begin, chars.length);
  }
  return result;
}
function surfaceCues(s: Session) {
  if (s.manifest.context.language === 'zh') return { scope: 'not-supported-for-this-language' as const, cues: [] };
  const cues: { kind: 'future-intention' | 'meaning-explanation' | 'intention-scaffolding' | 'explanatory-attachment' | 'abstract-interest-frame'; anchor: ReviewSpan }[] = [];
  for (const block of s.document.blocks) {
    const patterns = [['future-intention', /\bI\s+(?:would\s+like\b|want\b|hope\b|would\b)/giu],
      ['meaning-explanation', /\bThis\s+experience\s+(?:taught|helped|made)\b/giu],
      ['intention-scaffolding', /\bI\s+(?:want\s+to\s+be\s+able\s+to|would\s+want\s+to)\b/giu],
      ['explanatory-attachment', /\b(?:including\s+(?:someone|something|those|people)|before\s+assuming)\b/giu],
      ['abstract-interest-frame', /\b(?:interests?\s+me\s+for\s+(?:its|their)\s+combination\s+of|I\s+am\s+particularly\s+interested\s+in)\b/giu]] as const;
    for (const [kind, pattern] of patterns) for (const match of block.text.matchAll(pattern)) {
      const start = Array.from(block.text.slice(0, match.index)).length;
      cues.push({ kind, anchor: { blockId: block.id, start, end: start + Array.from(match[0]).length, quote: match[0] } });
    }
  }
  return { scope: 'english-phrases-only' as const, cues };
}
export async function prepareStyleReview(policyRoot: string, path: string, rawEvidence?: unknown) {
  const s = await loadSession(policyRoot, path), evidence = evidenceValue(rawEvidence);
  const bound = bindings(s, evidence), paragraphs = logicalParagraphAnchors(s.document);
  const scopes = reportScopes(bound.documentHash, evidence);
  return {
    schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings: bound,
    instructions: [
      'Read the current prepare and complete Source Review and Answer Review separately. A sourced, coherent answer can still lose the author voice.',
      'For each exact logical paragraph, explain its purpose and concrete content. Repeated text at different positions requires separate entries. Do not replace multiple logical paragraphs with one block span.',
      'Check repeated paragraph functions, explanatory tails, generic plans, register changes and cadence. Surface cues locate English phrases only; counts do not classify AI or require rewriting.',
      'Review all six language dimensions separately: main-clause and action position, clause attachments, diction and concrete objects, stance, cadence, and information gain. Anchor each judgment and give a retention counterexample. A coherent answer is not a sentence-level voice review.',
      'Check whether intention/ability frames delay the action, tails repeat what is understood, nouns replace concrete objects, and stacked qualifications change the author stance. Ordinary vocabulary, true technical frameworks, useful clauses and varied degrees of certainty remain valid. Do not use word bans or length quotas.',
      'Compare appropriate references with their stated origin, author role and approval. Advisor examples are not student words. These metadata are unverified declarations, not authenticated authorship.',
      'Address every report comment once. Separate the observed label and explanation from your hypothesis and editing decision. Historical feedback is not a detection result for the current draft.',
      'Do not turn isolated labels into bans on ordinary sentences, necessary terminology, chronology, first person or genuine future plans. Record protected choices and a retention counterexample for each feedback interpretation.',
      'Do not add facts, errors, invented scenes, emotion or irregular grammar to influence a label. No network request or automatic edit is made.',
      'Save this incomplete template outside immutable version folders. The program verifies bindings, exact references, coverage and explicit states only. It does not certify evidence authenticity, natural voice, independent reading, detector replication or submission approval.'
    ],
    context: s.manifest.context, document: s.document, evidence, paragraphs, reportScopes: scopes, surfaceCues: surfaceCues(s),
    template: {
      schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings: bound, reviewerRole: 'agent',
      paragraphs: paragraphs.map(anchor => ({ anchor, purpose: '', concreteContent: '', status: 'unresolved', reason: '' })),
      languageChecks: LANGUAGE_REVIEW_DIMENSIONS.map(dimension => ({ dimension,
        anchors: [], observation: '', decision: 'unresolved', reason: '', retainCounterexample: '' })),
      patterns: [], patternsReason: '', voice: { status: 'unavailable', anchors: [], preserve: '', avoidCopying: '', reason: '' },
      feedback: evidence.reports.flatMap(report => report.comments.map((_comment, commentIndex) => ({
        reportId: report.id, commentIndex, scope: scopes.find(scope => scope.reportId === report.id)!.scope,
        anchors: [], hypothesis: '', qualityDecision: 'unresolved', reason: '', retainCounterexample: ''
      }))), feedbackReason: '',
      protectedChoices: paragraphs.slice(0, 1).map(anchor => ({ anchor, reason: '', source: 'author' })),
      overall: { status: 'unresolved', reason: '' }, recommendation: 'rework'
    },
    containsDocumentText: true, requiresHumanReview: true, evidenceAuthenticityVerified: false, deliveryAuthorized: false
  };
}
export async function reviewStyle(policyRoot: string, path: string, raw: unknown, rawEvidence?: unknown) {
  const s = await loadSession(policyRoot, path), evidence = evidenceValue(rawEvidence);
  const record = styleReviewSchema.parse(raw), bound = bindings(s, evidence);
  if (hashValue(record.bindings) !== hashValue(bound))
    fail('style-review-stale', 'Prepare a style review for the current session, version, original, context, policy and evidence.');
  const paragraphs = logicalParagraphAnchors(s.document), scopes = reportScopes(bound.documentHash, evidence);
  const expected = new Set(paragraphs.map(anchor => hashValue(anchor))), seen = new Set<string>();
  let referenceCount = 0;
  const check = (span: ReviewSpan) => { substantiveSpan(span, s.document, 'style-review-span'); referenceCount++; };
  for (const paragraph of record.paragraphs) {
    check(paragraph.anchor);
    const key = hashValue(paragraph.anchor);
    if (!expected.has(key) || seen.has(key))
      fail('style-review-paragraphs', 'Review each exact logical paragraph once, without overlap, duplication or omission.');
    seen.add(key);
  }
  if (seen.size !== expected.size)
    fail('style-review-paragraphs', 'Review each exact logical paragraph once, without overlap, duplication or omission.');
  for (const pattern of record.patterns) pattern.anchors.forEach(check);
  const languageDimensions = new Set(record.languageChecks.map(item => item.dimension));
  if (languageDimensions.size !== LANGUAGE_REVIEW_DIMENSIONS.length)
    fail('style-review-language', 'Review every language dimension once, without duplication or omission.');
  for (const item of record.languageChecks) item.anchors.forEach(check);
  if (record.voice.status === 'available' && record.voice.anchors.length === 0)
    fail('style-review-voice', 'An available reference requires an exact comparison anchor.');
  if (record.voice.status === 'unavailable' && record.voice.anchors.length !== 0)
    fail('style-review-voice', 'Use unavailable only when no reference comparison is recorded.');
  for (const item of record.voice.anchors) {
    check(item.candidate);
    const reference = evidence.references.find(reference => reference.id === item.reference.referenceId);
    if (!reference) fail('style-review-reference', 'Use a reference from the bound evidence.');
    substantiveSpan(item.reference.span, reference.document, 'style-review-reference'); referenceCount++;
  }
  const expectedComments = new Set(evidence.reports.flatMap(report => report.comments.map((_comment, i) => report.id + ':' + i)));
  const seenComments = new Set<string>();
  for (const item of record.feedback) {
    const key = item.reportId + ':' + item.commentIndex;
    if (!expectedComments.has(key) || seenComments.has(key))
      fail('style-review-feedback', 'Address each bound report comment exactly once.');
    if (scopes.find(scope => scope.reportId === item.reportId)?.scope !== item.scope)
      fail('style-review-scope', 'Use the scope computed from the exact tested snapshot, not an asserted current result.');
    seenComments.add(key); item.anchors.forEach(check);
  }
  if (seenComments.size !== expectedComments.size)
    fail('style-review-feedback', 'Address each bound report comment exactly once.');
  record.protectedChoices.forEach(choice => check(choice.anchor));
  const rework = {
    paragraphs: record.paragraphs.flatMap((item, i) => item.status !== 'distinct' ? [i + 1] : []),
    patterns: record.patterns.flatMap((item, i) => item.assessment !== 'retain' ? [i + 1] : []),
    languageChecks: record.languageChecks.filter(item => item.decision !== 'retain').map(item => item.dimension),
    voice: record.voice.status === 'unresolved',
    feedback: record.feedback.flatMap((item, i) => item.qualityDecision !== 'retain' ? [i + 1] : []),
    overall: record.overall.status !== 'retain', recommendation: record.recommendation !== 'adopt'
  };
  const needsRework = Object.values(rework).some(value => Array.isArray(value) ? value.length > 0 : value);
  return {
    schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings: bound, recordHash: hashValue(record),
    reviewDecision: needsRework ? 'needs-rework' : 'recorded', rework, reportScopes: scopes,
    referencesVerified: true, paragraphCoverageVerified: true, referenceCount,
    paragraphCount: record.paragraphs.length, patternCount: record.patterns.length, voiceComparisonCount: record.voice.anchors.length,
    feedbackCount: record.feedback.length, protectedChoiceCount: record.protectedChoices.length, reviewerRole: 'agent',
    languageDimensionCount: record.languageChecks.length,
    containsDocumentText: false, requiresHumanReview: true, semanticEquivalenceChecked: false, voiceCertified: false,
    evidenceAuthenticityVerified: false, detectorReplicated: false, independentReaderVerified: false, deliveryAuthorized: false
  };
}
