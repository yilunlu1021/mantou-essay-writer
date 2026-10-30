import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { contextSchema } from '@mantou/text-quality';
import { importSession, loadSession, patchTemplate, reviseSession, prepareSourceReview, reviewSource,
  prepareAnswerReview, reviewAnswer, answerReviewSchema } from '../dist/index.js';

const root = resolve('.');
const context = contextSchema.parse({ language: 'en', genre: 'application-explanatory', authorRole: 'student',
  audience: 'admission reader', prompt: 'What do you want to learn and why?' });
const span = (quote, blockId = 'p1', start = 0) => ({ blockId, start, end: start + Array.from(quote).length, quote });
async function fixture(t, text = 'I catalogued the broken compass.\n\nMy tutor checked the label. I revised it.\n\nI want to learn conservation before handling older objects.') {
  const dir = await mkdtemp(join(tmpdir(), 'humanier-answer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, text);
  await importSession(root, { input, out, context });
  return { dir, input, out };
}
async function record(out) {
  const prepared = await prepareAnswerReview(root, out);
  const value = structuredClone(prepared.template);
  const blocks = prepared.document.blocks.map(block => span(block.text, block.id));
  value.response = { status: 'answered', promptInterpretation: 'Explain the learning goal and its reason.',
    readerTakeaway: 'The author wants training before further conservation work.', anchors: blocks,
    reason: 'The work and the proposed next learning step are stated together.' };
  value.relations = blocks.length > 1 ? [{ from: blocks[0], to: blocks.at(-1), type: 'plan',
    status: 'supported', reason: 'The stated plan follows the work described earlier.' }] : [];
  value.relationsReason = blocks.length > 1 ? 'The main relationship links the earlier work to the proposed study.' :
    'The single direct statement has no distinct relationship to another assertion.';
  value.conclusions = [{ anchor: blocks.at(-1), type: 'plan', scope: 'A proposed personal learning step.',
    status: 'proportionate', reason: 'The statement describes an intention and promises no result.' }];
  value.conclusionsReason = 'The final statement is reviewed as a plan rather than a proved result.';
  value.selection = { status: 'relevant', anchors: blocks, reason: 'The work and limits explain the requested preparation.' };
  value.standaloneRead = { status: 'clear', anchors: blocks,
    reason: 'The account identifies the object, action and next step without relying on editing notes.', questions: [] };
  value.recommendation = 'adopt';
  return value;
}
async function snapshot(directory) {
  const files = {};
  async function visit(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name, path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path, name + '/');
      else files[name] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await visit(directory);
  return files;
}
test('preparation is incomplete, bound, and explicit about the limits of Agent review', async t => {
  const { out } = await fixture(t);
  const before = await snapshot(out);
  const prepared = await prepareAnswerReview(root, out);
  assert.equal(prepared.methodVersion, '1.4.0');
  assert.equal(Object.keys(prepared.bindings).length, 6);
  assert.equal(prepared.context.prompt, context.prompt);
  assert.equal(prepared.template.response.status, 'unanswered');
  assert.equal(prepared.containsDocumentText, true);
  assert.equal(prepared.requiresHumanReview, true);
  assert.equal(prepared.deliveryAuthorized, false);
  assert.throws(() => answerReviewSchema.parse(prepared.template));
  assert.deepEqual(await snapshot(out), before);
});
test('recorded verifies references and states without approving meaning, authorship or independent reading', async t => {
  const { out } = await fixture(t);
  const value = await record(out);
  value.projectRoles = { status: 'clear', reason: 'The label check and revision have distinct actors.', entries: [
    { anchor: span('My tutor checked the label.', 'p2'), actor: 'teacher', contribution: 'Checked the label.' },
    { anchor: span('I revised it.', 'p2', Array.from('My tutor checked the label. ').length), actor: 'self', contribution: 'Revised the label.' }
  ] };
  const before = await snapshot(out), result = await reviewAnswer(root, out, value);
  assert.equal(result.reviewDecision, 'recorded');
  assert.equal(result.referencesVerified, true);
  assert.ok(result.referenceCount > 0);
  for (const key of ['containsDocumentText', 'semanticEquivalenceChecked', 'voiceCertified', 'reasoningCertified',
    'independentReaderVerified', 'deliveryAuthorized']) assert.equal(result[key], false);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.projectRoleCount, 2);
  assert.ok(!JSON.stringify(result).includes('compass'));
  assert.ok(!JSON.stringify(result).includes('Checked the label'));
  assert.deepEqual(await snapshot(out), before);
});
test('each of the six bindings is checked and an actual revision invalidates an older review', async t => {
  const { out } = await fixture(t);
  const value = await record(out);
  for (const key of Object.keys(value.bindings)) {
    const changed = structuredClone(value); changed.bindings[key] = '0'.repeat(64);
    await assert.rejects(reviewAnswer(root, out, changed), { code: 'answer-review-stale' });
  }
  const s = await loadSession(root, out);
  await reviseSession(root, out, { ...patchTemplate(s.manifest.context, s.document, s.policy), patches: [{
    blockId: 'p1', start: 2, end: 12, expectedText: 'catalogued', replacement: 'inspected', reason: 'Correct the stated work.'
  }] });
  await assert.rejects(reviewAnswer(root, out, value), { code: 'answer-review-stale' });
});
test('every reference location rejects forged text, nonexistent blocks and invalid codepoint ranges', async t => {
  const { out } = await fixture(t);
  const value = await record(out);
  value.standaloneRead.questions = [{ anchor: value.response.anchors[0], question: 'What object was handled?',
    status: 'resolved', reason: 'The compass is explicitly identified.' }];
  value.projectRoles = { status: 'clear', reason: 'The actor performs the stated action.', entries: [
    { anchor: value.response.anchors[0], actor: 'self', contribution: 'Catalogued the object.' }
  ] };
  const targets = value => [value.response.anchors[0], value.relations[0].from, value.relations[0].to,
    value.conclusions[0].anchor, value.selection.anchors[0], value.standaloneRead.anchors[0],
    value.standaloneRead.questions[0].anchor, value.projectRoles.entries[0].anchor];
  for (let i = 0; i < targets(value).length; i++) {
    const changed = structuredClone(value); targets(changed)[i].quote = 'An invented event.';
    await assert.rejects(reviewAnswer(root, out, changed), { code: 'answer-review-span' });
  }
  for (const fields of [{ blockId: 'missing' }, { end: 9999 }, { start: 5, end: 3 }, { start: 3, end: 3 }]) {
    const changed = structuredClone(value); Object.assign(changed.response.anchors[0], fields);
    await assert.rejects(reviewAnswer(root, out, changed), { code: 'answer-review-span' });
  }
  const invalid = structuredClone(value); invalid.response.anchors[0].start = -1;
  await assert.rejects(reviewAnswer(root, out, invalid));
});
test('non-BMP references use codepoints, and whitespace cannot serve as evidence', async t => {
  const { out } = await fixture(t, 'I held 🧭. I want to learn conservation.');
  const value = await record(out);
  value.conclusions[0].anchor = span('I want to learn conservation.', 'p1', Array.from('I held 🧭. ').length);
  assert.equal((await reviewAnswer(root, out, value)).reviewDecision, 'recorded');
  const wrong = structuredClone(value); wrong.conclusions[0].anchor.start = 'I held 🧭. '.length;
  await assert.rejects(reviewAnswer(root, out, wrong), { code: 'answer-review-span' });
  const blank = structuredClone(value); blank.selection.anchors = [span(' ', 'p1', 1)];
  await assert.rejects(reviewAnswer(root, out, blank), { code: 'answer-review-span' });
});
test('empty reasons and extra certification fields are rejected without trusting a claimed human role', async t => {
  const { out } = await fixture(t);
  const value = await record(out);
  for (const path of [['response', 'promptInterpretation'], ['response', 'readerTakeaway'], ['response', 'reason'],
    ['relations', 0, 'reason'], ['relationsReason'], ['conclusions', 0, 'scope'], ['conclusions', 0, 'reason'],
    ['conclusionsReason'], ['selection', 'reason'], ['standaloneRead', 'reason']]) {
    const changed = structuredClone(value); let object = changed;
    for (const key of path.slice(0, -1)) object = object[key];
    object[path.at(-1)] = '  ';
    await assert.rejects(reviewAnswer(root, out, changed));
  }
  for (const fields of [{ humanApproved: true }, { reviewerRole: 'human' }, { methodVersion: '1.1.0' }])
    await assert.rejects(reviewAnswer(root, out, { ...value, ...fields }));
  const nested = structuredClone(value); nested.response.reasoningCertified = true;
  await assert.rejects(reviewAnswer(root, out, nested));
});
test('an adopt recommendation cannot override unanswered prompts, missing conditions or overreach', async t => {
  const { out } = await fixture(t);
  const value = await record(out);
  for (const [key, statuses] of [['response', ['unanswered', 'rework']], ['selection', ['padding', 'rework']],
    ['standaloneRead', ['unresolved', 'rework']]]) {
    for (const status of statuses) {
      const changed = structuredClone(value); changed[key].status = status;
      assert.equal((await reviewAnswer(root, out, changed)).reviewDecision, 'needs-rework');
    }
  }
  for (const status of ['missing-condition', 'overreach', 'rework']) {
    const changed = structuredClone(value); changed.relations[0].status = status;
    const result = await reviewAnswer(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework'); assert.deepEqual(result.rework.relations, [1]);
  }
  for (const status of ['overreach', 'rework']) {
    const changed = structuredClone(value); changed.conclusions[0].status = status;
    const result = await reviewAnswer(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework'); assert.deepEqual(result.rework.conclusions, [1]);
  }
  value.recommendation = 'rework';
  assert.equal((await reviewAnswer(root, out, value)).reviewDecision, 'needs-rework');
});
test('source coverage cannot resolve a missing cause, irrelevant material or a generalized conclusion', async t => {
  const { out } = await fixture(t, 'I avoided the exhibit workshop.\n\nMy tutor arrived. I became confident.\n\nNow I know how all museums earn public trust.');
  const source = (await prepareSourceReview(root, out)).template;
  source.passages = source.passages.map(passage => ({ ...passage, sources: [passage.candidate],
    semanticStatus: 'preserved', semanticNote: 'The source and candidate are identical.',
    voiceStatus: 'preserved', voiceNote: 'The original direct assertion remains unchanged.',
    relevanceStatus: 'relevant', relevanceNote: 'The original assertions have been retained for whole-answer review.', verdict: 'retain' }));
  source.wholeDocument = { verdict: 'retain', standaloneReason: 'The source account is unchanged.',
    interchangeabilityReason: 'The workshop is identified.', endingReason: 'The original judgment is preserved.' };
  assert.equal((await reviewSource(root, out, source)).reviewDecision, 'recorded');
  const value = await record(out);
  value.relations[0] = { from: span('My tutor arrived.', 'p2'), to: span('I became confident.', 'p2', 18),
    type: 'cause', status: 'missing-condition', reason: 'Arrival alone does not explain the change in confidence.' };
  value.conclusions[0] = { ...value.conclusions[0], type: 'inference', status: 'overreach',
    scope: 'The one workshop cannot establish how all museums earn public trust.',
    reason: 'The final generalization exceeds the described event.' };
  value.selection.status = 'rework';
  value.selection.reason = 'Preserving the original assertion is insufficient justification for retaining it.';
  const result = await reviewAnswer(root, out, value);
  assert.equal(result.reviewDecision, 'needs-rework');
  assert.deepEqual(result.rework.relations, [1]); assert.deepEqual(result.rework.conclusions, [1]);
  assert.equal(result.rework.selection, true);
});
test('unresolved reading questions and project roles remain rework even when parent statuses are clear', async t => {
  const { out } = await fixture(t);
  const value = await record(out);
  value.standaloneRead.questions = [{ anchor: value.response.anchors.at(-1),
    question: 'How does the proposed course address the described difficulty?', status: 'unresolved',
    reason: 'A resource name does not by itself explain the learning connection.' }];
  let result = await reviewAnswer(root, out, value);
  assert.equal(result.reviewDecision, 'needs-rework'); assert.deepEqual(result.rework.unresolvedQuestions, [1]);
  value.standaloneRead.questions[0].status = 'resolved';
  value.standaloneRead.questions[0].reason = 'The named learning objective is connected to handling the objects.';
  value.projectRoles = { status: 'unresolved', reason: 'The use of the tool is not distinguished from the author work.', entries: [
    { anchor: value.response.anchors[0], actor: 'tool', contribution: 'The role is still being checked.' }
  ] };
  result = await reviewAnswer(root, out, value);
  assert.equal(result.reviewDecision, 'needs-rework'); assert.equal(result.rework.projectRoles, true);
});
test('plain context, chronology, personal feeling and bounded plans need no forced growth narrative', async t => {
  const { out } = await fixture(t, 'The archive opened at nine.\n\nI was pleased to finish the label.\n\nI plan to study conservation.');
  const value = await record(out);
  value.relations[0] = { from: value.response.anchors[0], to: value.response.anchors[1], type: 'chronology',
    status: 'supported', reason: 'The opening time provides ordinary context for the following work.' };
  value.conclusions.push({ anchor: value.response.anchors[1], type: 'feeling', scope: 'The author personal satisfaction.',
    status: 'proportionate', reason: 'A subjective feeling does not claim general expertise.' });
  assert.equal((await reviewAnswer(root, out, value)).reviewDecision, 'recorded');
  value.relations = [];
  value.relationsReason = 'The account directly states context and intention without asserting a causal transformation.';
  value.conclusions = [];
  value.conclusionsReason = 'No further conclusion is asserted beyond the direct description.';
  assert.equal((await reviewAnswer(root, out, value)).reviewDecision, 'recorded');
});
test('package CLI exposes the schema and both read-only answer-review commands', async t => {
  const { dir, out } = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 2_000_000 });
  const schema = run('schema'); assert.equal(schema.status, 0);
  assert.ok(JSON.parse(schema.stdout).answerReview);
  const before = await snapshot(out), prepared = run('prepare-answer-review', '--session', out);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).template.methodVersion, '1.4.0');
  const reviewFile = join(dir, 'answer-review.json'); await writeFile(reviewFile, JSON.stringify(await record(out)));
  const result = run('review-answer', '--session', out, '--review-file', reviewFile);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(JSON.parse(result.stdout).reviewDecision, 'recorded');
  assert.ok(!result.stdout.includes('compass'));
  assert.deepEqual(await snapshot(out), before);
});
