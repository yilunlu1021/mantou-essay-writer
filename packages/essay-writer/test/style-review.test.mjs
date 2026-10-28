import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { contextSchema, documentSchema, hashValue } from '@mantou/text-quality';
import { importSession, loadSession, patchTemplate, reviseSession, prepareStyleReview, reviewStyle,
  styleReviewSchema, styleEvidenceSchema, logicalParagraphAnchors } from '../dist/index.js';

const root = resolve('.');
const context = contextSchema.parse({ language: 'en', genre: 'application-explanatory', authorRole: 'student',
  audience: 'admission reader', prompt: 'What would you like to learn?' });
const span = (quote, blockId = 'p1', start = 0) => ({ blockId, start, end: start + Array.from(quote).length, quote });
const document = (text, revision = 'evidence') => documentSchema.parse({ revision, blocks: [{ id: 'p1', text }] });
async function fixture(t, text = 'I catalogued the bronze key.\n\nI want to study how museums conserve objects.', language = 'en') {
  const dir = await mkdtemp(join(tmpdir(), 'humanier-style-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), out = join(dir, 'session');
  await writeFile(input, text);
  await importSession(root, { input, out, context: { ...context, language } });
  return { dir, input, out };
}
async function evidenceFor(out) {
  const s = await loadSession(root, out);
  const current = s.document, old = document('I reviewed the exhibit guide.');
  return styleEvidenceSchema.parse({ schemaVersion: '1.0.0',
    references: [{ id: 'example', origin: 'user-confirmed-edit', authorRole: 'advisor', approval: 'user-confirmed',
      document: document('I checked the label twice.'), note: 'Advisor example, not the student original or a source of student facts.' }],
    reports: [current, old].map((testedDocument, i) => ({ id: i === 0 ? 'now' : 'old', toolName: 'Example review tool',
      modelVersion: null, observedAt: null, testedDocument, testedDocumentHash: hashValue(testedDocument),
      documentLabel: i === 0 ? 'unknown' : 'mixed', labelSource: i === 0 ? 'not-provided' : 'user-reported', rawScore: null,
      comments: [{ anchor: span(testedDocument.blocks[0].text), featureTags: ['Plain syntax'], explanation: null, observedStrength: null }],
      sourceArtifacts: [{ kind: 'image', sha256: 'a'.repeat(64) }] })) });
}
async function record(out, evidence) {
  const prepared = await prepareStyleReview(root, out, evidence);
  const value = structuredClone(prepared.template);
  value.paragraphs = value.paragraphs.map((paragraph, i) => ({ ...paragraph, purpose: 'Distinct function ' + i,
    concreteContent: 'The explicit action or intended study in this paragraph.', status: 'distinct',
    reason: 'The paragraph adds a separate action or an intended next step.' }));
  value.languageChecks = value.languageChecks.map(item => ({ ...item, anchors: [prepared.paragraphs[0]],
    observation: 'The concrete catalogue action or a stated study plan is expressed directly.', decision: 'retain',
    reason: 'No unsupported qualification or decorative tail is needed in this short synthetic account.',
    retainCounterexample: 'A necessary first-person plan and precise object name may be retained.' }));
  value.patternsReason = 'No repeated paragraph function requires revision in this short account.';
  value.voice = { status: 'unavailable', anchors: [], preserve: 'Keep direct descriptions of the work.',
    avoidCopying: 'Do not infer student authorship from an advisor example.', reason: 'No suitable student voice comparison is available.' };
  value.feedback = value.feedback.map(item => ({ ...item,
    anchors: item.scope === 'current' ? [prepared.paragraphs[0]] : [],
    hypothesis: 'A plain sentence may have prompted the comment, but this is an editing hypothesis.',
    qualityDecision: 'retain', reason: 'The sentence supplies necessary context; historical comments do not retest this draft.',
    retainCounterexample: 'Necessary technical nouns and direct plans can remain ordinary sentences.' }));
  value.feedbackReason = value.feedback.length ? 'Each observed comment is considered separately from the editing decision.' :
    'No detection comments were supplied; no result is inferred.';
  value.protectedChoices[0].reason = 'The plain factual statement supplies necessary context.';
  value.overall = { status: 'retain', reason: 'The distinct work and study statements serve different functions.' };
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
test('empty evidence produces a bound, incomplete template without requiring fabricated references or detector results', async t => {
  const { out } = await fixture(t), before = await snapshot(out);
  const prepared = await prepareStyleReview(root, out);
  assert.equal(prepared.methodVersion, '1.4.0');
  assert.equal(Object.keys(prepared.bindings).length, 7);
  assert.deepEqual(prepared.evidence, { schemaVersion: '1.0.0', references: [], reports: [] });
  assert.deepEqual(prepared.reportScopes, []);
  assert.equal(prepared.template.voice.status, 'unavailable');
  assert.throws(() => styleReviewSchema.parse(prepared.template));
  assert.equal((await reviewStyle(root, out, await record(out))).reviewDecision, 'recorded');
  assert.deepEqual(await snapshot(out), before);
});
test('current and historical snapshots retain declared provenance without authenticating or repeating private text', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), before = await snapshot(out);
  const prepared = await prepareStyleReview(root, out, evidence);
  assert.equal(prepared.evidence.references[0].authorRole, 'advisor');
  assert.equal(prepared.template.voice.status, 'unavailable');
  assert.deepEqual(prepared.reportScopes.map(item => item.scope), ['current', 'historical']);
  const result = await reviewStyle(root, out, await record(out, evidence), evidence);
  assert.equal(result.reviewDecision, 'recorded');
  assert.deepEqual(result.reportScopes, prepared.reportScopes);
  for (const key of ['containsDocumentText', 'semanticEquivalenceChecked', 'voiceCertified', 'evidenceAuthenticityVerified',
    'detectorReplicated', 'independentReaderVerified', 'deliveryAuthorized']) assert.equal(result[key], false);
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.paragraphCoverageVerified, true);
  assert.ok(!JSON.stringify(result).includes('bronze'));
  assert.ok(!JSON.stringify(result).includes('Plain syntax'));
  assert.deepEqual(await snapshot(out), before);
});
test('all seven bindings and actual evidence changes invalidate an old style review', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), value = await record(out, evidence);
  for (const key of Object.keys(value.bindings)) {
    const changed = structuredClone(value); changed.bindings[key] = '0'.repeat(64);
    await assert.rejects(reviewStyle(root, out, changed, evidence), { code: 'style-review-stale' });
  }
  const changed = structuredClone(evidence); changed.references[0].note = 'A changed provenance note.';
  await assert.rejects(reviewStyle(root, out, value, changed), { code: 'style-review-stale' });
  const s = await loadSession(root, out);
  await reviseSession(root, out, { ...patchTemplate(s.manifest.context, s.document, s.policy), patches: [{ blockId: 'p1',
    start: 2, end: 12, expectedText: 'catalogued', replacement: 'inspected', reason: 'Revise the work described.' }] });
  await assert.rejects(reviewStyle(root, out, value, evidence), { code: 'style-review-stale' });
  assert.deepEqual((await prepareStyleReview(root, out, evidence)).reportScopes.map(item => item.scope), ['historical', 'historical']);
});
test('logical paragraphs preserve blank-line boundaries, repeated positions, CRLF, non-BMP characters and variation selectors', async t => {
  const text = '  I held 🗝️.\r\nThe label read iron.\r\n \t\r\n I held 🗝️. \r\n\r\n\r\nA term remained.  ';
  const doc = document(text);
  const anchors = logicalParagraphAnchors(doc);
  assert.deepEqual(anchors.map(item => item.quote), ['I held 🗝️.\r\nThe label read iron.', 'I held 🗝️.', 'A term remained.']);
  for (const anchor of anchors) assert.equal(Array.from(text).slice(anchor.start, anchor.end).join(''), anchor.quote);
  const repeated = logicalParagraphAnchors(document('Same paragraph.\n\nSame paragraph.'));
  assert.equal(repeated.length, 2); assert.notEqual(repeated[0].start, repeated[1].start);
  assert.equal(logicalParagraphAnchors(document('One line.\r\nAnother line.')).length, 1);
  assert.equal(logicalParagraphAnchors(document('A\r\rB')).length, 2);
  const { out } = await fixture(t, 'Temporary paragraph.');
  const s = await loadSession(root, out);
  await reviseSession(root, out, { ...patchTemplate(s.manifest.context, s.document, s.policy), patches: [{ blockId: 'p1',
    start: 0, end: Array.from(s.document.blocks[0].text).length, expectedText: s.document.blocks[0].text,
    replacement: text, reason: 'Use the synthetic paragraph-boundary fixture.' }] });
  const value = await record(out);
  assert.equal((await reviewStyle(root, out, value)).paragraphCount, 3);
  for (const mutation of [v => v.paragraphs.pop(), v => v.paragraphs.push(v.paragraphs[0]),
    v => { v.paragraphs = [{ ...v.paragraphs[0], anchor: span(text) }]; },
    v => { v.paragraphs[0].anchor.start = 3; }]) {
    const changed = structuredClone(value); mutation(changed); await assert.rejects(reviewStyle(root, out, changed));
  }
});
test('all evidence and current reference locations reject forged quotes and unknown references', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), value = await record(out, evidence);
  value.patterns = [{ kind: 'syntax-cadence', anchors: [value.paragraphs[0].anchor], assessment: 'retain',
    explanation: 'The shared first-person opening serves a distinct function in each paragraph.' }];
  value.voice = { ...value.voice, status: 'available', anchors: [{ candidate: value.paragraphs[0].anchor,
    reference: { referenceId: 'example', span: span(evidence.references[0].document.blocks[0].text) } }] };
  const targets = v => [v.paragraphs[0].anchor, v.patterns[0].anchors[0], v.voice.anchors[0].candidate,
    v.voice.anchors[0].reference.span, v.feedback[0].anchors[0], v.protectedChoices[0].anchor];
  for (let i = 0; i < targets(value).length; i++) {
    const changed = structuredClone(value); targets(changed)[i].quote = 'A forged quotation.';
    await assert.rejects(reviewStyle(root, out, changed, evidence));
  }
  const unknown = structuredClone(value); unknown.voice.anchors[0].reference.referenceId = 'absent';
  await assert.rejects(reviewStyle(root, out, unknown, evidence), { code: 'style-review-reference' });
  const blank = structuredClone(value); blank.protectedChoices[0].anchor = span(' ', 'p1', 1);
  await assert.rejects(reviewStyle(root, out, blank, evidence), { code: 'style-review-span' });
  const badEvidence = structuredClone(evidence); badEvidence.reports[0].comments[0].anchor.quote = 'A forged report quote.';
  await assert.rejects(prepareStyleReview(root, out, badEvidence), { code: 'style-evidence-span' });
});
test('duplicate evidence IDs, false tested hashes, absent-score claims, malformed metadata and foreign fields are rejected', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out);
  const mutations = [
    e => e.references.push(e.references[0]), e => e.reports.push(e.reports[0]),
    e => { e.reports[0].testedDocumentHash = 'f'.repeat(64); },
    e => { e.reports[0].rawScore = '100'; },
    e => { e.reports[0].documentLabel = 'ai-generated'; },
    e => { e.reports[0].sourceArtifacts[0].sha256 = 'file:///not-read'; },
    e => { e.references[0].origin = 'verified-student'; },
    e => { e.references[0].document.blocks.push(e.references[0].document.blocks[0]); },
    e => { e.references[0].sourcePath = '/a/path/program/must/not/read'; }
  ];
  for (const mutation of mutations) { const changed = structuredClone(evidence); mutation(changed);
    await assert.rejects(prepareStyleReview(root, out, changed)); }
  const value = await record(out);
  for (const fields of [{ naturalVoiceCertified: true }, { reviewerRole: 'human' }, { methodVersion: '1.2.0' }])
    await assert.rejects(reviewStyle(root, out, { ...value, ...fields }));
});
test('feedback must address every comment once with the computed scope, including repeated comments', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out);
  evidence.reports[0].comments.push(structuredClone(evidence.reports[0].comments[0]));
  const value = await record(out, evidence);
  assert.equal((await reviewStyle(root, out, value, evidence)).feedbackCount, 3);
  for (const mutation of [v => v.feedback.pop(), v => v.feedback.push(v.feedback[0]),
    v => { v.feedback[0].reportId = 'absent'; }, v => { v.feedback[0].commentIndex = 100; },
    v => { v.feedback[0].scope = 'historical'; }, v => { v.feedback.at(-1).scope = 'current'; }]) {
    const changed = structuredClone(value); mutation(changed); await assert.rejects(reviewStyle(root, out, changed, evidence));
  }
});
test('explicit paragraph, pattern, voice, feedback and overall problems remain rework under adopt', async t => {
  const { out } = await fixture(t), evidence = await evidenceFor(out), value = await record(out, evidence);
  for (const status of ['repetitive', 'generic', 'unresolved']) {
    const changed = structuredClone(value); changed.paragraphs[0].status = status;
    assert.equal((await reviewStyle(root, out, changed, evidence)).reviewDecision, 'needs-rework');
  }
  for (const assessment of ['revise', 'unresolved']) {
    const changed = structuredClone(value); changed.patterns = [{ kind: 'repeated-function', anchors: [value.paragraphs[0].anchor],
      assessment, explanation: 'The function needs another editorial look.' }];
    assert.equal((await reviewStyle(root, out, changed, evidence)).reviewDecision, 'needs-rework');
  }
  for (const status of ['revise', 'unresolved']) {
    const changed = structuredClone(value); changed.overall.status = status;
    assert.equal((await reviewStyle(root, out, changed, evidence)).reviewDecision, 'needs-rework');
    changed.overall.status = 'retain'; changed.feedback[0].qualityDecision = status;
    assert.equal((await reviewStyle(root, out, changed, evidence)).reviewDecision, 'needs-rework');
  }
  const unresolved = structuredClone(value); unresolved.voice.status = 'unresolved';
  assert.equal((await reviewStyle(root, out, unresolved, evidence)).reviewDecision, 'needs-rework');
  value.recommendation = 'rework';
  assert.equal((await reviewStyle(root, out, value, evidence)).reviewDecision, 'needs-rework');
});
test('surface cues locate English phrases without classifying texts, requiring edits or pretending other-language support', async t => {
  const { out } = await fixture(t, 'I want to study conservation. I hope to learn. I would like to make labels. I would check the text.\n\nThis experience helped me read labels.');
  const prepared = await prepareStyleReview(root, out);
  assert.equal(prepared.surfaceCues.scope, 'english-phrases-only');
  assert.equal(prepared.surfaceCues.cues.length, 5);
  assert.equal((await reviewStyle(root, out, await record(out))).reviewDecision, 'recorded');
  for (const item of prepared.surfaceCues.cues) assert.equal(Array.from(prepared.document.blocks.find(b => b.id === item.anchor.blockId).text)
    .slice(item.anchor.start, item.anchor.end).join(''), item.anchor.quote);
  assert.ok(!Object.keys(prepared.surfaceCues).some(key => /score|probability|risk|verdict/i.test(key)));
  const zh = await fixture(t, '我查看了标签。', 'zh');
  assert.deepEqual((await prepareStyleReview(root, zh.out)).surfaceCues, { scope: 'not-supported-for-this-language', cues: [] });
});
test('required notes, protected choices and voice comparison structure are not satisfied by empty text', async t => {
  const { out } = await fixture(t), value = await record(out);
  for (const path of [['paragraphs', 0, 'purpose'], ['paragraphs', 0, 'concreteContent'], ['patternsReason'],
    ['voice', 'preserve'], ['voice', 'avoidCopying'], ['voice', 'reason'], ['feedbackReason'], ['protectedChoices', 0, 'reason'], ['overall', 'reason']]) {
    const changed = structuredClone(value); let object = changed;
    for (const key of path.slice(0, -1)) object = object[key]; object[path.at(-1)] = '   ';
    await assert.rejects(reviewStyle(root, out, changed));
  }
  const unprotected = structuredClone(value); unprotected.protectedChoices = [];
  await assert.rejects(reviewStyle(root, out, unprotected));
  const available = structuredClone(value); available.voice.status = 'available';
  await assert.rejects(reviewStyle(root, out, available), { code: 'style-review-voice' });
});
test('all six language dimensions require exact current anchors and cannot hide rework under adopt', async t => {
  const { out } = await fixture(t), value = await record(out);
  assert.equal(value.languageChecks.length, 6);
  const missing = structuredClone(value); missing.languageChecks.pop();
  await assert.rejects(reviewStyle(root, out, missing));
  const duplicate = structuredClone(value); duplicate.languageChecks[1] = structuredClone(duplicate.languageChecks[0]);
  await assert.rejects(reviewStyle(root, out, duplicate), { code: 'style-review-language' });
  const forged = structuredClone(value); forged.languageChecks[0].anchors[0].quote += ' imaginary';
  await assert.rejects(reviewStyle(root, out, forged), { code: 'style-review-span' });
  for (const decision of ['revise', 'unresolved']) {
    const changed = structuredClone(value); changed.languageChecks[2].decision = decision;
    const result = await reviewStyle(root, out, changed);
    assert.equal(result.reviewDecision, 'needs-rework');
    assert.deepEqual(result.rework.languageChecks, ['diction']);
  }
  assert.equal((await reviewStyle(root, out, value)).languageDimensionCount, 6);
});
test('sentence presentation cues remain locations rather than bans or automatic judgments', async t => {
  const { out } = await fixture(t, 'I want to be able to catalogue objects. I would want to check the shelf before assuming a label was lost. The archive interests me for its combination of objects and records, including someone else\'s notes.');
  const prepared = await prepareStyleReview(root, out), kinds = prepared.surfaceCues.cues.map(x => x.kind);
  assert.ok(kinds.includes('intention-scaffolding'));
  assert.ok(kinds.includes('explanatory-attachment'));
  assert.ok(kinds.includes('abstract-interest-frame'));
  assert.equal((await reviewStyle(root, out, await record(out))).reviewDecision, 'recorded');
  assert.ok(!JSON.stringify(prepared.surfaceCues).includes('probability'));
  for (const cue of prepared.surfaceCues.cues) assert.equal(Array.from(prepared.document.blocks[0].text).slice(cue.anchor.start, cue.anchor.end).join(''), cue.anchor.quote);
});
test('package CLI exposes strict schemas, empty-evidence and supplied-evidence review without session writes', async t => {
  const { out, dir } = await fixture(t), evidence = await evidenceFor(out), before = await snapshot(out);
  const run = (...args) => spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 2_000_000 });
  const schema = run('schema'); assert.equal(schema.status, 0);
  assert.ok(JSON.parse(schema.stdout).styleReview); assert.ok(JSON.parse(schema.stdout).styleEvidence);
  const prepared = run('prepare-style-review', '--session', out); assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).template.methodVersion, '1.4.0');
  const evidenceFile = join(dir, 'evidence.json'), reviewFile = join(dir, 'review.json');
  await writeFile(evidenceFile, JSON.stringify(evidence)); await writeFile(reviewFile, JSON.stringify(await record(out, evidence)));
  const supplied = run('prepare-style-review', '--session', out, '--evidence-file', evidenceFile); assert.equal(supplied.status, 0, supplied.stderr);
  const result = run('review-style', '--session', out, '--review-file', reviewFile, '--evidence-file', evidenceFile);
  assert.equal(result.status, 3, result.stderr); assert.equal(JSON.parse(result.stdout).reviewDecision, 'recorded');
  assert.ok(!result.stdout.includes('bronze')); assert.deepEqual(await snapshot(out), before);
  assert.equal(run('prepare', '--session', out, '--evidence-file', evidenceFile).status, 1);
});
