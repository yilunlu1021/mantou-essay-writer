import { z } from 'zod';
import { documentSchema, hashValue, type TextDocument } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { fail } from './files.js';
import { logicalParagraphAnchors } from './style-review.js';
import { HUMANIER_METHOD_VERSION, reviewBindingsSchema, reviewBindings, reviewSpanSchema,
  reviewNoteSchema, type ReviewSpan } from './source-review.js';

export const DISCOURSE_ENGINE_VERSION = '1.0.0' as const;
const note = reviewNoteSchema;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decision = z.enum(['retain', 'revise', 'needs-source', 'unresolved']);
const choice = z.enum(['retain', 'prefer-alternative', 'unresolved']);
const bindingsSchema = reviewBindingsSchema.extend({ engineVersion: z.string().min(1) }).strict();
export const discourseReviewSchema = z.object({
  schemaVersion: z.literal('1.0.0'), methodVersion: z.literal(HUMANIER_METHOD_VERSION),
  bindings: bindingsSchema, reviewerRole: z.literal('agent'),
  windows: z.array(z.object({
    windowId: digest,
    sentences: z.array(z.object({ anchor: reviewSpanSchema, informationGain: note }).strict()).min(1).max(3),
    readerConnection: note,
    alternative: z.object({ kind: z.enum(['deletion', 'merge']), text: note,
      informationLost: note, choice, reason: note }).strict(),
    decision, reason: note
  }).strict()).max(10000),
  transitions: z.array(z.object({
    transitionId: digest, from: reviewSpanSchema, to: reviewSpanSchema,
    relation: z.enum(['cause', 'chronology', 'comparison', 'support', 'purpose', 'continuation', 'topic-shift', 'mixed']),
    connection: z.enum(['explicit', 'recoverable', 'missing', 'unresolved']),
    readerParaphrase: note, sourceLimit: note, commonBasis: note.optional(), decision, reason: note
  }).strict()).max(5000),
  order: z.object({ currentOrder: z.array(digest).max(5000), alternativeOrder: z.array(digest).max(5000),
    currentOrderReason: note, alternativeOrderReason: note, sourceLimit: note, choice, decision, reason: note }).strict(),
  recommendation: z.enum(['adopt', 'rework'])
}).strict();

const flags = { syntacticParseCertified: false, semanticEquivalenceChecked: false, judgmentsVerified: false, reasoningCertified: false,
  independentReaderVerified: false, voiceCertified: false, detectorReplicated: false, automaticRewrite: false, deliveryAuthorized: false } as const;

// Segmenter uses UTF-16 indices. Stored spans always use Unicode codepoints, without normalizing CRLF.
function codepointOffsets(text: string) {
  const offsets = new Uint32Array(text.length + 1);
  let units = 0, points = 0;
  for (const character of text) {
    offsets[units] = points;
    if (character.length === 2) offsets[units + 1] = points;
    units += character.length; points++; offsets[units] = points;
  }
  return offsets;
}
export function analyseDiscourseDocument(raw: TextDocument, language: 'en' | 'zh' | 'mixed' = 'en') {
  const document = documentSchema.parse(raw);
  const paragraphs = logicalParagraphAnchors(document).map(anchor => ({
    id: hashValue({ engineVersion: DISCOURSE_ENGINE_VERSION, kind: 'paragraph', anchor }), anchor
  }));
  if (paragraphs.length > 5000) fail('discourse-review-limit', 'Review a smaller document instead of truncating paragraphs.');
  const sentences: { id: string; paragraphId: string; anchor: ReviewSpan }[] = [];
  const segmenter = new Intl.Segmenter(language === 'zh' ? 'zh' : 'en', { granularity: 'sentence' });
  for (const paragraph of paragraphs) {
    const offsets = codepointOffsets(paragraph.anchor.quote);
    for (const segment of segmenter.segment(paragraph.anchor.quote)) {
      const quote = segment.segment.trim();
      if (!quote) continue;
      const start = segment.index + segment.segment.length - segment.segment.trimStart().length;
      const anchor = { blockId: paragraph.anchor.blockId, start: paragraph.anchor.start + offsets[start]!,
        end: paragraph.anchor.start + offsets[start + quote.length]!, quote };
      sentences.push({ id: hashValue({ engineVersion: DISCOURSE_ENGINE_VERSION, kind: 'sentence', anchor }),
        paragraphId: paragraph.id, anchor });
    }
  }
  if (sentences.length > 10002) fail('discourse-review-limit', 'Review a smaller document instead of truncating sentence windows.');
  const windows: { id: string; sentences: ReviewSpan[] }[] = [];
  const width = Math.min(3, sentences.length);
  if (width) for (let index = 0; index <= sentences.length - width; index++) {
    const anchors = sentences.slice(index, index + width).map(sentence => sentence.anchor);
    windows.push({ id: hashValue({ engineVersion: DISCOURSE_ENGINE_VERSION, kind: 'window', sentences: anchors }), sentences: anchors });
  }
  const transitions = paragraphs.slice(1).map((paragraph, index) => {
    const from = paragraphs[index]!.anchor, to = paragraph.anchor;
    return { id: hashValue({ engineVersion: DISCOURSE_ENGINE_VERSION, kind: 'transition', from, to }), from, to };
  });
  return { engineVersion: DISCOURSE_ENGINE_VERSION, documentHash: hashValue(document), paragraphs, sentences, windows, transitions, ...flags };
}

export async function prepareDiscourseReview(policyRoot: string, path: string) {
  const session = await loadSession(policyRoot, path);
  const analysis = analyseDiscourseDocument(session.document, session.manifest.context.language);
  const bindings = { ...reviewBindings(session), engineVersion: DISCOURSE_ENGINE_VERSION };
  const currentOrder = analysis.paragraphs.map(paragraph => paragraph.id);
  return {
    schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings,
    context: session.manifest.context, original: session.original, document: session.document, analysis,
    instructions: [
      'Read the current prepare, prompt and supplied source. Read each contiguous three-sentence window in order, including windows crossing paragraph or block boundaries. A shorter document uses all its available sentences.',
      'For every exact sentence, explain its information gain and what connection the reader can actually recover. Compare a concrete deletion or merge, the facts or voice it would lose, and the contextual reason to retain or replace it.',
      'Review every adjacent logical paragraph transition with its exact full anchors. Distinguish cause, chronology, comparison, support, purpose, continuation and topic shift. A sequence is not necessarily a cause.',
      'Paraphrase the relationship the current text gives the reader and state its source limit. Comparisons require an explicit common basis. For mixed relations, state any comparison basis or explicitly explain that no comparison is included. A missing connection must remain marked missing until the text or source resolves it.',
      'Compare the current paragraph order with a genuine alternative permutation. For one or no paragraphs the only possible order may be repeated. Do not impose linear chronology or a generic growth story.',
      'Keep useful plain statements, subordinate clauses, repetition and temporal connectors when they supply information. No sentence-length, subject or grammar quota is applied.',
      'Save this incomplete template outside immutable session folders. Apply actual revisions only through the current patch template, then prepare and review the new version.',
      'This read-only command validates coverage, exact references, binding and explicit decisions. It cannot certify free-text reasons, source truth, independent reading, natural voice, detector results or submission approval.'
    ],
    template: { schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings, reviewerRole: 'agent',
      windows: analysis.windows.map(window => ({ windowId: window.id,
        sentences: window.sentences.map(anchor => ({ anchor, informationGain: '' })), readerConnection: '',
        alternative: { kind: 'deletion', text: '', informationLost: '', choice: 'unresolved', reason: '' },
        decision: 'unresolved', reason: '' })),
      transitions: analysis.transitions.map(transition => ({ transitionId: transition.id, from: transition.from, to: transition.to,
        relation: 'topic-shift', connection: 'unresolved', readerParaphrase: '', sourceLimit: '', decision: 'unresolved', reason: '' })),
      order: { currentOrder, alternativeOrder: [...currentOrder], currentOrderReason: '', alternativeOrderReason: '',
        sourceLimit: '', choice: 'unresolved', decision: 'unresolved', reason: '' }, recommendation: 'rework' },
    containsDocumentText: true, requiresHumanReview: true, ...flags
  };
}

export async function reviewDiscourse(policyRoot: string, path: string, raw: unknown) {
  const prepared = await prepareDiscourseReview(policyRoot, path);
  const record = discourseReviewSchema.parse(raw);
  if (hashValue(record.bindings) !== hashValue(prepared.bindings))
    fail('discourse-review-stale', 'Prepare for the current original, version, document, context, policy and discourse engine.');
  const exact = (actual: unknown, expected: unknown, code: string, hint: string) => {
    if (hashValue(actual) !== hashValue(expected)) fail(code, hint);
  };
  if (record.windows.length !== prepared.analysis.windows.length)
    fail('discourse-review-windows', 'Cover every current contiguous sentence window exactly once in order.');
  record.windows.forEach((window, index) => {
    const expected = prepared.analysis.windows[index]!;
    exact({ id: window.windowId, sentences: window.sentences.map(sentence => sentence.anchor) }, expected,
      'discourse-review-windows', 'Use the exact current window IDs, sentence spans and order without duplicates.');
  });
  if (record.transitions.length !== prepared.analysis.transitions.length)
    fail('discourse-review-transitions', 'Cover every adjacent logical paragraph boundary exactly once in order.');
  record.transitions.forEach((transition, index) => {
    const expected = prepared.analysis.transitions[index]!;
    exact({ id: transition.transitionId, from: transition.from, to: transition.to }, expected,
      'discourse-review-transitions', 'Use the exact current adjacent paragraph IDs, full spans and order.');
    if (['comparison', 'mixed'].includes(transition.relation) && !transition.commonBasis)
      fail('discourse-review-comparison', 'State the common basis for an actual comparison.');
  });
  const currentOrder = prepared.analysis.paragraphs.map(paragraph => paragraph.id);
  exact(record.order.currentOrder, currentOrder, 'discourse-review-order', 'Use the complete current logical paragraph order.');
  if (record.order.alternativeOrder.length !== currentOrder.length ||
      new Set(record.order.alternativeOrder).size !== currentOrder.length ||
      record.order.alternativeOrder.some(id => !currentOrder.includes(id)))
    fail('discourse-review-order', 'Compare a complete alternative permutation without missing, unknown or duplicate paragraphs.');
  if (currentOrder.length > 1 && hashValue(record.order.alternativeOrder) === hashValue(currentOrder))
    fail('discourse-review-order', 'Compare a different paragraph order before deciding to retain the current one.');
  const rework = {
    windows: record.windows.flatMap((window, index) => window.decision !== 'retain' || window.alternative.choice !== 'retain' ? [index + 1] : []),
    transitions: record.transitions.flatMap((transition, index) => transition.decision !== 'retain' ||
      transition.connection === 'missing' || transition.connection === 'unresolved' ? [index + 1] : []),
    order: record.order.decision !== 'retain' || record.order.choice !== 'retain',
    recommendation: record.recommendation !== 'adopt'
  };
  const needsRework = rework.windows.length > 0 || rework.transitions.length > 0 || rework.order || rework.recommendation;
  return { schemaVersion: '1.0.0', methodVersion: HUMANIER_METHOD_VERSION, bindings: prepared.bindings,
    recordHash: hashValue(record), reviewDecision: needsRework ? 'needs-rework' : 'recorded', rework,
    paragraphCount: prepared.analysis.paragraphs.length, sentenceCount: prepared.analysis.sentences.length,
    windowCount: record.windows.length, transitionCount: record.transitions.length,
    coverageVerified: true, referencesVerified: true, reviewerRole: 'agent', containsDocumentText: false,
    requiresHumanReview: true, ...flags };
}
