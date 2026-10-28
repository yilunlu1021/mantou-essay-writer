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
import { importSession, loadSession, styleEvidenceSchema } from '../dist/index.js';
import { analyseEnglishDocument, prepareLinguisticReview, reviewLinguistic,
  linguisticReviewSchema, LINGUISTIC_ENGINE_VERSION } from '../dist/linguistic-review.js';
import { locateConstructionCues } from '../dist/construction-review.js';

// Synthetic examples only. A required comparison is a review obligation, not
// an authorship judgment, a detector result, or a verdict that a clause is bad.
const root = resolve('.');
const context = contextSchema.parse({ language: 'en', genre: 'personal-narrative', authorRole: 'student',
  audience: 'admission reader', prompt: 'Describe a choice while repairing an object.' });
const whText = 'I had underestimated how much effort it would take to make the sessions worthwhile for people at different levels.';
const nominalText = 'I understood the amount of patience that the repair required.';
const lessonText = 'Repairing the pump taught me that patience always matters.';
const document = (text, revision = 'synthetic-construction') => documentSchema.parse({ revision,
  blocks: [{ id: 'p1', text }] });
const span = (quote, start = 0, blockId = 'p1') => ({ blockId, start, end: start + Array.from(quote).length, quote });
const required = analysis => analysis.candidates.filter(candidate => candidate.requiresCompressionCheck);
const exact = (doc, anchor) => {
  const block = doc.blocks.find(item => item.id === anchor.blockId);
  assert.ok(block, anchor.blockId);
  assert.equal(Array.from(block.text).slice(anchor.start, anchor.end).join(''), anchor.quote);
};

async function fixture(t, text = whText) {
  const dir = await mkdtemp(join(tmpdir(), 'humanier-construction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, text);
  await importSession(root, { input, out, context });
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

async function evidenceFor(out, { referenceText = '🪶 I had underestimated the repair effort.',
  label = 'unknown', tags = ['Synthetic supplied tag'] } = {}) {
  const current = (await loadSession(root, out)).document;
  return styleEvidenceSchema.parse({ schemaVersion: '1.0.0', references: [{
    id: 'synthetic-reference', origin: 'advisor-example', authorRole: 'advisor', approval: 'unconfirmed',
    document: document(referenceText, 'synthetic-reference-body'),
    note: 'Synthetic declared editorial comparison. Neither identity nor authorship is authenticated.'
  }], reports: [{ id: 'synthetic-report', toolName: 'Synthetic feedback, not a real detector',
    modelVersion: null, observedAt: null, testedDocument: current, testedDocumentHash: hashValue(current),
    documentLabel: label, labelSource: label === 'unknown' ? 'not-provided' : 'visible',
    rawScore: label === 'unknown' ? null : 'Synthetic displayed value',
    comments: [{ anchor: span(current.blocks[0].text), featureTags: tags,
      explanation: 'Synthetic supplied explanation whose content must not select linguistic candidates.', observedStrength: null }],
    sourceArtifacts: [] }] });
}

const comparison = () => ({
  alternative: 'I had underestimated the effort of planning the sessions.',
  complementRole: 'retrospective-appraisal',
  informationLost: 'The shorter wording preserves the synthetic claim about underestimating effort.',
  contextReason: 'The comparison concerns effort already tied to this task, not an unnamed future activity.',
  choice: 'retain-current',
  reason: 'This contract fixture records an explicit retention choice. The validator cannot certify this editorial judgment.',
  referenceStatus: 'unavailable', references: [],
  referenceReason: 'No appropriate reference is available for this synthetic comparison.'
});

async function complete(out, evidence) {
  const prepared = await prepareLinguisticReview(root, out, evidence), record = structuredClone(prepared.template);
  const candidates = new Map(prepared.analysis.candidates.map(candidate => [candidate.id, candidate]));
  record.decisions = record.decisions.map(item => {
    const candidate = candidates.get(item.candidateId), match = candidate.anchor.quote.match(/\b(?:it|its|they|their|them)\b/iu);
    const mention = match ? span(match[0], candidate.anchor.start + Array.from(candidate.anchor.quote.slice(0, match.index)).length,
      candidate.anchor.blockId) : candidate.anchor;
    return { ...item, decision: 'retain', linguisticObservation: 'A transparent surface cue requires a source-bound reading and comparison.',
      informationFunction: 'reflection', sourceBasis: 'editorial-hypothesis', originalAnchors: [],
      referents: item.categoryId === 'reference-recoverability' ? [{ mention, antecedents: [], identifiability: 'source-context',
        reason: 'The synthetic use is recorded explicitly; the validator does not certify reference resolution.' }] : [],
      perspective: 'author-retrospective', clauseFunction: 'complement',
      reason: 'This complete synthetic record permits a retention choice while preserving independent semantic review.',
      preserveCounterexample: 'A substantive judgment or requested answer can require a content clause.',
      ...(candidate.requiresCompressionCheck ? { compressionCheck: comparison() } : {}) };
  });
  record.paragraphs = record.paragraphs.map(item => ({ ...item, role: 'reflection', status: 'retain',
    informationIncrement: 'The synthetic paragraph records a distinct change in judgment.',
    authorAccess: 'This fixture declares a basis without asking the validator to prove a person held this belief.' }));
  record.feedbackAssessments = record.feedbackAssessments.map(item => ({ ...item, assessment: 'unassessable', categoryIds: [],
    linguisticReason: 'Synthetic labels remain evidence declarations, not a cause of the linguistic cue.',
    retainCounterexample: 'An accurate clause remains possible under any supplied label.' }));
  record.overall = { decision: 'retain', reason: 'Complete coverage is separate from the quality of the editorial decision.' };
  return { prepared, record };
}

function compressionDecision(record, prepared) {
  const candidate = required(prepared.analysis)[0];
  assert.ok(candidate, 'The synthetic fixture must contain a required construction.');
  const decision = record.decisions.find(item => item.candidateId === candidate.id);
  assert.ok(decision?.compressionCheck);
  return { candidate, decision };
}

test('three composite construction families generate comparison obligations, including underestimated', () => {
  const cases = [
    [whText, 'appraisal-wh-expansion'],
    ['I overestimated how much it would take to keep the workshop open.', 'appraisal-wh-expansion'],
    [nominalText, 'appraisal-nominal-expansion'],
    ['I realized the level of effort I would need to keep the workshop open.', 'appraisal-nominal-expansion'],
    [lessonText, 'generic-lesson-expansion'],
    ['The workshop taught me that care never stops being important.', 'generic-lesson-expansion'],
    ['The workshop taught me that every setback can become an opportunity.', 'generic-lesson-expansion'],
    ['I learned that each challenge carries a valuable lesson.', 'generic-lesson-expansion']
  ];
  for (const [text, code] of cases) {
    const doc = document(text), before = structuredClone(doc), analysis = analyseEnglishDocument(doc);
    const cue = required(analysis).find(candidate => candidate.code === code);
    assert.ok(cue, code + ': ' + text);
    assert.equal(cue.categoryId, 'information-gain');
    assert.equal(cue.decision, 'unresolved');
    assert.equal(cue.requiresCompressionCheck, true);
    assert.ok(cue.reviewQuestion.trim()); assert.ok(cue.retainCounterexample.trim());
    assert.deepEqual(doc, before);
  }
  const compound = required(analyseEnglishDocument(document(
    'I realized how much it would take to reopen the workshop, and I understood how much it would take to keep the clinic open.')))
    .filter(candidate => candidate.code === 'appraisal-wh-expansion');
  assert.equal(compound.length, 2, 'Distinct appraisals in one sentence need distinct comparison obligations.');
  assert.equal(new Set(compound.map(candidate => candidate.id)).size, 2);
});

test('single wh or that, direct objects, actual questions and procedural explanations remain protected', () => {
  const texts = [
    'I underestimated the repair effort.',
    'I understood the instructions.',
    'I underestimated how difficult the repair would be.',
    'I realized which sensor had failed.',
    'I learned that the oil filter was blocked.',
    'I asked whether the gasket was loose.',
    'I asked what the replacement would cost.',
    'I wrote out why the valve would close.',
    'Before changing the program, I wrote out why the method worked for every input I could define.',
    'I opened the box that held the spare parts.',
    'Every test I ran passed.',
    'Each sensor returned a different reading.',
    'The algorithm examined all inputs.'
  ];
  for (const text of texts) assert.equal(required(analyseEnglishDocument(document(text))).length, 0, text);
});

test('construction components retain exact global Unicode codepoints with a nonzero anchor offset', () => {
  const prefix = 'The log starts here. 🧭 ', quote = '🪶 ' + whText;
  const doc = documentSchema.parse({ revision: 'synthetic-unicode-construction', blocks: [
    { id: 'p1', text: prefix + quote }, { id: 'p2', text: nominalText + '\r\n\r\n' + lessonText }
  ] });
  const anchor = span(quote, Array.from(prefix).length);
  const cues = locateConstructionCues(anchor);
  assert.ok(cues.length);
  for (const cue of cues) {
    assert.equal(cue.requiresCompressionCheck, true);
    assert.ok(cue.components.length >= 2);
    assert.deepEqual(cue.featureLabels, cue.components.map(component => component.feature));
    for (const component of cue.components) {
      exact(doc, component.span);
      assert.ok(component.span.start >= anchor.start && component.span.end <= anchor.end);
      assert.ok(component.feature.trim());
    }
  }
  const analysis = analyseEnglishDocument(doc);
  for (const candidate of required(analysis)) {
    exact(doc, candidate.anchor);
    for (const component of candidate.components) {
      exact(doc, component.span);
      assert.equal(component.span.blockId, candidate.anchor.blockId);
      assert.ok(component.span.start >= candidate.anchor.start && component.span.end <= candidate.anchor.end);
    }
  }
});

test('support, nominal expansions and lesson tails cannot be borrowed across sentence or semicolon boundaries', () => {
  const texts = [
    'I realized the answer. How much would it take to keep the workshop open?',
    'I understood the repair; the amount of patience that it required surprised my partner.',
    'I learned the result; that never changed.',
    'I learned the result. That never changed.',
    'I understood the repair. The amount of patience that it required surprised my partner.'
  ];
  for (const text of texts) {
    assert.equal(required(analyseEnglishDocument(document(text))).length, 0, text);
    assert.equal(locateConstructionCues(span(text)).length, 0, 'Pure locator: ' + text);
  }
});

test('a wh in another overt verb clause does not become the appraisal predicate complement', () => {
  const texts = [
    'I realized Nora explained how much it would take to keep the workshop open.',
    'I understood the answer and Nora asked how much it would take to reopen the room.',
    'I noticed Nora asked whether the workshop would need another table.'
  ];
  for (const text of texts) {
    assert.equal(required(analyseEnglishDocument(document(text))).length, 0, text);
    assert.equal(locateConstructionCues(span(text)).length, 0, text);
  }
});

test('the locator produces unresolved review cues without rewrite, scoring or authorship claims', () => {
  const analysis = analyseEnglishDocument(document([whText, nominalText, lessonText].join(' ')));
  assert.ok(required(analysis).length >= 3);
  assert.equal(analysis.engineVersion, '1.1.0'); assert.equal(LINGUISTIC_ENGINE_VERSION, '1.1.0');
  for (const key of ['automaticRewrite', 'fullSyntacticParse', 'voiceCertified', 'detectorReplicated', 'deliveryAuthorized'])
    assert.equal(analysis[key], false, key);
  assert.ok(!Object.keys(analysis).some(key => /probability|score|verdict/i.test(key)));
  for (const candidate of required(analysis)) {
    assert.equal(candidate.decision, 'unresolved');
    assert.ok(!('replacement' in candidate));
    assert.ok(!Object.keys(candidate).some(key => /probability|score|verdict/i.test(key)));
  }
});

test('new preparation binds the engine, preserves declared references and requires unfinished comparisons', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out);
  const before = await snapshot(out), prepared = await prepareLinguisticReview(root, out, evidence);
  assert.equal(prepared.bindings.engineVersion, '1.1.0');
  assert.deepEqual(prepared.references, evidence.references);
  assert.equal(prepared.references[0].approval, 'unconfirmed');
  assert.throws(() => linguisticReviewSchema.parse(prepared.template));
  const candidates = new Map(prepared.analysis.candidates.map(candidate => [candidate.id, candidate]));
  for (const decision of prepared.template.decisions) {
    const candidate = candidates.get(decision.candidateId);
    assert.equal(Boolean(decision.compressionCheck), Boolean(candidate.requiresCompressionCheck));
    if (candidate.requiresCompressionCheck) {
      assert.equal(decision.compressionCheck.choice, 'unresolved');
      assert.equal(decision.compressionCheck.alternative, '');
      assert.equal(decision.compressionCheck.referenceStatus, 'unavailable');
    }
  }
  assert.deepEqual(await snapshot(out), before);
});

test('source labels and feature tags do not change construction selection or force a rewrite', async t => {
  const { out } = await fixture(t);
  const unknown = await evidenceFor(out), human = await evidenceFor(out, { label: 'human', tags: ['Synthetic human-labeled explanation'] });
  const ai = await evidenceFor(out, { label: 'ai-generated', tags: ['Synthetic disputed grammar label'] });
  const prepared = await Promise.all([unknown, human, ai].map(evidence => prepareLinguisticReview(root, out, evidence)));
  for (const value of prepared.slice(1)) assert.deepEqual(value.analysis, prepared[0].analysis);
  assert.notEqual(prepared[0].bindings.evidenceHash, prepared[1].bindings.evidenceHash);
  assert.ok(prepared.every(value => required(value.analysis).length > 0 && value.voiceCertified === false));
});

test('every targeted construction needs a complete comparison, even when top-level and sentence decisions retain', async t => {
  const { out } = await fixture(t), { prepared, record } = await complete(out);
  const { candidate, decision } = compressionDecision(record, prepared);
  assert.equal((await reviewLinguistic(root, out, record)).reviewDecision, 'recorded');
  const missing = structuredClone(record);
  delete missing.decisions.find(item => item.candidateId === candidate.id).compressionCheck;
  await assert.rejects(reviewLinguistic(root, out, missing), { code: 'linguistic-review-compression' });
  for (const field of ['alternative', 'informationLost', 'contextReason', 'reason', 'referenceReason']) {
    const changed = structuredClone(record);
    changed.decisions.find(item => item.candidateId === candidate.id).compressionCheck[field] = '   ';
    await assert.rejects(reviewLinguistic(root, out, changed), undefined, field);
  }
  assert.ok(decision.compressionCheck.reason.trim());
});

test('preferring an alternative, deleting or leaving the comparison unresolved cannot be hidden by retain', async t => {
  const { out } = await fixture(t), { prepared, record } = await complete(out);
  const { candidate } = compressionDecision(record, prepared);
  for (const choice of ['prefer-alternative', 'delete', 'unresolved']) {
    const changed = structuredClone(record);
    changed.decisions.find(item => item.candidateId === candidate.id).compressionCheck.choice = choice;
    const result = await reviewLinguistic(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework', choice);
    assert.ok(result.rework.candidates.includes(candidate.id));
    assert.equal(result.automaticRewrite, false);
  }
  const unresolvedRole = structuredClone(record);
  unresolvedRole.decisions.find(item => item.candidateId === candidate.id).compressionCheck.complementRole = 'unresolved';
  assert.equal((await reviewLinguistic(root, out, unresolvedRole)).reviewDecision, 'needs-rework');
});

test('unavailable and compared references require honest mutually exclusive declarations', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), { prepared, record } = await complete(out, evidence);
  const { candidate } = compressionDecision(record, prepared), reference = evidence.references[0];
  const referenceItem = { referenceId: reference.id, span: span(reference.document.blocks[0].text),
    relation: 'supports-shorter', reason: 'The declared synthetic example provides a shorter effort object.' };
  const comparedWithoutQuote = structuredClone(record);
  comparedWithoutQuote.decisions.find(item => item.candidateId === candidate.id).compressionCheck.referenceStatus = 'compared';
  await assert.rejects(reviewLinguistic(root, out, comparedWithoutQuote, evidence));
  const unavailableWithQuote = structuredClone(record);
  unavailableWithQuote.decisions.find(item => item.candidateId === candidate.id).compressionCheck.references = [referenceItem];
  await assert.rejects(reviewLinguistic(root, out, unavailableWithQuote, evidence));
  const valid = structuredClone(record), check = valid.decisions.find(item => item.candidateId === candidate.id).compressionCheck;
  check.referenceStatus = 'compared'; check.references = [referenceItem];
  check.referenceReason = 'Use the declared advisor comparison for editing choices, preserving its unconfirmed identity.';
  assert.equal((await reviewLinguistic(root, out, valid, evidence)).reviewDecision, 'recorded');
});

test('reference comparisons use real identities and exact Unicode spans, and changed evidence invalidates them', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), { prepared, record } = await complete(out, evidence);
  const { candidate } = compressionDecision(record, prepared), reference = evidence.references[0];
  const text = reference.document.blocks[0].text, quote = text.slice('🪶 '.length), start = Array.from('🪶 ').length;
  const valid = structuredClone(record), check = valid.decisions.find(item => item.candidateId === candidate.id).compressionCheck;
  check.referenceStatus = 'compared'; check.referenceReason = 'Compare this exact declared reference without inferring authorship.';
  check.references = [{ referenceId: reference.id, span: span(quote, start), relation: 'supports-shorter',
    reason: 'This synthetic wording uses a direct object for the same declared effort judgment.' }];
  assert.equal((await reviewLinguistic(root, out, valid, evidence)).reviewDecision, 'recorded');
  for (const mutate of [
    value => { value.referenceId = 'absent-reference'; },
    value => { value.span.quote = 'A fabricated reference sentence.'; },
    value => { value.span.start = '🪶 '.length; value.span.end = value.span.start + Array.from(quote).length; },
    value => { value.span.blockId = 'absent-block'; },
    value => { value.reason = '  '; }
  ]) {
    const changed = structuredClone(valid);
    mutate(changed.decisions.find(item => item.candidateId === candidate.id).compressionCheck.references[0]);
    await assert.rejects(reviewLinguistic(root, out, changed, evidence));
  }
  const changedEvidence = structuredClone(evidence);
  changedEvidence.references[0].document.blocks[0].text += ' A different synthetic event follows.';
  await assert.rejects(reviewLinguistic(root, out, valid, changedEvidence), { code: 'linguistic-review-stale' });
});

test('a declared reference may retain the same clause family without making the reference a universal template', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out, { referenceText:
    'I realized how much time it would take to keep the clinic open after the lease ended.' });
  const { prepared, record } = await complete(out, evidence), { candidate } = compressionDecision(record, prepared);
  const check = record.decisions.find(item => item.candidateId === candidate.id).compressionCheck;
  check.complementRole = 'procedure-reasoning';
  check.referenceStatus = 'compared';
  check.referenceReason = 'The reference describes a concrete operating limit; its setting and facts do not transfer to this account.';
  check.references = [{ referenceId: evidence.references[0].id, span: span(evidence.references[0].document.blocks[0].text),
    relation: 'necessary-clause', reason: 'A similar surface form may preserve a concrete limit or question in its own setting.' }];
  const result = await reviewLinguistic(root, out, record, evidence);
  assert.equal(result.reviewDecision, 'recorded');
  assert.equal(result.judgmentsVerified, false); assert.equal(result.voiceCertified, false);
  assert.equal(result.evidenceAuthenticityVerified, false); assert.equal(result.detectorReplicated, false);
});

test('all reference comparison roles and resolved complement roles remain explicit review choices', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), { prepared, record } = await complete(out, evidence);
  const { candidate } = compressionDecision(record, prepared);
  for (const relation of ['supports-shorter', 'necessary-clause', 'different-register']) {
    const changed = structuredClone(record), check = changed.decisions.find(item => item.candidateId === candidate.id).compressionCheck;
    check.referenceStatus = 'compared'; check.referenceReason = 'The synthetic role is explicit and remains a reviewer judgment.';
    check.references = [{ referenceId: evidence.references[0].id, span: span(evidence.references[0].document.blocks[0].text), relation,
      reason: 'This role records what the reviewer is comparing, without proving the comparison is sound.' }];
    assert.equal((await reviewLinguistic(root, out, changed, evidence)).reviewDecision, 'recorded');
  }
  for (const role of ['requested-answer', 'procedure-reasoning', 'retrospective-appraisal', 'generic-lesson']) {
    const changed = structuredClone(record);
    changed.decisions.find(item => item.candidateId === candidate.id).compressionCheck.complementRole = role;
    assert.equal((await reviewLinguistic(root, out, changed, evidence)).reviewDecision, 'recorded');
  }
});

test('old engine records stay readable as data but cannot validate against new preparation', async t => {
  const { out } = await fixture(t), { record } = await complete(out), before = await snapshot(out);
  const old = structuredClone(record); old.bindings.engineVersion = '1.0.0';
  assert.equal(linguisticReviewSchema.parse(old).bindings.engineVersion, '1.0.0');
  await assert.rejects(reviewLinguistic(root, out, old), { code: 'linguistic-review-stale' });
  assert.deepEqual(await snapshot(out), before);
});

test('comparison preparation and validation perform no network call, subprocess, database write or source edit', async t => {
  const { out, dir } = await fixture(t), evidence = await evidenceFor(out), { record } = await complete(out, evidence);
  const before = await snapshot(dir), restorers = [], calls = [];
  const block = (target, key) => {
    const previous = target[key]; restorers.push(() => { target[key] = previous; });
    target[key] = () => { calls.push(key); throw new Error('Unexpected external IO: ' + key); };
  };
  block(globalThis, 'fetch');
  for (const target of [http, https]) for (const key of ['request', 'get']) block(target, key);
  for (const key of ['connect', 'createConnection']) block(net, key);
  block(tls, 'connect');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) block(childProcess, key);
  try {
    const prepared = await prepareLinguisticReview(root, out, evidence);
    assert.equal(prepared.automaticRewrite, false);
    const result = await reviewLinguistic(root, out, record, evidence);
    assert.equal(result.reviewDecision, 'recorded'); assert.equal(result.deliveryAuthorized, false);
    assert.ok(!Object.keys(result).some(key => /probability|score|verdict/i.test(key)));
  } finally { for (const restore of restorers.reverse()) restore(); }
  assert.deepEqual(calls, []);
  assert.deepEqual(await snapshot(dir), before);
  assert.ok(!Object.keys(await snapshot(dir)).some(name => /\.sqlite(?:-|$)|\.db(?:-|$)/u.test(name)));
});
