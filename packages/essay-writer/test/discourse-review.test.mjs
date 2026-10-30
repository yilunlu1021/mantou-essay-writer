import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { contextSchema, documentSchema } from '@mantou/text-quality';
import { importSession, loadSession, patchTemplate, reviseSession, DISCOURSE_ENGINE_VERSION,
  analyseDiscourseDocument, prepareDiscourseReview, reviewDiscourse, discourseReviewSchema } from '../dist/index.js';

// Synthetic contracts only. These fixtures assert neither prose quality nor detector performance.
const root = resolve('.');
const context = contextSchema.parse({ language: 'en', genre: 'personal-narrative', authorRole: 'student',
  audience: 'admission reader', prompt: 'Describe a decision while repairing an object.' });
const document = (...texts) => documentSchema.parse({ revision: 'synthetic-discourse',
  blocks: texts.map((text, index) => ({ id: 'p' + (index + 1), text })) });
const baseText = 'I opened the case. The hinge was loose. I tightened it.\n\nThe latch held. I returned the case.';
async function fixture(t, text = baseText) {
  const dir = await mkdtemp(join(tmpdir(), 'humanier-discourse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, text);
  await importSession(root, { input, out, context });
  return { dir, input, out };
}
async function complete(out) {
  const prepared = await prepareDiscourseReview(root, out), value = structuredClone(prepared.template);
  value.windows = value.windows.map(window => ({ ...window,
    sentences: window.sentences.map(sentence => ({ ...sentence,
      informationGain: 'This exact sentence adds the next source-described condition or action.' })),
    readerConnection: 'The reader can follow the object, its condition and the response in sequence.',
    alternative: { kind: 'merge', text: 'Combine the condition and response into one sentence.',
      informationLost: 'The current separation retains the original pause between inspection and action.', choice: 'retain',
      reason: 'Distinct actions remain legible together without an added interpretation.' },
    decision: 'retain', reason: 'The successive sentences each provide an action or condition.' }));
  value.transitions = value.transitions.map(transition => ({ ...transition,
    relation: 'continuation', connection: 'recoverable',
    readerParaphrase: 'The next paragraph continues the handling of the identified object.',
    sourceLimit: 'The sequence establishes only the actions in the supplied account.', decision: 'retain',
    reason: 'The object and ongoing task carry across the paragraph boundary.' }));
  value.order = { ...value.order, alternativeOrder: [...value.order.currentOrder].reverse(),
    currentOrderReason: 'Inspection precedes the response and the immediate result.',
    alternativeOrderReason: 'The reversed order would present the result before its preparation.',
    sourceLimit: 'Reordering is a reading comparison and asserts no new dates or causal events.',
    choice: 'retain', decision: 'retain', reason: 'The present order keeps the source-described actions easy to follow.' };
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
  await visit(directory); return files;
}
test('all short documents use their actual sentence sequence; no empty sentence window is invented', () => {
  for (const [text, count] of [['', 0], ['I opened it.', 1], ['I opened it. It held.', 2], ['I opened it. It held. I left.', 3]]) {
    const result = analyseDiscourseDocument(document(text));
    assert.equal(result.sentences.length, count);
    assert.equal(result.windows.length, count ? 1 : 0);
    assert.equal(result.windows[0]?.sentences.length ?? 0, count);
    assert.equal(result.transitions.length, 0);
    assert.equal(result.judgmentsVerified, false);
  }
});
test('every contiguous three-sentence window crosses blocks and logical paragraph boundaries', () => {
  const result = analyseDiscourseDocument(document('I opened it.\n\nIt held.', 'I closed it. I left.'));
  assert.equal(result.paragraphs.length, 3);
  assert.equal(result.sentences.length, 4);
  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.windows.map(window => window.sentences.map(span => span.quote)), [
    ['I opened it.', 'It held.', 'I closed it.'], ['It held.', 'I closed it.', 'I left.']
  ]);
  assert.deepEqual(result.transitions.map(item => [item.from.quote, item.to.quote]), [
    ['I opened it.', 'It held.'], ['It held.', 'I closed it. I left.']
  ]);
});
test('non-BMP, CRLF, Chinese and repeated identical text keep exact occurrence spans', () => {
  const doc = document('  我拿起🧭。\r\n\r\n我拿起🧭。\r\n\r\n我放下它。  ', '', '我拿起🧭。');
  const result = analyseDiscourseDocument(doc, 'zh');
  assert.equal(result.paragraphs.length, 4);
  assert.equal(result.sentences.length, 4);
  assert.equal(new Set(result.sentences.map(item => item.id)).size, 4);
  assert.equal(new Set(result.windows.map(item => item.id)).size, 2);
  for (const { anchor } of [...result.paragraphs, ...result.sentences]) {
    const text = doc.blocks.find(block => block.id === anchor.blockId).text;
    assert.equal(Array.from(text).slice(anchor.start, anchor.end).join(''), anchor.quote);
  }
  assert.equal(result.sentences[1].anchor.start, Array.from('  我拿起🧭。\r\n\r\n').length);
});
test('preparation is incomplete and preparation plus validation leave the session byte-identical', async t => {
  const { out } = await fixture(t), before = await snapshot(out);
  const prepared = await prepareDiscourseReview(root, out);
  assert.equal(prepared.bindings.engineVersion, DISCOURSE_ENGINE_VERSION);
  assert.equal(Object.keys(prepared.bindings).length, 7);
  assert.equal(prepared.containsDocumentText, true);
  assert.throws(() => discourseReviewSchema.parse(prepared.template));
  const result = await reviewDiscourse(root, out, await complete(out));
  assert.equal(result.reviewDecision, 'recorded');
  assert.equal(result.windowCount, 3);
  assert.equal(result.transitionCount, 1);
  for (const key of ['containsDocumentText', 'judgmentsVerified', 'semanticEquivalenceChecked', 'reasoningCertified',
    'independentReaderVerified', 'voiceCertified', 'detectorReplicated', 'deliveryAuthorized']) assert.equal(result[key], false);
  assert.equal(result.requiresHumanReview, true);
  assert.ok(!JSON.stringify(result).includes('hinge'));
  assert.ok(!JSON.stringify(result).includes('inspection and action'));
  assert.deepEqual(await snapshot(out), before);
});
test('each bound hash and engine version, plus actual edits, invalidate the previous review', async t => {
  const { out } = await fixture(t), value = await complete(out);
  for (const key of Object.keys(value.bindings)) {
    const changed = structuredClone(value); changed.bindings[key] = key === 'engineVersion' ? '0.9.0' : '0'.repeat(64);
    await assert.rejects(reviewDiscourse(root, out, changed), { code: 'discourse-review-stale' });
  }
  const session = await loadSession(root, out);
  await reviseSession(root, out, { ...patchTemplate(session.manifest.context, session.document, session.policy), patches: [{
    blockId: 'p1', start: 2, end: 8, expectedText: 'opened', replacement: 'lifted', reason: 'Use the stated action.'
  }] });
  await assert.rejects(reviewDiscourse(root, out, value), { code: 'discourse-review-stale' });
});
test('full ordered window and transition coverage cannot be dropped, reordered, duplicated or forged', async t => {
  const { out } = await fixture(t, baseText + '\n\nI stored the key. I checked the note.'), value = await complete(out);
  for (const key of ['windows', 'transitions']) {
    for (const alter of [items => items.slice(1), items => [...items].reverse(), items => [items[0], items[0], ...items.slice(2)]]) {
      const changed = structuredClone(value); changed[key] = alter(changed[key]);
      await assert.rejects(reviewDiscourse(root, out, changed), { code: 'discourse-review-' + key });
    }
  }
  for (const target of [value => value.windows[0].sentences[0].anchor, value => value.transitions[0].from, value => value.transitions[0].to]) {
    const changed = structuredClone(value); target(changed).quote = 'An invented detail.';
    await assert.rejects(reviewDiscourse(root, out, changed));
  }
  const changed = structuredClone(value); changed.windows[0].sentences.reverse();
  await assert.rejects(reviewDiscourse(root, out, changed), { code: 'discourse-review-windows' });
});
test('paragraph-order comparison requires the actual current order and a complete genuine alternative', async t => {
  const { out } = await fixture(t), value = await complete(out);
  for (const alter of [order => { order.currentOrder.reverse(); }, order => { order.alternativeOrder.pop(); },
    order => { order.alternativeOrder[0] = '0'.repeat(64); },
    order => { order.alternativeOrder[0] = order.alternativeOrder[1]; },
    order => { order.alternativeOrder = [...order.currentOrder]; }]) {
    const changed = structuredClone(value); alter(changed.order);
    await assert.rejects(reviewDiscourse(root, out, changed), { code: 'discourse-review-order' });
  }
  const single = await fixture(t, 'I opened the case.');
  assert.equal((await reviewDiscourse(root, single.out, await complete(single.out))).reviewDecision, 'recorded');
});
test('comparison and mixed relations require a declared common basis without claiming its truth', async t => {
  const { out } = await fixture(t), value = await complete(out);
  for (const relation of ['comparison', 'mixed']) {
    const changed = structuredClone(value); changed.transitions[0].relation = relation;
    await assert.rejects(reviewDiscourse(root, out, changed), { code: 'discourse-review-comparison' });
    changed.transitions[0].commonBasis = 'Both passages describe the condition of the same case.';
    assert.equal((await reviewDiscourse(root, out, changed)).reviewDecision, 'recorded');
  }
});
test('every explicit local unresolved state, replacement choice and missing link overrides adopt', async t => {
  const { out } = await fixture(t), value = await complete(out);
  const changes = [
    ...['revise', 'needs-source', 'unresolved'].flatMap(status => [
      record => { record.windows[0].decision = status; }, record => { record.transitions[0].decision = status; },
      record => { record.order.decision = status; }]),
    ...['prefer-alternative', 'unresolved'].flatMap(status => [
      record => { record.windows[0].alternative.choice = status; }, record => { record.order.choice = status; }]),
    ...['missing', 'unresolved'].map(status => record => { record.transitions[0].connection = status; }),
    record => { record.recommendation = 'rework'; }
  ];
  for (const alter of changes) {
    const changed = structuredClone(value); alter(changed);
    assert.equal((await reviewDiscourse(root, out, changed)).reviewDecision, 'needs-rework');
  }
});
test('blank reasons and certification claims are rejected; ordinary chronology or topic shifts may remain', async t => {
  const { out } = await fixture(t), value = await complete(out);
  for (const target of [record => { record.windows[0].readerConnection = ' '; },
    record => { record.windows[0].sentences[0].informationGain = ' '; },
    record => { record.windows[0].alternative.informationLost = ' '; },
    record => { record.transitions[0].sourceLimit = ' '; }, record => { record.order.reason = ' '; },
    record => { record.deliveryAuthorized = true; }, record => { record.reviewerRole = 'human'; }]) {
    const changed = structuredClone(value); target(changed);
    await assert.rejects(reviewDiscourse(root, out, changed));
  }
  for (const relation of ['chronology', 'topic-shift']) {
    const changed = structuredClone(value); changed.transitions[0].relation = relation;
    assert.equal((await reviewDiscourse(root, out, changed)).reviewDecision, 'recorded');
  }
});
test('package CLI exposes its schema and read-only preparation plus review commands', async t => {
  const { dir, out } = await fixture(t), before = await snapshot(out);
  const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 4_000_000 });
  const schema = run('schema'); assert.equal(schema.status, 0); assert.ok(JSON.parse(schema.stdout).discourseReview);
  const prepared = run('prepare-discourse-review', '--session', out);
  assert.equal(prepared.status, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).analysis.windows.length, 3);
  const reviewFile = join(dir, 'discourse.json'); await writeFile(reviewFile, JSON.stringify(await complete(out)));
  const result = run('review-discourse', '--session', out, '--review-file', reviewFile);
  assert.equal(result.status, 3, result.stderr); assert.equal(JSON.parse(result.stdout).reviewDecision, 'recorded');
  assert.ok(!result.stdout.includes('hinge')); assert.deepEqual(await snapshot(out), before);
});
