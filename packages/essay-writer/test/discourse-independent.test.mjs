import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { contextSchema, documentSchema } from '@mantou/text-quality';
import { importSession, loadSession, patchTemplate, reviseSession, DISCOURSE_ENGINE_VERSION,
  analyseDiscourseDocument, prepareDiscourseReview, reviewDiscourse, discourseReviewSchema } from '../dist/index.js';

// Independent acceptance fixtures deliberately contain no real student or institution data.
const root = resolve('.');
const context = contextSchema.parse({ language: 'en', genre: 'application-explanatory', authorRole: 'student',
  audience: 'admission reader', prompt: 'Explain an activity and what remains to be learned.' });
const points = value => Array.from(value);
const document = texts => documentSchema.parse({ revision: 'independent-discourse-fixture',
  blocks: (Array.isArray(texts) ? texts : [texts]).map((text, index) => ({ id: 'p' + (index + 1), text })) });
const exact = (doc, anchor) => {
  const block = doc.blocks.find(item => item.id === anchor.blockId);
  assert.ok(block, 'The span uses an existing block.');
  assert.equal(points(block.text).slice(anchor.start, anchor.end).join(''), anchor.quote);
  assert.equal(anchor.end - anchor.start, points(anchor.quote).length);
};
async function fixture(t, text = 'I labelled the compass. The label was incomplete.\n\nMy tutor checked the date.\n\nI corrected it. I still need to learn the cataloguing rules.') {
  const dir = await mkdtemp(join(tmpdir(), 'humanier-discourse-independent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, text);
  await importSession(root, { input, out, context });
  return { dir, input, out };
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
async function complete(out) {
  const prepared = await prepareDiscourseReview(root, out), value = structuredClone(prepared.template);
  value.windows = value.windows.map(item => ({ ...item,
    sentences: item.sentences.map(sentence => ({ ...sentence,
      informationGain: 'This exact synthetic sentence supplies a different action, condition or stated limit.' })),
    readerConnection: 'Read the actions in their stated sequence without inferring an unreported change in character.',
    alternative: { kind: 'merge', text: 'The author labelled and corrected a compass entry after a date check.',
      informationLost: 'Compression would remove the source wording and the distinction between the actions.',
      choice: 'retain', reason: 'The declared current wording keeps the sequence available to the reader.' },
    decision: 'retain', reason: 'This fixture tests complete declarations rather than the truth of editorial judgments.' }));
  value.transitions = value.transitions.map(item => ({ ...item, relation: 'chronology', connection: 'recoverable',
    readerParaphrase: 'The following paragraph continues the account without establishing a causal claim.',
    sourceLimit: 'The fixture declares a sequence; it supplies no independent source for further causal claims.',
    decision: 'retain', reason: 'A declared temporal relation is permissible without a forced transformation.' }));
  value.order = { ...value.order,
    alternativeOrder: [...value.order.currentOrder].reverse(),
    currentOrderReason: 'The current reading order keeps the distinct work and limit in view.',
    alternativeOrderReason: 'Reversing the paragraphs would state the remaining limit before the activity.',
    sourceLimit: 'A reading-order comparison does not establish event dates or causal dependence.',
    choice: 'retain', decision: 'retain', reason: 'The current order is the declared editorial choice.' };
  value.recommendation = 'adopt';
  return { prepared, value };
}

test('independent: one, two, three and five sentences have complete unsuppressed windows', () => {
  for (const count of [1, 2, 3, 5]) {
    const doc = document(['I checked the box.', 'I read the label.', 'I counted the seals.', 'I recorded the count.', 'I put the box back.'].slice(0, count).join(' '));
    const before = structuredClone(doc), analysis = analyseDiscourseDocument(doc);
    assert.equal(analysis.sentences.length, count);
    assert.equal(analysis.windows.length, count < 3 ? 1 : count - 2);
    analysis.windows.forEach((window, index) => {
      assert.deepEqual(window.sentences, analysis.sentences.slice(index, index + 3).map(sentence => sentence.anchor));
      window.sentences.forEach(anchor => exact(doc, anchor));
    });
    assert.equal(analysis.transitions.length, 0);
    assert.deepEqual(doc, before);
  }
});

test('independent: every rolling three-sentence window crosses logical paragraph and block boundaries', () => {
  const doc = document(['I opened the box.\n\nI checked the label.', 'I counted the seals.', 'I recorded the count. I closed the box.']);
  const analysis = analyseDiscourseDocument(doc);
  assert.equal(analysis.paragraphs.length, 4);
  assert.equal(analysis.sentences.length, 5);
  assert.equal(analysis.windows.length, 3);
  assert.equal(analysis.transitions.length, 3);
  assert.deepEqual(analysis.windows[0].sentences.map(item => item.blockId), ['p1', 'p1', 'p2']);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(analysis.transitions[i].from, analysis.paragraphs[i].anchor);
    assert.deepEqual(analysis.transitions[i].to, analysis.paragraphs[i + 1].anchor);
  }
});

test('independent: Unicode codepoints, CRLF, whitespace-only blocks and repeated occurrences retain exact positions', () => {
  const doc = document(['  🧭 I read the label.\r\n\r\n \r\nI read the label.  ', ' \r\n\r\n ', 'I read the label.']);
  const analysis = analyseDiscourseDocument(doc);
  assert.equal(analysis.paragraphs.length, 3);
  assert.equal(analysis.sentences.length, 3);
  assert.equal(analysis.windows.length, 1);
  assert.equal(analysis.transitions.length, 2);
  for (const item of [...analysis.paragraphs, ...analysis.sentences]) exact(doc, item.anchor);
  assert.equal(analysis.paragraphs[0].anchor.start, 2);
  const repeat = analyseDiscourseDocument(document(['I read the label.\n\nI read the label.', 'I read the label.']));
  assert.equal(new Set(repeat.sentences.map(item => item.id)).size, 3);
  assert.equal(new Set(repeat.paragraphs.map(item => item.id)).size, 3);
  assert.equal(new Set(repeat.transitions.map(item => item.id)).size, 2);
});

test('independent: empty input yields no invented paragraph, sentence, window or transition', () => {
  const analysis = analyseDiscourseDocument(document(['', ' \r\n\r\n ']));
  for (const key of ['paragraphs', 'sentences', 'windows', 'transitions']) assert.deepEqual(analysis[key], [], key);
});

test('independent: Chinese sentences also produce continuous windows and adjacent boundaries', () => {
  const doc = document(['我打开盒子。标签缺少日期。\r\n\r\n我问了老师。', '她指向登记簿。我补上日期。']);
  const analysis = analyseDiscourseDocument(doc, 'zh');
  assert.equal(analysis.sentences.length, 5);
  assert.equal(analysis.paragraphs.length, 3);
  assert.equal(analysis.windows.length, 3);
  assert.equal(analysis.transitions.length, 2);
  analysis.sentences.forEach(item => exact(doc, item.anchor));
});

test('independent: preparation is deliberately unfinished, engine-bound and read-only', async t => {
  const { out } = await fixture(t), before = await snapshot(out), prepared = await prepareDiscourseReview(root, out);
  assert.equal(DISCOURSE_ENGINE_VERSION, '1.0.0');
  assert.equal(prepared.bindings.engineVersion, DISCOURSE_ENGINE_VERSION);
  assert.equal(Object.keys(prepared.bindings).length, 7);
  assert.throws(() => discourseReviewSchema.parse(prepared.template));
  assert.equal(prepared.containsDocumentText, true);
  assert.equal(prepared.requiresHumanReview, true);
  assert.equal(prepared.deliveryAuthorized, false);
  assert.deepEqual(await snapshot(out), before);
});

test('independent: a recorded review proves coverage rather than meaning, voice, authorship or submission approval', async t => {
  const { out } = await fixture(t), { value } = await complete(out), before = await snapshot(out);
  const result = await reviewDiscourse(root, out, value);
  assert.equal(result.reviewDecision, 'recorded');
  assert.equal(result.referencesVerified, true);
  for (const key of ['containsDocumentText', 'semanticEquivalenceChecked', 'judgmentsVerified', 'voiceCertified',
    'reasoningCertified', 'independentReaderVerified', 'deliveryAuthorized', 'automaticRewrite']) assert.equal(result[key], false, key);
  assert.ok(!JSON.stringify(result).includes('compass'));
  assert.ok(!JSON.stringify(result).includes('declared temporal'));
  assert.ok(!Object.keys(result).some(key => /probability|score|verdict/i.test(key)));
  assert.deepEqual(await snapshot(out), before);
});

test('independent: every binding and an actual later revision invalidate the old review', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const key of Object.keys(value.bindings)) {
    const invalid = structuredClone(value);
    invalid.bindings[key] = key === 'engineVersion' ? '0.9.0' : '0'.repeat(64);
    await assert.rejects(reviewDiscourse(root, out, invalid), { code: 'discourse-review-stale' }, key);
  }
  const s = await loadSession(root, out);
  await reviseSession(root, out, { ...patchTemplate(s.manifest.context, s.document, s.policy), patches: [{
    blockId: 'p1', start: 2, end: 10, expectedText: 'labelled', replacement: 'inspected', reason: 'Correct the synthetic action.'
  }] });
  await assert.rejects(reviewDiscourse(root, out, value), { code: 'discourse-review-stale' });
});

test('independent: missing, duplicated and reordered windows cannot pass complete coverage', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  assert.ok(value.windows.length > 1);
  for (const mutate of [v => v.windows.pop(), v => v.windows.push(structuredClone(v.windows[0])),
    v => v.windows.reverse(), v => { v.windows[0].windowId = v.windows[1].windowId; },
    v => { v.windows[0].windowId = 'unrecognized-window'; }]) {
    const invalid = structuredClone(value); mutate(invalid);
    await assert.rejects(reviewDiscourse(root, out, invalid));
  }
});

test('independent: sentence substitutions, reordering and extra references cannot borrow another window', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const mutate of [v => v.windows[0].sentences.pop(),
    v => v.windows[0].sentences.push(structuredClone(v.windows[0].sentences[0])),
    v => v.windows[0].sentences.reverse(),
    v => { v.windows[0].sentences[0] = structuredClone(v.windows.at(-1).sentences.at(-1)); },
    v => { v.windows[0].sentences[0].anchor.quote = 'A fabricated action.'; },
    v => { v.windows[0].sentences[0].anchor.blockId = 'absent-block'; }]) {
    const invalid = structuredClone(value); mutate(invalid);
    await assert.rejects(reviewDiscourse(root, out, invalid));
  }
});

test('independent: all and only adjacent paragraph transitions must occur in the prepared order', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  assert.equal(value.transitions.length, 2);
  for (const mutate of [v => v.transitions.pop(), v => v.transitions.push(structuredClone(v.transitions[0])),
    v => v.transitions.reverse(), v => { v.transitions[0].transitionId = v.transitions[1].transitionId; },
    v => { v.transitions[0].from = structuredClone(v.transitions[1].from); },
    v => { v.transitions[0].to = structuredClone(v.transitions[1].to); },
    v => { [v.transitions[0].from, v.transitions[0].to] = [v.transitions[0].to, v.transitions[0].from]; },
    v => { v.transitions[0].from.quote = 'Invented paragraph.'; }]) {
    const invalid = structuredClone(value); mutate(invalid);
    await assert.rejects(reviewDiscourse(root, out, invalid));
  }
});

test('independent: whole-reading order requires an exact current order and a genuine alternative permutation', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const mutate of [v => v.order.currentOrder.reverse(), v => v.order.currentOrder.pop(),
    v => { v.order.alternativeOrder = [...v.order.currentOrder]; },
    v => v.order.alternativeOrder.pop(), v => v.order.alternativeOrder.push(v.order.alternativeOrder[0]),
    v => { v.order.alternativeOrder[0] = 'invented-paragraph'; },
    v => { v.order.alternativeOrder[0] = v.order.alternativeOrder[1]; }]) {
    const invalid = structuredClone(value); mutate(invalid);
    await assert.rejects(reviewDiscourse(root, out, invalid));
  }
});

test('independent: repeated text cannot impersonate another exact positional sentence', async t => {
  const { out } = await fixture(t, 'I checked the label. I checked the label. I checked the label. I put it back.'), { value } = await complete(out);
  const invalid = structuredClone(value);
  invalid.windows[0].sentences[0].anchor = structuredClone(invalid.windows[0].sentences[1].anchor);
  assert.equal(invalid.windows[0].sentences[0].anchor.quote, value.windows[0].sentences[0].anchor.quote);
  await assert.rejects(reviewDiscourse(root, out, invalid));
});

test('independent: every local decision and alternative choice overrides adopt', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const section of ['windows', 'transitions', 'order']) for (const decision of ['revise', 'needs-source', 'unresolved']) {
    const changed = structuredClone(value), item = section === 'order' ? changed.order : changed[section][0];
    item.decision = decision;
    assert.equal((await reviewDiscourse(root, out, changed)).reviewDecision, 'needs-rework', section + '/' + decision);
  }
  for (const choice of ['prefer-alternative', 'unresolved']) for (const section of ['windows', 'order']) {
    const changed = structuredClone(value), item = section === 'order' ? changed.order : changed.windows[0].alternative;
    item.choice = choice;
    assert.equal((await reviewDiscourse(root, out, changed)).reviewDecision, 'needs-rework', section + '/' + choice);
  }
  for (const connection of ['missing', 'unresolved']) {
    const changed = structuredClone(value); changed.transitions[0].connection = connection;
    assert.equal((await reviewDiscourse(root, out, changed)).reviewDecision, 'needs-rework', connection);
  }
  const changed = structuredClone(value); changed.recommendation = 'rework';
  assert.equal((await reviewDiscourse(root, out, changed)).reviewDecision, 'needs-rework');
});

test('independent: comparison and mixed relations require an explicit nonblank common basis or mixed-relation declaration', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const relation of ['comparison', 'mixed']) {
    const changed = structuredClone(value); changed.transitions[0].relation = relation;
    delete changed.transitions[0].commonBasis;
    await assert.rejects(reviewDiscourse(root, out, changed));
    changed.transitions[0].commonBasis = '   ';
    await assert.rejects(reviewDiscourse(root, out, changed));
    changed.transitions[0].commonBasis = 'The paragraphs contrast two declared stages of work on the same record.';
    assert.equal((await reviewDiscourse(root, out, changed)).reviewDecision, 'recorded');
  }
});

test('independent: all required reasoning fields reject whitespace and certification cannot be injected', async t => {
  const { out } = await fixture(t), { value } = await complete(out);
  for (const path of [['windows', 0, 'readerConnection'], ['windows', 0, 'sentences', 0, 'informationGain'],
    ['windows', 0, 'alternative', 'text'], ['windows', 0, 'alternative', 'informationLost'],
    ['windows', 0, 'alternative', 'reason'], ['windows', 0, 'reason'], ['transitions', 0, 'readerParaphrase'],
    ['transitions', 0, 'sourceLimit'], ['transitions', 0, 'reason'], ['order', 'currentOrderReason'],
    ['order', 'alternativeOrderReason'], ['order', 'sourceLimit'], ['order', 'reason']]) {
    const invalid = structuredClone(value); let object = invalid;
    for (const key of path.slice(0, -1)) object = object[key];
    object[path.at(-1)] = '   ';
    await assert.rejects(reviewDiscourse(root, out, invalid), undefined, path.join('.'));
  }
  for (const fields of [{ humanApproved: true }, { reviewerRole: 'human' }, { methodVersion: '1.3.0' },
    { voiceCertified: true }, { detectorReplicated: true }]) await assert.rejects(reviewDiscourse(root, out, { ...value, ...fields }));
  const invalid = structuredClone(value); invalid.windows[0].reasoningCertified = true;
  await assert.rejects(reviewDiscourse(root, out, invalid));
});

test('independent: one or two sentence sessions validate without fabricated triples or alternative orders', async t => {
  for (const text of ['I checked the date.', 'I checked the date. I corrected the label.']) {
    const { out } = await fixture(t, text), { prepared, value } = await complete(out);
    assert.equal(prepared.analysis.windows.length, 1);
    assert.equal(value.transitions.length, 0);
    assert.equal(value.order.currentOrder.length, 1);
    assert.equal((await reviewDiscourse(root, out, value)).reviewDecision, 'recorded');
  }
});

test('independent: SDK preparation and review call no network, subprocess or database and preserve every session byte', async t => {
  const { dir, out } = await fixture(t), { value } = await complete(out), before = await snapshot(dir);
  const calls = [], restorers = [];
  const block = (object, key) => { const old = object[key]; restorers.push(() => { object[key] = old; });
    object[key] = () => { calls.push(key); throw new Error('Unexpected external operation: ' + key); }; };
  block(globalThis, 'fetch');
  for (const object of [http, https]) for (const key of ['request', 'get']) block(object, key);
  for (const key of ['connect', 'createConnection']) block(net, key);
  block(tls, 'connect');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) block(childProcess, key);
  try {
    await prepareDiscourseReview(root, out);
    assert.equal((await reviewDiscourse(root, out, value)).reviewDecision, 'recorded');
  } finally { for (const restore of restorers.reverse()) restore(); }
  assert.deepEqual(calls, []);
  assert.deepEqual(await snapshot(dir), before);
  assert.ok(!Object.keys(await snapshot(dir)).some(path => /\.sqlite(?:-|$)|\.db(?:-|$)/u.test(path)));
});

test('independent: CLI schema and read-only commands agree with SDK and return no prose in result', async t => {
  const { dir, out } = await fixture(t), { value } = await complete(out), before = await snapshot(out);
  const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 3_000_000 });
  const schema = run('schema'); assert.equal(schema.status, 0, schema.stderr);
  assert.ok(JSON.parse(schema.stdout).discourseReview);
  const prepared = run('prepare-discourse-review', '--session', out); assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(JSON.parse(prepared.stdout).bindings, value.bindings);
  const reviewFile = join(dir, 'review.json'); await writeFile(reviewFile, JSON.stringify(value));
  const reviewed = run('review-discourse', '--session', out, '--review-file', reviewFile);
  assert.equal(reviewed.status, 3, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).reviewDecision, 'recorded');
  assert.ok(!reviewed.stdout.includes('compass'));
  assert.deepEqual(await snapshot(out), before);
});
