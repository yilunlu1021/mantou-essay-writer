import { z } from 'zod';
import { documentSchema, hashValue, type TextDocument } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { logicalParagraphAnchors, prepareStyleReview, type StyleEvidence } from './style-review.js';
import { reviewSpanSchema, reviewNoteSchema, validateReviewSpan } from './source-review.js';
import { getFeedbackTaxonomy, feedbackCategoryIdSchema, FEEDBACK_TAXONOMY_VERSION } from './feedback-taxonomy.js';
import { fail } from './files.js';
import { compressionCheckSchema, locateConstructionCues, type ConstructionComponent, type ConstructionCue } from './construction-review.js';

export const LINGUISTIC_ENGINE_VERSION = '1.1.0';
const note = reviewNoteSchema;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
type Span = z.infer<typeof reviewSpanSchema>;
type Category = z.infer<typeof feedbackCategoryIdSchema>;
type Sentence = { anchor: Span; paragraphIndex: number; words: string[] };
const flags = { automaticRewrite: false, fullSyntacticParse: false, referenceResolutionCertified: false,
  voiceCertified: false, detectorReplicated: false, deliveryAuthorized: false } as const;
const stopwords = new Set('a an the i me my we our they their he his she her it its this that these those to of on in at for and or but so as with had have has was were is are be been by would could should'.split(' '));
const genericHeads = '(?:thing|things|person|people|someone|something|problem|question|experience|reason|way|method|approach|situation|process|exchange)';

// Segmenter locates text boundaries; the patterns below are review cues, not a parser or semantic verdict.
function offsetMap(text: string) {
  const result = new Uint32Array(text.length + 1);
  let units = 0, points = 0;
  for (const character of text) {
    result[units] = points;
    if (character.length === 2) result[units + 1] = points;
    units += character.length; points++; result[units] = points;
  }
  return result;
}
function sentences(document: TextDocument): Sentence[] {
  const result: Sentence[] = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  for (const [paragraphIndex, paragraph] of logicalParagraphAnchors(document).entries()) {
    const offsets = offsetMap(paragraph.quote);
    for (const segment of segmenter.segment(paragraph.quote)) {
        const leading = segment.segment.length - segment.segment.trimStart().length;
        const value = segment.segment.trim();
        if (!value) continue;
        const begin = segment.index + leading;
        const anchor = { blockId: paragraph.blockId, start: paragraph.start + offsets[begin]!, end: paragraph.start + offsets[begin + value.length]!, quote: value };
        result.push({ anchor, paragraphIndex, words: Array.from(value.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/gu), match => match[0].toLowerCase()) });
    }
  }
  return result;
}
function overlap(a: string[], b: string[]) {
  const x = new Set(a.filter(word => word.length > 2 && !stopwords.has(word)));
  const y = new Set(b.filter(word => word.length > 2 && !stopwords.has(word)));
  const shared = [...x].filter(word => y.has(word));
  return { shared, coefficient: Math.min(x.size, y.size) ? shared.length / Math.min(x.size, y.size) : 0 };
}
const prompts: Record<Category, { question: string; counterexample: string }> = {
  'reference-recoverability': { question: 'Can the reader identify this referent from the prior text, its modifier, the source or shared context? Record the actual antecedent or explain a first introduction.',
    counterexample: 'An indefinite article can introduce a concrete object. A definite article can be licensed by a restrictive modifier without an earlier mention.' },
  'narrative-viewpoint': { question: 'Who perceives, knows or judges this claim, and what source supports that access? Separate the author experience from an editor assessment or another person thoughts.',
    counterexample: 'An observable action with a third-person subject can remain within a first-person narrative. Do not add an invented I saw or I heard.' },
  'predicate-focus': { question: 'Does the intention or cognition frame carry a real desire or change, or delay the concrete action and its object?',
    counterexample: 'A source-supported desire to ask a named person about a particular object can be the central action.' },
  'clause-attachment': { question: 'What does this clause attach to, who controls its subject, and which time, condition, restriction or new information does it contribute?',
    counterexample: 'Necessary subordinate and non-finite clauses preserve genuine time, cause and identification. A cue does not prove the full parse.' },
  'discourse-linking': { question: 'Does the connector express the supported relation? Distinguish chronology from cause and a meaningful transition from an activity list.',
    counterexample: 'Before, after and while can supply essential temporal information and must not become banned words.' },
  'register-fit': { question: 'Are these terms and nominal expressions necessary for the actual operation and suitable for this author and audience?',
    counterexample: 'A genuine technical method name and an ordinary action verb may be the clearest choices. Precision is not an error.' },
  'cadence-pattern': { question: 'Do the adjacent structures perform different work or repeat the same explanation? Read them continuously before changing syntax.',
    counterexample: 'Parallel conditions can establish a real comparison. Consecutive first-person actions and short sentences can advance a story.' },
  'information-gain': { question: 'What new event, evidence, choice, restriction or consequence does this sentence add? Lexical overlap alone does not establish redundancy.',
    counterexample: 'Repeated names can preserve reference, and two sentences on one subject can provide different information.' },
  'evidence-scope': { question: 'What bounds this generalization, mental claim or causal assertion? Compare its strength and time with the supplied source.',
    counterexample: 'Every test I ran is a bounded observation. Never or always in an authentic personal judgment is not automatically wrong.' }
};

export function analyseEnglishDocument(raw: TextDocument) {
  const document = documentSchema.parse(raw), units = sentences(document);
  const candidates: { id: string; categoryId: Category; code: string; anchor: Span; related: Span[];
    observedCue: string; reviewQuestion: string; retainCounterexample: string; decision: 'unresolved';
    requiresCompressionCheck: boolean; components: ConstructionComponent[]; featureLabels: string[] }[] = [];
  const seen = new Set<string>();
  function add(sentence: Sentence, categoryId: Category, code: string, cue: string, related: Span[] = [], construction?: ConstructionCue) {
    const id = hashValue({ engine: LINGUISTIC_ENGINE_VERSION, categoryId, code, anchor: sentence.anchor, related,
      ...(construction ? { components: construction.components } : {}) });
    if (seen.has(id)) return;
    if (candidates.length >= 2000) fail('linguistic-candidate-limit', 'Review a smaller document instead of silently truncating linguistic candidates.');
    seen.add(id); candidates.push({ id, categoryId, code, anchor: sentence.anchor, related,
      observedCue: cue, reviewQuestion: construction?.reviewQuestion ?? prompts[categoryId].question,
      retainCounterexample: construction?.retainCounterexample ?? prompts[categoryId].counterexample, decision: 'unresolved',
      requiresCompressionCheck: construction?.requiresCompressionCheck ?? false,
      components: construction?.components ?? [], featureLabels: construction?.featureLabels ?? [] });
  }
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!, text = unit.anchor.quote;
    const previous = units[index - 1];
    const previousAnchors = units.slice(Math.max(0, index - 2), index).map(item => item.anchor);
    for (const construction of locateConstructionCues(unit.anchor))
      add(unit, 'information-gain', construction.code, construction.observedCue, previousAnchors, construction);
    const references = text.match(new RegExp('\\b(?:this|that|these|those)\\s+' + genericHeads + '\\b|\\b(?:a|an|the)\\s+' + genericHeads + '\\b', 'giu'));
    if (references) add(unit, 'reference-recoverability', 'referent-identifiability', references.join(' | '), previousAnchors);
    if (/\b(?:it|they|them|their|its)\b/iu.test(text))
      add(unit, 'reference-recoverability', 'pronominal-reference', 'A pronoun or possessive has a discourse referent to verify.', previousAnchors);
    if (/\b(?:he|she|they|everyone|students|friends|[A-Z][a-z]+)\s+(?:felt|wanted|knew|believed|realized|understood|feared|worried)\b/u.test(text))
      add(unit, 'narrative-viewpoint', 'knowledge-attribution', 'A possible other-person mental-state attribution needs its actual source.');
    if (/\b(?:came naturally to me|showed my|demonstrated my|proved that I|I (?:was|am) the kind of)\b/iu.test(text))
      add(unit, 'narrative-viewpoint', 'editorial-characterization', 'A character assessment may be replacing the author actual choices.');
    if (/\bI\s+(?:wanted|learned|realized|understood|hoped|was able)\b/iu.test(text))
      add(unit, 'predicate-focus', 'intention-cognition-frame', 'An intention, ability or cognition frame is present.');
    if (/^(?:Before|After|While|When|Although|If|Once)\b/u.test(text)) {
      add(unit, 'clause-attachment', 'initial-subordinator-cue', 'Initial subordinate or temporal construction; exact function requires reading.');
      add(unit, 'discourse-linking', 'temporal-conditional-link', 'An overt temporal or conditional relation must match the source.', previousAnchors);
    }
    if (/\b(?:which|whose|where|why)\b|\bso (?:that )?(?:I|we|they|students|contestants)\b/iu.test(text))
      add(unit, 'clause-attachment', 'embedded-attachment-cue', 'A relative, interrogative, locative or purpose cue is present; attachment is unparsed.');
    const nominalCues = text.match(/\b[A-Za-z]{4,}(?:tion|sion|ment|ness|ity)\b/gu) ?? [];
    if (nominalCues.length >= 3)
      add(unit, 'register-fit', 'nominal-density-cue', 'Suffix cues to nominal wording: ' + nominalCues.join(', ') + '. These are not POS tags or a quality score.');
    if (/\b(?:algorithm|programming|curriculum|examination)\b/iu.test(text))
      add(unit, 'register-fit', 'domain-term-retention', 'A domain term is present; verify necessity and protect accurate terminology.');
    if (/\b(?:always|never|everyone|nobody|every|all)\b/iu.test(text))
      add(unit, 'evidence-scope', 'scope-quantifier', 'A scope expression needs its stated domain, source and author judgment.');
    if (previous && previous.paragraphIndex === unit.paragraphIndex) {
      const lead = (value: string) => value.match(/^(?:If I|I wanted|I learned|I could|I had|I built|I added)\b/u)?.[0];
      if (lead(text) && lead(text) === lead(previous.anchor.quote))
        add(unit, 'cadence-pattern', 'adjacent-parallel-frame', 'The neighboring sentences begin with the same frame.', [previous.anchor]);
      const shared = overlap(previous.words, unit.words);
      if (shared.shared.length >= 4 && shared.coefficient >= 0.65)
        add(unit, 'information-gain', 'lexical-overlap-cue', 'Shared content tokens: ' + shared.shared.join(', ') + '. Check information functions rather than deleting repeated names.', [previous.anchor]);
    }
  }
  return { engineVersion: LINGUISTIC_ENGINE_VERSION, language: 'en' as const, documentHash: hashValue(document),
    sentences: units.map(unit => ({ anchor: unit.anchor, paragraphIndex: unit.paragraphIndex, wordTokens: unit.words.length })),
    candidates, candidateCount: candidates.length, ...flags };
}

const bindingsSchema = z.object({
  sessionHash: digest, versionHash: digest, originalHash: digest, documentHash: digest, contextHash: digest,
  policyHash: digest, evidenceHash: digest, taxonomyHash: digest, engineVersion: z.enum(['1.0.0', LINGUISTIC_ENGINE_VERSION])
}).strict();
const role = z.enum(['event', 'context', 'goal', 'obstacle', 'choice', 'action', 'outcome', 'reflection']);
export const linguisticReviewSchema = z.object({
  schemaVersion: z.literal('1.0.0'), bindings: bindingsSchema, reviewerRole: z.literal('agent'),
  decisions: z.array(z.object({
    candidateId: digest, categoryId: feedbackCategoryIdSchema,
    decision: z.enum(['retain', 'revise', 'needs-source', 'unresolved']),
    linguisticObservation: note, informationFunction: role,
    sourceBasis: z.enum(['supplied-source', 'author-judgment', 'editorial-hypothesis', 'needs-source']),
    originalAnchors: z.array(reviewSpanSchema).max(100),
    referents: z.array(z.object({ mention: reviewSpanSchema, antecedents: z.array(reviewSpanSchema).max(20),
      identifiability: z.enum(['prior-mention', 'modifier', 'source-context', 'first-introduction', 'unresolved']),
      reason: note }).strict()).max(100),
    perspective: z.enum(['author-experience', 'author-retrospective', 'reported-other', 'observable-action', 'not-applicable', 'unresolved']),
    clauseFunction: z.enum(['time', 'condition', 'cause', 'purpose', 'restriction', 'complement', 'supplement', 'not-applicable', 'unresolved']),
    reason: note, preserveCounterexample: note,
    editObjective: note.optional(), compressionCheck: compressionCheckSchema.optional()
  }).strict()).max(2000),
  paragraphs: z.array(z.object({ anchor: reviewSpanSchema, role, informationIncrement: note,
    authorAccess: note, status: z.enum(['retain', 'revise', 'needs-source', 'unresolved']) }).strict()).max(5000),
  feedbackAssessments: z.array(z.object({ reportId: z.string().min(1), commentIndex: z.number().int().nonnegative(),
    scope: z.enum(['current', 'historical']),
    assessment: z.enum(['not-reviewed', 'plausible', 'unsupported', 'misdescribed', 'unassessable']),
    categoryIds: z.array(feedbackCategoryIdSchema).max(9), linguisticReason: note, retainCounterexample: note
  }).strict()).max(10000),
  overall: z.object({ decision: z.enum(['retain', 'revise', 'needs-source', 'unresolved']), reason: note }).strict()
}).strict();

export async function prepareLinguisticReview(policyRoot: string, path: string, rawEvidence?: StyleEvidence) {
  const session = await loadSession(policyRoot, path);
  if (session.manifest.context.language !== 'en')
    fail('linguistic-language', 'This linguistic preparation currently supports English only.');
  const style = await prepareStyleReview(policyRoot, path, rawEvidence);
  const taxonomy = getFeedbackTaxonomy();
  const analysis = analyseEnglishDocument(session.document);
  const bindings = { ...style.bindings, taxonomyHash: hashValue(taxonomy), engineVersion: LINGUISTIC_ENGINE_VERSION };
  const evidenceChecks = style.evidence.reports.flatMap(report => report.comments.map((comment, commentIndex) => ({
    reportId: report.id, commentIndex, scope: style.reportScopes.find(scope => scope.reportId === report.id)!.scope,
    originalTags: comment.featureTags, originalExplanation: comment.explanation,
    anchor: comment.anchor, assessment: 'not-reviewed' as const,
    question: 'Assess the supplied explanation separately. A label is not a grammatical diagnosis or a reason to revise.'
  })));
  return {
    schemaVersion: '1.0.0', taxonomyVersion: FEEDBACK_TAXONOMY_VERSION, bindings, context: session.manifest.context,
    analysis, original: session.original, paragraphs: style.paragraphs, evidenceChecks, references: style.evidence.references,
    instructions: [
      'These transparent surface cues locate review questions. They neither parse all syntax nor resolve reference, intent or authorship.',
      'Read every paragraph and its source. Separate definiteness, specificity and recoverability. Never replace a/an with the without the required reference.',
      'Locate who perceives, knows or judges each claim. Third-person actions can be narrated by the author; adding I does not validate an outside assessment.',
      'Assign clause functions and information roles from context, preserving actual time, cause, restrictions, terminology and direct author judgments.',
      'Record an explicit decision, exact original anchors where relevant, actual referents, a linguistic observation and a retention counterexample for every candidate.',
      'For required construction candidates, compare a direct alternative or deletion, information loss and paragraph context. Grammar and source validity alone do not establish natural expression.',
      'Use exact declared reference spans to compare relevant choices, or explain unavailable references. Reference labels do not certify authorship or transfer their facts to this author.',
      'A proposed change requires an edit objective. Apply real edits only through the current version patch template, then repeat all required reviews.',
      'Review every exact logical paragraph. Explicit revise, needs-source and unresolved items require further work; a clean record does not certify semantic or voice quality.',
      'Keep raw detector explanations separate from your assessment. Historical screenshots cannot establish the current draft label or improvement.',
      'This command is read-only and makes no network request, database mutation or automatic text replacement.'
    ],
    template: { schemaVersion: '1.0.0', bindings, reviewerRole: 'agent',
      decisions: analysis.candidates.map(candidate => ({ candidateId: candidate.id, categoryId: candidate.categoryId,
        decision: 'unresolved', linguisticObservation: '', informationFunction: 'context', sourceBasis: 'needs-source',
        originalAnchors: [], referents: [], perspective: 'unresolved', clauseFunction: 'unresolved', reason: '', preserveCounterexample: '',
        ...(candidate.requiresCompressionCheck ? { compressionCheck: { alternative: '', complementRole: 'unresolved',
          informationLost: '', contextReason: '', choice: 'unresolved', reason: '', referenceStatus: 'unavailable', references: [], referenceReason: '' } } : {}) })),
      paragraphs: style.paragraphs.map(anchor => ({ anchor, role: 'context', informationIncrement: '', authorAccess: '', status: 'unresolved' })),
      feedbackAssessments: evidenceChecks.map(item => ({ reportId: item.reportId, commentIndex: item.commentIndex,
        scope: item.scope, assessment: 'not-reviewed', categoryIds: [], linguisticReason: '', retainCounterexample: '' })),
      overall: { decision: 'unresolved', reason: '' } },
    containsDocumentText: true, requiresHumanReview: true, ...flags
  };
}

export async function reviewLinguistic(policyRoot: string, path: string, raw: unknown, evidence?: StyleEvidence) {
  const prepared = await prepareLinguisticReview(policyRoot, path, evidence);
  const record = linguisticReviewSchema.parse(raw);
  if (hashValue(record.bindings) !== hashValue(prepared.bindings))
    fail('linguistic-review-stale', 'Prepare for the current version, original, policy, evidence and taxonomy.');
  const session = await loadSession(policyRoot, path);
  const candidates = new Map(prepared.analysis.candidates.map(item => [item.id, item]));
  const seen = new Set<string>();
  let referenceCount = 0;
  const current = (span: Span) => { validateReviewSpan(span, session.document.blocks, 'linguistic-current-span'); referenceCount++; };
  const original = (span: Span) => { validateReviewSpan(span, session.original.blocks, 'linguistic-original-span'); referenceCount++; };
  for (const decision of record.decisions) {
    const candidate = candidates.get(decision.candidateId);
    if (!candidate || seen.has(decision.candidateId) || decision.categoryId !== candidate.categoryId)
      fail('linguistic-review-candidate', 'Address each current candidate exactly once with its actual category.');
    seen.add(decision.candidateId);
    if (candidate.requiresCompressionCheck && !decision.compressionCheck)
      fail('linguistic-review-compression', 'Compare a direct alternative or deletion for each construction that requires a compression check.');
    for (const comparison of decision.compressionCheck?.references ?? []) {
      const reference = prepared.references.find(item => item.id === comparison.referenceId);
      if (!reference) fail('linguistic-review-compression-reference', 'Use a declared reference from the current bound evidence.');
      validateReviewSpan(comparison.span, reference.document.blocks, 'linguistic-review-compression-reference');
      referenceCount++;
    }
    decision.originalAnchors.forEach(original);
    for (const referent of decision.referents) {
      current(referent.mention); referent.antecedents.forEach(current);
      if (referent.mention.blockId !== candidate.anchor.blockId || referent.mention.start < candidate.anchor.start ||
          referent.mention.end > candidate.anchor.end)
        fail('linguistic-review-reference', 'The reviewed mention must occur within its actual candidate sentence.');
      if (referent.identifiability === 'prior-mention') {
        const mentionBlock = session.document.blocks.findIndex(block => block.id === referent.mention.blockId);
        if (referent.antecedents.length === 0 || referent.antecedents.some(antecedent => {
          const antecedentBlock = session.document.blocks.findIndex(block => block.id === antecedent.blockId);
          return antecedentBlock > mentionBlock || (antecedentBlock === mentionBlock && antecedent.end > referent.mention.start);
        })) fail('linguistic-review-reference', 'A prior mention requires an earlier exact antecedent.');
      }
    }
    if (decision.categoryId === 'reference-recoverability' && decision.referents.length === 0)
      fail('linguistic-review-reference', 'Record the actual mention and how its referent is identified, including first introduction.');
    if (decision.decision === 'revise' && !decision.editObjective)
      fail('linguistic-review-objective', 'State what the revision must accomplish before applying a version patch.');
    if (decision.sourceBasis === 'supplied-source' && decision.originalAnchors.length === 0)
      fail('linguistic-review-source', 'A supplied-source claim requires exact original anchors.');
  }
  if (seen.size !== candidates.size) fail('linguistic-review-coverage', 'Address all candidates; explicit limits do not permit silent omission.');
  const expected = new Set(prepared.paragraphs.map(anchor => hashValue(anchor))), paragraphsSeen = new Set<string>();
  for (const paragraph of record.paragraphs) {
    current(paragraph.anchor); const id = hashValue(paragraph.anchor);
    if (!expected.has(id) || paragraphsSeen.has(id)) fail('linguistic-review-paragraphs', 'Review each exact logical paragraph once.');
    paragraphsSeen.add(id);
  }
  if (paragraphsSeen.size !== expected.size) fail('linguistic-review-paragraphs', 'Review all logical paragraphs.');
  const expectedFeedback = new Map(prepared.evidenceChecks.map(item => [item.reportId + ':' + item.commentIndex, item]));
  const feedbackSeen = new Set<string>();
  for (const assessment of record.feedbackAssessments) {
    const id = assessment.reportId + ':' + assessment.commentIndex;
    const expectedItem = expectedFeedback.get(id);
    if (!expectedItem || feedbackSeen.has(id) || expectedItem.scope !== assessment.scope)
      fail('linguistic-review-feedback', 'Assess every supplied comment once with its actual tested-version scope.');
    if (new Set(assessment.categoryIds).size !== assessment.categoryIds.length)
      fail('linguistic-review-feedback', 'Use each linguistic category once per assessment.');
    feedbackSeen.add(id);
  }
  if (feedbackSeen.size !== expectedFeedback.size)
    fail('linguistic-review-feedback', 'Do not omit expanded or collapsed source observations.');
  const rework = {
    candidates: record.decisions.filter(item => item.decision !== 'retain' || item.sourceBasis === 'needs-source' ||
      item.perspective === 'unresolved' || item.clauseFunction === 'unresolved' ||
      (item.compressionCheck && (item.compressionCheck.choice !== 'retain-current' || item.compressionCheck.complementRole === 'unresolved')) ||
      item.referents.some(referent => referent.identifiability === 'unresolved')).map(item => item.candidateId),
    paragraphs: record.paragraphs.flatMap((item, index) => item.status === 'retain' ? [] : [index]),
    feedback: record.feedbackAssessments.flatMap((item, index) => item.assessment === 'not-reviewed' ? [index] : []),
    overall: record.overall.decision !== 'retain'
  };
  return { schemaVersion: '1.0.0', bindings: prepared.bindings, recordHash: hashValue(record),
    reviewDecision: rework.candidates.length || rework.paragraphs.length || rework.feedback.length || rework.overall ? 'needs-rework' : 'recorded',
    rework, candidateCoverageVerified: true, paragraphCoverageVerified: true, referenceCount,
    judgmentsVerified: false, evidenceAuthenticityVerified: false, containsDocumentText: false,
    requiresHumanReview: true, ...flags };
}
