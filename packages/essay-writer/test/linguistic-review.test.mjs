import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { contextSchema, documentSchema, hashValue } from '@mantou/text-quality';
import { importSession, loadSession, patchTemplate, reviseSession, styleEvidenceSchema } from '../dist/index.js';
import { analyseEnglishDocument, prepareLinguisticReview, reviewLinguistic, linguisticReviewSchema } from '../dist/linguistic-review.js';

// Every text in this file is synthetic. These cases test contracts and retention
// boundaries, not prose quality, a detector, or the authenticity of a source.
const root = resolve('.');
const context = contextSchema.parse({ language: 'en', genre: 'personal-narrative', authorRole: 'student',
  audience: 'admission reader', prompt: 'Describe a choice while repairing an object.' });
const document = (text, revision = 'synthetic-evidence') => documentSchema.parse({ revision,
  blocks: [{ id: 'p1', text }] });
const span = (quote, start = 0, blockId = 'p1') => ({ blockId, start, end: start + Array.from(quote).length, quote });
const baseText = 'I wanted to open a problem with the latch.\n\nAfter I checked the hinge, Nora carried the tray outside. The algorithm recorded every attempt.';
async function fixture(t, text = baseText, language = 'en') {
  const dir = await mkdtemp(join(tmpdir(), 'humanier-linguistic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, text);
  await importSession(root, { input, out, context: { ...context, language } });
  return { dir, input, out };
}
async function snapshot(directory) {
  const result = {};
  async function visit(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name, path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path, name + '/');
      else result[name] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(directory); return result;
}
async function evidenceFor(out) {
  const current = (await loadSession(root, out)).document;
  const historical = document('Before closing the case, I checked which spring had slipped.');
  return styleEvidenceSchema.parse({ schemaVersion: '1.0.0', references: [], reports: [current, historical].map((testedDocument, index) => ({
    id: index ? 'historical' : 'current', toolName: 'Synthetic detector feedback', modelVersion: null, observedAt: null,
    testedDocument, testedDocumentHash: hashValue(testedDocument), documentLabel: 'unknown', labelSource: 'not-provided', rawScore: null,
    comments: [{ anchor: span(testedDocument.blocks[0].text), featureTags: ['Lacks Creative Grammar'],
      explanation: 'Synthetic supplied explanation: the sentence contains no subordinate structure.', observedStrength: null }],
    sourceArtifacts: [{ kind: 'image', sha256: 'b'.repeat(64) }]
  })) });
}
async function complete(out, evidence) {
  const prepared = await prepareLinguisticReview(root, out, evidence), value = structuredClone(prepared.template);
  const candidates = new Map(prepared.analysis.candidates.map(candidate => [candidate.id, candidate]));
  value.decisions = value.decisions.map(item => ({ ...item, decision: 'retain',
    linguisticObservation: 'This surface cue identifies a reading location without establishing an error.',
    informationFunction: 'context', sourceBasis: 'editorial-hypothesis', originalAnchors: [],
    referents: item.categoryId === 'reference-recoverability' ? [{ mention: candidates.get(item.candidateId).anchor,
      antecedents: [], identifiability: 'source-context', reason: 'The reviewer records a context-based reading for this synthetic example.' }] : [],
    perspective: 'not-applicable', clauseFunction: 'not-applicable',
    reason: 'Keep the source-supported content unless an independent reading establishes a concrete problem.',
    preserveCounterexample: 'A plain sentence, accurate term or necessary temporal relation can remain unchanged.' }));
  value.paragraphs = value.paragraphs.map(item => ({ ...item, role: 'context', status: 'retain',
    informationIncrement: 'The paragraph supplies a distinct part of the synthetic account.',
    authorAccess: 'The record requires a declared access basis; its truth is outside this validator.' }));
  value.feedbackAssessments = value.feedbackAssessments.map(item => ({ ...item, assessment: 'unassessable',
    categoryIds: [], linguisticReason: 'The supplied statement is preserved separately; this synthetic record makes no claim about detector causality.',
    retainCounterexample: 'A necessary clause or ordinary sentence can remain even when the source tool marks it.' }));
  value.overall = { decision: 'retain', reason: 'The record covers each cue and paragraph without asserting language-effect validation.' };
  return value;
}
function assertExact(documentValue, anchor) {
  const block = documentValue.blocks.find(item => item.id === anchor.blockId);
  assert.ok(block); assert.equal(Array.from(block.text).slice(anchor.start, anchor.end).join(''), anchor.quote);
}

test('Unicode sentence and candidate spans use codepoints across blocks, CRLF and repeated text', () => {
  const doc = documentSchema.parse({ revision: 'unicode', blocks: [
    { id: 'p1', text: '  🧭 I held a question beside the tray.\r\nThe question had two parts.\r\n \t\r\nAfter I checked it, Nora carried the tray outside.' },
    { id: 'p2', text: 'I held a question beside the tray.\n\nI held a question beside the tray.' }
  ] });
  const before = structuredClone(doc), result = analyseEnglishDocument(doc);
  for (const item of result.sentences) assertExact(doc, item.anchor);
  for (const item of result.candidates) { assertExact(doc, item.anchor); item.related.forEach(anchor => assertExact(doc, anchor)); }
  assert.equal(result.sentences.length, 5);
  const second = result.sentences.find(item => item.anchor.quote.startsWith('The question'));
  assert.equal(second.anchor.start, Array.from(doc.blocks[0].text.slice(0, doc.blocks[0].text.indexOf('The question'))).length);
  assert.notEqual(second.anchor.start, doc.blocks[0].text.indexOf('The question'));
  const repeated = result.sentences.filter(item => item.anchor.blockId === 'p2');
  assert.notEqual(repeated[0].anchor.start, repeated[1].anchor.start);
  assert.notEqual(repeated[0].paragraphIndex, repeated[1].paragraphIndex);
  assert.deepEqual(doc, before);
  assert.deepEqual(analyseEnglishDocument(doc), result);
  assert.equal(new Set(result.candidates.map(item => item.id)).size, result.candidates.length);
});

test('bare CR, LF and CRLF blank lines preserve independent logical paragraphs and codepoint offsets', () => {
  const paragraphs = ['🧭 I held a question beside the tray.', 'I held a question beside the tray.', 'After I checked it, I closed the case.'];
  for (const newline of ['\r', '\n', '\r\n']) {
    const text = '  ' + paragraphs.join(newline + ' \t' + newline) + '  ';
    const doc = document(text), analysis = analyseEnglishDocument(doc);
    assert.deepEqual(analysis.sentences.map(item => item.anchor.quote), paragraphs);
    assert.deepEqual(analysis.sentences.map(item => item.paragraphIndex), [0, 1, 2]);
    for (const sentence of analysis.sentences) assertExact(doc, sentence.anchor);
    for (const candidate of analysis.candidates) {
      assertExact(doc, candidate.anchor); candidate.related.forEach(item => assertExact(doc, item));
    }
    assert.equal(analysis.sentences[1].anchor.start,
      Array.from(text.slice(0, text.lastIndexOf(paragraphs[1]))).length);
  }
});

test('articles, chronology, plain grammar and technical terms remain unresolved cues with retention examples', () => {
  const result = analyseEnglishDocument(document('A problem occupied the page. The problem had two answers. After I opened the case, I checked the spring. While Nora held the lid, I tested the algorithm.'));
  for (const category of ['reference-recoverability', 'clause-attachment', 'discourse-linking', 'register-fit'])
    assert.ok(result.candidates.some(item => item.categoryId === category), category);
  assert.ok(result.candidates.every(item => item.decision === 'unresolved' && item.reviewQuestion.trim() && item.retainCounterexample.trim()));
  for (const key of ['automaticRewrite', 'fullSyntacticParse', 'referenceResolutionCertified', 'voiceCertified', 'detectorReplicated', 'deliveryAuthorized'])
    assert.equal(result[key], false, key);
  assert.ok(!Object.keys(result).some(key => /probability|score|verdict|risk/i.test(key)));
  assert.ok(!('replacement' in result));
  assert.ok(!('rewrittenDocument' in result));
});

test('observable third-person actions stay outside mental-attribution cues and I does not certify viewpoint', () => {
  const action = analyseEnglishDocument(document('Nora carried the tray outside. I checked the hinge.'));
  assert.ok(!action.candidates.some(item => item.categoryId === 'narrative-viewpoint'));
  const judgment = analyseEnglishDocument(document('I knew Nora believed the repair was complete. I was the kind of person who solved every problem.'));
  assert.ok(judgment.candidates.some(item => item.categoryId === 'narrative-viewpoint'));
  assert.equal(judgment.voiceCertified, false);
  assert.ok(judgment.candidates.filter(item => item.categoryId === 'narrative-viewpoint').every(item => item.decision === 'unresolved'));
});

test('overlap and parallel structures are contextual questions rather than duplicate-content verdicts', () => {
  const result = analyseEnglishDocument(document('If I opened the latch, I could inspect the spring inside the case. If I closed the latch, I could test the spring inside the case.'));
  for (const category of ['cadence-pattern', 'information-gain']) assert.ok(result.candidates.some(item => item.categoryId === category));
  assert.ok(result.candidates.filter(item => ['cadence-pattern', 'information-gain'].includes(item.categoryId))
    .every(item => item.related.length && item.decision === 'unresolved' && item.retainCounterexample.trim()));
});

test('preparation is incomplete, English-only and explicitly separates raw explanations from assessment', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), before = await snapshot(out);
  const prepared = await prepareLinguisticReview(root, out, evidence);
  assert.throws(() => linguisticReviewSchema.parse(prepared.template));
  assert.equal(prepared.analysis.candidateCount, prepared.template.decisions.length);
  assert.equal(prepared.paragraphs.length, prepared.template.paragraphs.length);
  assert.deepEqual(prepared.evidenceChecks.map(item => item.scope), ['current', 'historical']);
  for (const item of prepared.evidenceChecks) {
    assert.equal(item.assessment, 'not-reviewed');
    assert.deepEqual(item.originalTags, ['Lacks Creative Grammar']);
    assert.equal(item.originalExplanation, evidence.reports[0].comments[0].explanation);
  }
  assert.deepEqual(await snapshot(out), before);
  const zh = await fixture(t, '我检查了合成样例的标签。', 'zh');
  await assert.rejects(prepareLinguisticReview(root, zh.out), { code: 'linguistic-language' });
});

test('complete retention records validate coverage while leaving language, source and delivery judgments uncertified', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), before = await snapshot(out);
  const result = await reviewLinguistic(root, out, await complete(out, evidence), evidence);
  assert.equal(result.reviewDecision, 'recorded');
  assert.equal(result.candidateCoverageVerified, true); assert.equal(result.paragraphCoverageVerified, true);
  for (const key of ['judgmentsVerified', 'evidenceAuthenticityVerified', 'containsDocumentText', 'voiceCertified', 'detectorReplicated', 'deliveryAuthorized'])
    assert.equal(result[key], false, key);
  assert.equal(result.requiresHumanReview, true);
  assert.ok(!JSON.stringify(result).includes('Nora'));
  assert.deepEqual(await snapshot(out), before);
});

test('all bindings, changed evidence and changed draft invalidate an older review without rewriting old versions', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), record = await complete(out, evidence), oldFiles = await snapshot(out);
  for (const key of Object.keys(record.bindings)) {
    const changed = structuredClone(record); changed.bindings[key] = key === 'engineVersion' ? '99.0.0' : '0'.repeat(64);
    await assert.rejects(reviewLinguistic(root, out, changed, evidence));
  }
  for (const mutate of [e => { e.reports[0].toolName = 'Changed synthetic tool'; },
    e => { e.reports[0].comments[0].explanation = 'Changed supplied explanation.'; }]) {
    const changed = structuredClone(evidence); mutate(changed);
    await assert.rejects(reviewLinguistic(root, out, record, changed), { code: 'linguistic-review-stale' });
  }
  const session = await loadSession(root, out), first = session.document.blocks[0];
  await reviseSession(root, out, { ...patchTemplate(session.manifest.context, session.document, session.policy), patches: [{
    blockId: first.id, start: 0, end: Array.from(first.text).length, expectedText: first.text,
    replacement: first.text.replace('wanted', 'hoped'), reason: 'Change the synthetic intention without altering other events.' }] });
  await assert.rejects(reviewLinguistic(root, out, record, evidence), { code: 'linguistic-review-stale' });
  const after = await snapshot(out);
  for (const [path, digest] of Object.entries(oldFiles)) {
    // The current-version pointer is expected to advance; immutable originals,
    // policy and old version payloads must keep their exact bytes.
    if (path === 'session.json') continue;
    assert.equal(after[path], digest, path);
  }
});

test('candidate and exact logical paragraph coverage rejects omissions, duplication and invented entries', async t => {
  const { out } = await fixture(t), record = await complete(out);
  const mutations = [
    r => r.decisions.pop(), r => r.decisions.push(structuredClone(r.decisions[0])),
    r => { r.decisions[0].candidateId = 'f'.repeat(64); },
    r => { r.decisions[0].categoryId = r.decisions[0].categoryId === 'evidence-scope' ? 'register-fit' : 'evidence-scope'; },
    r => r.paragraphs.pop(), r => r.paragraphs.push(structuredClone(r.paragraphs[0])),
    r => { r.paragraphs[0].anchor = span(baseText); }
  ];
  for (const mutate of mutations) { const changed = structuredClone(record); mutate(changed); await assert.rejects(reviewLinguistic(root, out, changed)); }
});

test('forged current and source quotations, unknown categories and malformed schemas are rejected', async t => {
  const { out } = await fixture(t), record = await complete(out), prepared = await prepareLinguisticReview(root, out);
  const reference = record.decisions.findIndex(item => item.categoryId === 'reference-recoverability');
  assert.ok(reference >= 0);
  for (const mutate of [
    r => { r.decisions[reference].referents[0].mention.quote = 'Invented mention.'; },
    r => { r.decisions[reference].referents[0].antecedents = [span('Invented antecedent.')]; },
    r => { r.decisions[0].sourceBasis = 'supplied-source'; r.decisions[0].originalAnchors = [span('Invented source.')]; },
    r => { r.paragraphs[0].anchor.quote += ' invented'; },
    r => { r.decisions[0].categoryId = 'definitely-ai'; },
    r => { r.schemaVersion = '99.0.0'; },
    r => { r.decisions[0].modelProbability = 0; }
  ]) { const changed = structuredClone(record); mutate(changed); await assert.rejects(reviewLinguistic(root, out, changed)); }
  const exact = structuredClone(record); exact.decisions[0].sourceBasis = 'supplied-source';
  exact.decisions[0].originalAnchors = [span(prepared.original.blocks[0].text)];
  assert.equal((await reviewLinguistic(root, out, exact)).reviewDecision, 'recorded');
});

test('revision objectives, source anchors and explicit reference explanations are required before acceptance', async t => {
  const { out } = await fixture(t), record = await complete(out);
  const missingObjective = structuredClone(record); missingObjective.decisions[0].decision = 'revise';
  await assert.rejects(reviewLinguistic(root, out, missingObjective), { code: 'linguistic-review-objective' });
  const blankObjective = structuredClone(missingObjective); blankObjective.decisions[0].editObjective = '   ';
  await assert.rejects(reviewLinguistic(root, out, blankObjective));
  const missingSource = structuredClone(record); missingSource.decisions[0].sourceBasis = 'supplied-source';
  await assert.rejects(reviewLinguistic(root, out, missingSource), { code: 'linguistic-review-source' });
  const missingReferent = structuredClone(record); missingReferent.decisions.find(item => item.categoryId === 'reference-recoverability').referents = [];
  await assert.rejects(reviewLinguistic(root, out, missingReferent), { code: 'linguistic-review-reference' });
  const proposed = structuredClone(missingObjective); proposed.decisions[0].editObjective = 'Identify the source-backed object without changing the event.';
  assert.equal((await reviewLinguistic(root, out, proposed)).reviewDecision, 'needs-rework');
});

test('referent mentions stay in their own candidate and prior antecedents precede them within and across blocks', async t => {
  const { out } = await fixture(t, 'A question sat beside the hinge. I copied the question into my notebook.\n\nThe question remained unanswered.\n\nA question lay on the shelf.');
  const prepared = await prepareLinguisticReview(root, out), record = await complete(out);
  const session = await loadSession(root, out), doc = session.document;
  const findSpan = (blockId, quote) => {
    const text = doc.blocks.find(item => item.id === blockId).text, offset = text.indexOf(quote);
    assert.ok(offset >= 0); return span(quote, Array.from(text.slice(0, offset)).length, blockId);
  };
  const target = (quote) => {
    const candidate = prepared.analysis.candidates.find(item => item.categoryId === 'reference-recoverability' && item.anchor.quote === quote);
    assert.ok(candidate); return record.decisions.findIndex(item => item.candidateId === candidate.id);
  };
  const first = target('A question sat beside the hinge.');
  const laterSameBlock = target('I copied the question into my notebook.');
  const laterBlock = target('The question remained unanswered.');
  const setReference = (value, index, mention, antecedents, identifiability = 'prior-mention') => {
    value.decisions[index].referents = [{ mention, antecedents, identifiability,
      reason: 'Exact synthetic anchors identify the claimed prior referent; semantic equivalence remains manual.' }];
  };
  const unrelated = structuredClone(record);
  setReference(unrelated, first, findSpan('p1', 'the question'), [], 'source-context');
  await assert.rejects(reviewLinguistic(root, out, unrelated), { code: 'linguistic-review-reference' });
  const unrelatedBlock = structuredClone(record);
  setReference(unrelatedBlock, first, findSpan('p2', 'The question'), [], 'source-context');
  await assert.rejects(reviewLinguistic(root, out, unrelatedBlock), { code: 'linguistic-review-reference' });
  const futureSameBlock = structuredClone(record);
  setReference(futureSameBlock, first, findSpan('p1', 'A question'), [findSpan('p1', 'the question')]);
  await assert.rejects(reviewLinguistic(root, out, futureSameBlock), { code: 'linguistic-review-reference' });
  const futureBlock = structuredClone(record);
  setReference(futureBlock, laterBlock, findSpan('p2', 'The question'), [findSpan('p3', 'A question')]);
  await assert.rejects(reviewLinguistic(root, out, futureBlock), { code: 'linguistic-review-reference' });
  const missingPrior = structuredClone(record);
  setReference(missingPrior, laterSameBlock, findSpan('p1', 'the question'), []);
  await assert.rejects(reviewLinguistic(root, out, missingPrior), { code: 'linguistic-review-reference' });
  const valid = structuredClone(record);
  setReference(valid, laterSameBlock, findSpan('p1', 'the question'), [findSpan('p1', 'A question')]);
  // The antecedent ends at a larger local offset than the next block's mention
  // starts. Block order, rather than comparing those offsets, licenses it.
  setReference(valid, laterBlock, findSpan('p2', 'The question'), [findSpan('p1', 'the question')]);
  assert.equal((await reviewLinguistic(root, out, valid)).reviewDecision, 'recorded');
});

test('a top-level retain decision cannot conceal pending candidate, reference or paragraph work', async t => {
  const { out } = await fixture(t), record = await complete(out);
  for (const mutate of [
    r => { r.decisions[0].decision = 'unresolved'; },
    r => { r.decisions[0].decision = 'needs-source'; },
    r => { r.decisions[0].sourceBasis = 'needs-source'; },
    r => { r.decisions[0].perspective = 'unresolved'; },
    r => { r.decisions[0].clauseFunction = 'unresolved'; },
    r => { r.decisions.find(item => item.referents.length).referents[0].identifiability = 'unresolved'; },
    r => { r.paragraphs[0].status = 'unresolved'; },
    r => { r.overall.decision = 'unresolved'; }
  ]) { const changed = structuredClone(record); mutate(changed); assert.equal((await reviewLinguistic(root, out, changed)).reviewDecision, 'needs-rework'); }
});

test('prepare and review perform no network request or automatic rewrite and preserve all session bytes', async t => {
  const { out } = await fixture(t), record = await complete(out), before = await snapshot(out);
  const originals = [], calls = [];
  const block = (target, key) => {
    const previous = target[key]; originals.push(() => { target[key] = previous; });
    target[key] = (...args) => { calls.push(key); throw new Error('Unexpected external IO: ' + key); };
  };
  block(globalThis, 'fetch');
  for (const target of [http, https]) for (const key of ['request', 'get']) block(target, key);
  for (const key of ['connect', 'createConnection']) block(net, key);
  block(tls, 'connect');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) block(childProcess, key);
  try {
    const prepared = await prepareLinguisticReview(root, out);
    assert.equal(prepared.automaticRewrite, false);
    assert.equal((await reviewLinguistic(root, out, record)).reviewDecision, 'recorded');
  } finally { for (const restore of originals.reverse()) restore(); }
  assert.deepEqual(calls, []); assert.deepEqual(await snapshot(out), before);
});

test('every current and historical feedback comment requires a unique correctly scoped assessment', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), record = await complete(out, evidence);
  for (const mutate of [
    r => r.feedbackAssessments.pop(),
    r => r.feedbackAssessments.push(structuredClone(r.feedbackAssessments[0])),
    r => { r.feedbackAssessments[0].scope = 'historical'; },
    r => { r.feedbackAssessments[0].reportId = 'absent-report'; },
    r => { r.feedbackAssessments[0].commentIndex = 99; },
    r => { r.feedbackAssessments[0].categoryIds = ['clause-attachment', 'clause-attachment']; },
    r => { r.feedbackAssessments[0].categoryIds = ['unknown-category']; }
  ]) { const changed = structuredClone(record); mutate(changed); await assert.rejects(reviewLinguistic(root, out, changed, evidence)); }
  const pending = structuredClone(record); pending.feedbackAssessments[0].assessment = 'not-reviewed';
  const result = await reviewLinguistic(root, out, pending, evidence);
  assert.equal(result.reviewDecision, 'needs-rework'); assert.deepEqual(result.rework.feedback, [0]);
});

test('collapsed screenshot declarations preserve unknown tags and explanation, bind the artifact, and still need assessment', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out);
  const source = evidence.reports[0].comments[0];
  evidence.reports[0].comments.push({ anchor: structuredClone(source.anchor), featureTags: [], explanation: null, observedStrength: null,
    sourceObservation: { artifactSha256: 'b'.repeat(64), visibility: 'collapsed-truncated', visibleText: 'I wanted to open...',
      anchorRelation: 'prefix', transcription: 'agent-transcribed' } });
  const record = await complete(out, evidence);
  assert.equal(record.feedbackAssessments.length, 3);
  assert.equal((await reviewLinguistic(root, out, record, evidence)).reviewDecision, 'recorded');
  const omitted = structuredClone(record); omitted.feedbackAssessments = omitted.feedbackAssessments.filter(item => item.commentIndex !== 1);
  await assert.rejects(reviewLinguistic(root, out, omitted, evidence), { code: 'linguistic-review-feedback' });
  for (const mutate of [
    e => { e.reports[0].comments[1].sourceObservation.artifactSha256 = 'c'.repeat(64); },
    e => { e.reports[0].comments[1].featureTags = ['Imagined hidden tag']; },
    e => { e.reports[0].comments[1].explanation = 'Imagined hidden explanation.'; }
  ]) { const changed = structuredClone(evidence); mutate(changed); await assert.rejects(prepareLinguisticReview(root, out, changed)); }
  // Evidence without the new optional provenance object stays readable.
  assert.equal((await prepareLinguisticReview(root, out, await evidenceFor(out))).evidenceChecks.length, 2);
});
