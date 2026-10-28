import { z } from 'zod';
import { auditText, countText, hashValue, prepareWriting } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { fail } from './files.js';
import { reviewBindings, reviewBindingsSchema, reviewSpanSchema, validateReviewSpan,
  type ReviewSpan } from './source-review.js';
import { writingRuleCards } from './rule-cards.js';

export const RULE_REVIEW_ENGINE = 'writing-rule-review@1' as const;
const text = z.string().trim().max(4000);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const status = z.enum(['PASS', 'FAIL', 'UNVERIFIED', 'NOT_APPLICABLE', 'EXEMPT']);
const evidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), span: reviewSpanSchema }).strict(),
  z.object({ kind: z.literal('original'), span: reviewSpanSchema }).strict(),
  z.object({ kind: z.literal('process'), note: text }).strict()
]);
const decision = z.object({ status, reason: text, evidence: z.array(evidence).max(100), authority: text });
export const ruleReviewSchema = z.object({
  schemaVersion: z.literal(RULE_REVIEW_ENGINE), bindings: reviewBindingsSchema, catalogHash: digest,
  execution: z.object({ provider: text.nullable(), model: text.nullable(), settings: text.nullable() }).strict(),
  checks: z.array(decision.extend({ checkId: z.string().min(1), requirementHash: digest,
    details: z.array(decision.extend({ requirement: text }).strict()).max(100)
  }).strict()).max(2000),
  grammar: z.object({
    ing: z.array(z.object({ id: z.string(), classification: z.enum([
      'present-progressive', 'past-progressive', 'excluded-word', 'prohibited', 'unresolved'
    ]), construction: reviewSpanSchema.nullable(), reason: text }).strict()).max(2000),
    referents: z.array(z.object({ id: z.string(), verdict: z.enum(['retain', 'prohibited', 'unresolved']), reason: text }).strict()).max(4000),
    sentences: z.array(z.object({ id: z.string(),
      mainClauseOrder: z.enum(['SVO', 'SV', 'SVC', 'OTHER', 'UNRESOLVED']),
      relativeClause: z.enum(['clear', 'prohibited', 'unresolved']),
      mentalFrame: z.enum(['clear', 'prohibited', 'unresolved']),
      clauseSplice: z.enum(['clear', 'prohibited', 'unresolved']),
      unnecessaryTail: z.enum(['clear', 'prohibited', 'unresolved']),
      triad: z.enum(['clear', 'prohibited', 'unresolved']),
      nominalClauses: z.array(reviewSpanSchema).max(100),
      basicStatements: z.array(reviewSpanSchema).max(100),
      reason: text
    }).strict()).max(4000)
  }).strict()
}).strict();

type Session = Awaited<ReturnType<typeof loadSession>>;
type InventoryItem = { id: string; span: ReviewSpan };
const words = /\d+(?:[.,]\d+)+|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu;
function englishApplication(s: Session) {
  return ['en', 'mixed'].includes(s.manifest.context.language) && s.manifest.context.authorRole === 'student' &&
    ['personal-narrative', 'application-explanatory'].includes(s.manifest.context.genre);
}
function input(s: Session) { return { schemaVersion: '1.0.0', document: s.document, original: s.original, context: s.manifest.context }; }

export function ruleInventory(s: Session) {
  const ing: InventoryItem[] = [], referents: (InventoryItem & { kind: 'some' | 'article' })[] = [];
  const sentences: InventoryItem[] = [];
  if (!englishApplication(s)) return { ing, referents, sentences };
  for (const block of s.document.blocks.filter(block => block.kind === 'body')) {
    const span = (start: number, value: string): ReviewSpan => ({ blockId: block.id,
      start: Array.from(block.text.slice(0, start)).length,
      end: Array.from(block.text.slice(0, start + value.length)).length, quote: value });
    for (const segment of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(block.text)) {
      const value = segment.segment.trim();
      if (!value || !/[A-Za-z]/u.test(value)) continue;
      const start = segment.index + segment.segment.indexOf(value);
      sentences.push({ id: `s${sentences.length + 1}`, span: span(start, value) });
    }
    for (const match of block.text.matchAll(/\b[A-Za-z]+ing\b/giu))
      ing.push({ id: `ing${ing.length + 1}`, span: span(match.index!, match[0]) });
    for (const match of block.text.matchAll(/\b(?:a|an|some(?:[ -]?(?:one|body|thing|where|time|times|day|place|how|what))?)\b/giu))
      referents.push({ id: `ref${referents.length + 1}`, kind: /^(?:a|an)$/iu.test(match[0]) ? 'article' : 'some',
        span: span(match.index!, match[0]) });
  }
  return { ing, referents, sentences };
}

function prepared(s: Session) {
  const applicable = new Set(prepareWriting(input(s), s.policy).rules.map(rule => rule.ruleId));
  const cards = writingRuleCards(s.policy, applicable), inventory = ruleInventory(s);
  return { cards, inventory, catalogHash: hashValue({ engine: RULE_REVIEW_ENGINE, cards, inventory }) };
}

export async function prepareRuleReview(policyRoot: string, path: string) {
  const s = await loadSession(policyRoot, path), p = prepared(s);
  return {
    schemaVersion: RULE_REVIEW_ENGINE, bindings: reviewBindings(s), catalogHash: p.catalogHash,
    context: s.manifest.context, cards: p.cards, inventory: p.inventory,
    instructions: [
      'Read the full current policy, prompt, original and preparation. Keep every applicable subrequirement; display units are not certified atomic obligations.',
      'Review process/source, syntax and content in separate passes. For each unit split every applicable obligation into details with its own state, reason and current evidence.',
      'Keep all check IDs and hashes. Empty evidence, missing details or unknown judgments are UNVERIFIED. N/A and exceptions require specific grounds; authorizations remain declarations for human review.',
      'Cover every inventory item exactly once in order, including cross-paragraph adjacent sentences. Suffix and article matches are candidates, not grammatical verdicts.',
      'For each sentence inspect zero relatives, mental frames, finite-clause splices, unnecessary tails, triads, all nominal clauses and all basic statements. List exact spans, including omitted-that and nested clauses.',
      'Progressive ing requires an exact containing construction and a source-supported present/past progressive judgment. Excluded lexical forms require a reason. A be prefix does not prove tense.',
      'Save records outside immutable version folders. Repair using the normal patch workflow, then prepare and re-review the complete current version.',
      'The tool verifies bindings, declared coverage, arithmetic and explicit failures. It does not certify truth, syntax classifications, exhaustive obligation decomposition, voice or formal approval.'
    ],
    template: {
      schemaVersion: RULE_REVIEW_ENGINE, bindings: reviewBindings(s), catalogHash: p.catalogHash,
      execution: { provider: null, model: null, settings: null },
      checks: p.cards.map(card => ({ checkId: card.checkId, requirementHash: card.requirementHash,
        status: 'UNVERIFIED', reason: '', evidence: [], authority: '', details: [] })),
      grammar: {
        ing: p.inventory.ing.map(item => ({ id: item.id, classification: 'unresolved', construction: null, reason: '' })),
        referents: p.inventory.referents.map(item => ({ id: item.id, verdict: 'unresolved', reason: '' })),
        sentences: p.inventory.sentences.map(item => ({ id: item.id, mainClauseOrder: 'UNRESOLVED',
          relativeClause: 'unresolved', mentalFrame: 'unresolved', clauseSplice: 'unresolved',
          unnecessaryTail: 'unresolved', triad: 'unresolved', nominalClauses: [], basicStatements: [], reason: '' }))
      }
    },
    containsDocumentText: true, requiresHumanReview: true, deliveryAuthorized: false
  };
}

export async function reviewRules(policyRoot: string, path: string, raw: unknown) {
  const s = await loadSession(policyRoot, path), record = ruleReviewSchema.parse(raw), p = prepared(s);
  if (hashValue(record.bindings) !== hashValue(reviewBindings(s)) || record.catalogHash !== p.catalogHash)
    fail('rule-review-stale', 'Prepare for the current source, version, context, policy and engine.');
  function exactIds(actual: string[], expected: string[]) {
    if (hashValue(actual) !== hashValue(expected)) fail('rule-review-coverage', 'Cover every expected item exactly once in order.');
  }
  exactIds(record.checks.map(check => check.checkId), p.cards.map(card => card.checkId));
  exactIds(record.grammar.ing.map(item => item.id), p.inventory.ing.map(item => item.id));
  exactIds(record.grammar.referents.map(item => item.id), p.inventory.referents.map(item => item.id));
  exactIds(record.grammar.sentences.map(item => item.id), p.inventory.sentences.map(item => item.id));
  const blockers: { checkId: string; code: string }[] = [], pending: { checkId: string; code: string }[] = [];
  const block = (checkId: string, code: string) => blockers.push({ checkId, code });
  const wait = (checkId: string, code: string) => pending.push({ checkId, code });
  function checkDecision(item: z.infer<typeof decision>, id: string) {
    for (const anchor of item.evidence) {
      if (anchor.kind === 'process') { if (!anchor.note) wait(id, 'empty-process-evidence'); }
      else validateReviewSpan(anchor.span, anchor.kind === 'document' ? s.document.blocks : s.original.blocks, 'rule-review-span');
    }
    if (item.status === 'FAIL') block(id, 'declared-failure');
    if (item.status === 'UNVERIFIED') wait(id, 'unverified');
    if (!item.reason || !item.evidence.length) wait(id, 'missing-evidence-or-reason');
    if (item.status === 'EXEMPT' && !item.authority) wait(id, 'missing-exception-authority');
  }
  record.checks.forEach((check, index) => {
    if (check.requirementHash !== p.cards[index]!.requirementHash) fail('rule-review-requirement', 'Keep the current requirement hash.');
    checkDecision(check, check.checkId);
    if (!check.details.length) wait(check.checkId, 'missing-subrequirements');
    const named = new Set<string>();
    for (const detail of check.details) {
      if (!detail.requirement || named.has(detail.requirement)) wait(check.checkId, 'empty-or-duplicate-subrequirement');
      named.add(detail.requirement); checkDecision(detail, check.checkId);
    }
  });
  const wordCount = countText(s.document.blocks.filter(b => b.kind === 'body').map(b => b.text).join('\n\n')).englishWords;
  const limits = { ing: Math.floor(wordCount / 150), nominalClauses: Math.floor(wordCount / 150), basicStatements: Math.floor(wordCount / 100) };
  let allowedIng = 0;
  record.grammar.ing.forEach((item, index) => {
    const candidate = p.inventory.ing[index]!;
    if (!item.reason || item.classification === 'unresolved') wait(item.id, 'ing-unverified');
    if (item.classification === 'prohibited') block(item.id, 'ing-prohibited');
    if (item.classification === 'present-progressive' || item.classification === 'past-progressive') {
      allowedIng++;
      if (!item.construction) wait(item.id, 'missing-progressive-construction');
      else {
        validateReviewSpan(item.construction, s.document.blocks, 'rule-review-span');
        if (item.construction.blockId !== candidate.span.blockId || item.construction.start > candidate.span.start ||
          item.construction.end < candidate.span.end) fail('rule-review-construction', 'The construction must contain its ing candidate.');
      }
    }
  });
  record.grammar.referents.forEach((item, index) => {
    if (!item.reason || item.verdict === 'unresolved') wait(item.id, 'referent-unverified');
    if (item.verdict === 'prohibited' || p.inventory.referents[index]!.kind === 'some') block(item.id, 'referent-prohibited');
  });
  let nominalCount = 0;
  const basic: { blockId: string; start: number; word: number }[] = [];
  const blockStarts = new Map<string, number>(); let offset = 0;
  for (const b of s.document.blocks.filter(b => b.kind === 'body')) { blockStarts.set(b.id, offset); offset += countText(b.text).englishWords; }
  const seenSpans = new Set<string>();
  record.grammar.sentences.forEach((item, index) => {
    const sentence = p.inventory.sentences[index]!.span;
    if (!item.reason || item.mainClauseOrder === 'UNRESOLVED') wait(item.id, 'sentence-unverified');
    if (index && item.mainClauseOrder === 'SVO' && record.grammar.sentences[index - 1]!.mainClauseOrder === 'SVO') block(item.id, 'adjacent-svo');
    for (const key of ['relativeClause', 'mentalFrame', 'clauseSplice', 'unnecessaryTail', 'triad'] as const) {
      if (item[key] === 'unresolved') wait(item.id, `${key}-unverified`);
      if (item[key] === 'prohibited') block(item.id, `${key}-prohibited`);
    }
    for (const [kind, spans] of [['nominal', item.nominalClauses], ['basic', item.basicStatements]] as const) {
      let previous = -1;
      for (const anchor of spans) {
        validateReviewSpan(anchor, s.document.blocks, 'rule-review-span');
        if (anchor.blockId !== sentence.blockId || anchor.start < sentence.start || anchor.end > sentence.end || anchor.start < previous)
          fail('rule-review-sentence-span', 'Keep declared spans in their sentence, ordered by start; nested spans are allowed.');
        previous = anchor.start;
        const key = `${kind}:${anchor.blockId}:${anchor.start}:${anchor.end}`;
        if (seenSpans.has(key)) fail('rule-review-duplicate-span', 'Count each exact structure once.');
        seenSpans.add(key);
        if (kind === 'nominal') nominalCount++;
        else {
          const body = Array.from(s.document.blocks.find(b => b.id === anchor.blockId)!.text).slice(0, anchor.start).join('');
          basic.push({ blockId: anchor.blockId, start: anchor.start, word: blockStarts.get(anchor.blockId)! + [...body.matchAll(words)].length });
        }
      }
    }
  });
  if (allowedIng > limits.ing) block('R02', 'ing-limit');
  if (nominalCount > limits.nominalClauses) block('R02', 'nominal-clause-limit');
  if (basic.length > limits.basicStatements) block('R02', 'basic-statement-limit');
  for (let i = 1; i < basic.length; i++) if (basic[i]!.word - basic[i - 1]!.word < 100) block('R02', 'basic-statement-spacing');
  const audit = auditText(input(s), s.policy);
  const visibleErrors = audit.findings.filter(finding => finding.severity === 'error');
  for (const finding of visibleErrors) block(finding.ruleId, finding.code);
  if (audit.observedErrors > visibleErrors.length || (audit.qualityDecision === 'blocked' && !visibleErrors.length))
    block('audit', 'additional-mechanical-errors');
  if (audit.findingsTruncated) wait('audit', 'findings-truncated');
  return {
    schemaVersion: RULE_REVIEW_ENGINE, bindings: reviewBindings(s), catalogHash: p.catalogHash, recordHash: hashValue(record),
    reviewDecision: blockers.length ? 'needs-rework' : pending.length ? 'needs-review' : 'recorded',
    checkCount: record.checks.length, detailCount: record.checks.reduce((n, check) => n + check.details.length, 0),
    blockers, pending, mechanicalErrorsObserved: audit.observedErrors, findingsTruncated: audit.findingsTruncated,
    metrics: { wordCount, allowedIng, nominalClauses: nominalCount, basicStatements: basic.length }, limits,
    execution: record.execution, coverageVerified: true, classificationSource: 'reviewer-declared',
    atomicCoverageCertified: false, syntaxCertified: false, factsCertified: false,
    containsDocumentText: false, requiresHumanReview: true, deliveryAuthorized: false
  };
}
