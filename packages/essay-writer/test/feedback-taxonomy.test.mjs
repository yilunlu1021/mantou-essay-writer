import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, chmod, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { documentSchema, hashValue } from '@mantou/text-quality';
import { importFeedbackEvidence, recallFeedback, recordFeedbackInterpretation, feedbackLibraryStats,
  categorizeFeedback, feedbackCategoryStats, getFeedbackTaxonomy, feedbackClassificationSchema } from '../dist/feedback-library.js';
import { FEEDBACK_CATEGORY_IDS, FEEDBACK_TAXONOMY_VERSION } from '../dist/feedback-taxonomy.js';

const text = 'I repaired the copper latch beside the door.';
const document = documentSchema.parse({ revision: 'synthetic', blocks: [{ id: 'p1', text }] });
const anchor = { blockId: 'p1', start: 0, end: Array.from(text).length, quote: text };
const comment = tags => ({ anchor, featureTags: tags, explanation: null, observedStrength: null });
const report = (id = 'scan-1', comments = [comment(['Mechanical Precision', 'Lacks Creativity'])]) => ({
  id, toolName: 'Synthetic tool', modelVersion: null, observedAt: null, testedDocument: document,
  testedDocumentHash: hashValue(document), documentLabel: 'unknown', labelSource: 'not-provided', rawScore: null,
  comments, sourceArtifacts: []
});
const evidence = reports => ({ schemaVersion: '1.0.0', references: [], reports });
const classification = (categoryId = 'register-fit', relation = 'review-domain') => ({
  taxonomyVersion: '1.0.0', categories: [{ categoryId, relation }], sourceTags: ['Mechanical Precision'],
  explanationAssessment: 'not-reviewed'
});
const interpretation = (reportId, extra = {}) => ({ reportId, commentIndex: 0, dimension: 'diction',
  hypothesis: 'The copper latch wording may warrant review, a hypothesis only.', editingDecision: 'retain',
  reason: 'The operation has a concrete referent.', retainCounterexample: 'A copper latch names a specific object.',
  authorRole: 'agent', status: 'candidate', ...extra });
async function fixture(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'humanier-taxonomy-'));
  await chmod(dir, 0o700); t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, db: join(dir, 'private', 'feedback.sqlite') };
}
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
function rawRows(db) {
  const d = new DatabaseSync(db, { readOnly: true });
  try { return ['snapshots', 'reports', 'observations', 'observation_tags', 'import_batches', 'library_meta']
    .map(table => d.prepare('SELECT * FROM ' + table).all()); } finally { d.close(); }
}

test('taxonomy has nine stable categories, review questions and retention counterexamples without detector verdicts', () => {
  const taxonomy = getFeedbackTaxonomy();
  assert.equal(taxonomy.taxonomyVersion, FEEDBACK_TAXONOMY_VERSION);
  assert.deepEqual(taxonomy.categories.map(item => item.id), [...FEEDBACK_CATEGORY_IDS]);
  assert.equal(taxonomy.sourceTagMappings.length, 22);
  for (const category of taxonomy.categories) {
    assert.ok(category.definition.length); assert.ok(category.reviewQuestions.length); assert.ok(category.retainCounterexamples.length);
  }
  assert.ok(taxonomy.sourceTagMappings.find(item => item.sourceTag === 'Mechanical Precision').categoryIds.length > 1);
  assert.equal(taxonomy.detectorCausalityEstablished, false); assert.equal(taxonomy.automaticRewriting, false);
  taxonomy.categories[0].retainCounterexamples.pop();
  assert.equal(getFeedbackTaxonomy().categories[0].retainCounterexamples.length, 2);
});

test('classification rejects unknown versions, categories, relations and duplicate assignments or tags', () => {
  const valid = classification();
  assert.deepEqual(feedbackClassificationSchema.parse(valid), valid);
  for (const bad of [
    { ...valid, taxonomyVersion: '2.0.0' }, { ...valid, categories: [{ categoryId: 'unknown', relation: 'review-domain' }] },
    { ...valid, categories: [{ categoryId: 'register-fit', relation: 'AI-cause' }] },
    { ...valid, categories: [...valid.categories, ...valid.categories] },
    { ...valid, sourceTags: ['Mechanical Precision', 'Mechanical Precision'] }, { ...valid, score: 0.2 }
  ]) assert.equal(feedbackClassificationSchema.safeParse(bad).success, false);
});

test('categorization previews read-only and append-only apply is idempotent with unknown tags left unclassified', async t => {
  const { db } = await fixture(t), imported = await importFeedbackEvidence(db, evidence([
    report('known'), report('unknown', [comment(['New unknown tag'])])
  ]));
  const before = await digest(db), sourceRows = rawRows(db), preview = await categorizeFeedback(db);
  assert.equal(preview.applied, false); assert.equal(preview.counts.mappedObservations, 1);
  assert.equal(preview.counts.mappedTagInstances, 2); assert.equal(preview.counts.unclassifiedTagInstances, 1);
  assert.deepEqual(preview.unclassifiedTags, [{ sourceTag: 'New unknown tag', instances: 1 }]);
  assert.equal(preview.counts.interpretationsAdded, 0); assert.equal(await digest(db), before);
  const applied = await categorizeFeedback(db, { apply: true });
  assert.equal(applied.counts.interpretationsAdded, 1);
  assert.equal((await categorizeFeedback(db, { apply: true })).counts.interpretationsAdded, 0);
  assert.deepEqual(rawRows(db), sourceRows);
  const recalled = await recallFeedback(db, { categoryId: 'register-fit', includeText: true });
  assert.equal(recalled.observations.length, 1);
  const saved = recalled.observations[0].interpretations[0].record;
  assert.equal(saved.editingDecision, 'unresolved'); assert.equal(saved.status, 'candidate');
  assert.equal(saved.classification.explanationAssessment, 'not-reviewed');
  assert.ok(saved.classification.categories.every(item => item.relation === 'review-domain'));
  assert.equal(applied.detectorCausalityEstablished, false); assert.equal(applied.improvementEstablished, false);
  assert.ok(!JSON.stringify(applied).includes('copper')); assert.ok(imported.reportMappings.length);
});

test('scope and report filters intersect, preview never creates missing databases and input validation precedes writes', async t => {
  const { db, dir } = await fixture(t);
  for (const call of [() => categorizeFeedback(db), () => categorizeFeedback(db, { apply: true }), () => feedbackCategoryStats(db)])
    await assert.rejects(call(), { code: 'feedback-library-missing' });
  assert.deepEqual(await readdir(dir), []);
  const a = await importFeedbackEvidence(db, evidence([report()]), { scopeId: 'scope-a' });
  const b = await importFeedbackEvidence(db, evidence([report()]), { scopeId: 'scope-b' });
  const before = await digest(db);
  await assert.rejects(categorizeFeedback(db, { reportId: a.reportMappings[0].reportId, scopeId: 'scope-b', apply: true }),
    { code: 'feedback-library-report' });
  await assert.rejects(categorizeFeedback(db, { apply: 'yes' }));
  assert.equal(await digest(db), before);
  const applied = await categorizeFeedback(db, { scopeId: 'scope-b', reportId: b.reportMappings[0].reportId, apply: true });
  assert.equal(applied.counts.observations, 1);
  assert.equal((await recallFeedback(db, { scopeId: 'scope-a', categoryId: 'register-fit' })).observations.length, 0);
  assert.equal((await recallFeedback(db, { scopeId: 'scope-b', featureTag: 'Mechanical Precision', dimension: 'other',
    categoryId: 'register-fit', taxonomyVersion: '1.0.0' })).observations.length, 1);
});

test('current category and dimension matching excludes rejected and superseded history while all can display the chain', async t => {
  const { db } = await fixture(t), first = await importFeedbackEvidence(db, evidence([report()]));
  const reportId = first.reportMappings[0].reportId;
  const original = await recordFeedbackInterpretation(db, interpretation(reportId, { classification: classification() }));
  const replacement = await recordFeedbackInterpretation(db, interpretation(reportId, {
    classification: classification('reference-recoverability', 'retention-case'), supersedesInterpretationId: original.interpretationId
  }));
  assert.equal((await recallFeedback(db, { categoryId: 'register-fit' })).observations.length, 0);
  const retained = await recallFeedback(db, { categoryId: 'reference-recoverability' });
  assert.deepEqual(retained.observations[0].interpretations.map(item => item.interpretationId), [replacement.interpretationId]);
  const history = await recallFeedback(db, { categoryId: 'reference-recoverability', interpretationHistory: 'all' });
  assert.equal(history.observations[0].interpretations.length, 2);
  assert.equal((await recallFeedback(db, { categoryId: 'register-fit', interpretationHistory: 'all' })).observations.length, 0);
  await recordFeedbackInterpretation(db, interpretation(reportId, { status: 'rejected',
    classification: classification('reference-recoverability', 'unresolved'), supersedesInterpretationId: replacement.interpretationId }));
  assert.equal((await recallFeedback(db, { dimension: 'diction' })).observations.length, 0);
  assert.equal((await recallFeedback(db)).observations[0].interpretations.length, 0);
  assert.equal((await recallFeedback(db, { interpretationHistory: 'all' })).observations[0].interpretations.length, 3);
});

test('category statistics count shared anchors once and report-level assignments without multiplying interpretations', async t => {
  const { db } = await fixture(t), imported = await importFeedbackEvidence(db, evidence([report('scan', [
    comment(['Mechanical Precision']), comment(['Lacks Creativity'])
  ])]));
  const reportId = imported.reportMappings[0].reportId;
  await recordFeedbackInterpretation(db, interpretation(reportId, { commentIndex: undefined,
    classification: classification('register-fit', 'retention-case') }));
  await recordFeedbackInterpretation(db, interpretation(reportId, { classification: classification('register-fit', 'supported-issue') }));
  const stats = await feedbackCategoryStats(db);
  assert.equal(stats.counts.observations, 2); assert.equal(stats.counts.uniqueAnchors, 1); assert.equal(stats.counts.tagInstances, 2);
  assert.equal(stats.counts.classifiedInterpretations, 2); assert.equal(stats.counts.classifiedObservations, 2);
  const group = stats.categories.find(item => item.categoryId === 'register-fit');
  assert.equal(group.interpretations, 2); assert.equal(group.observations, 2); assert.equal(group.uniqueAnchors, 1);
  assert.equal(group.relations['retention-case'], 1); assert.equal(group.relations['supported-issue'], 1);
  assert.equal(stats.authorDiversityEstablished, false); assert.equal(stats.improvementEstablished, false);
});

test('legacy schema 1 and unclassified interpretations remain readable and source-tag binding is checked', async t => {
  const { db } = await fixture(t), imported = await importFeedbackEvidence(db, evidence([report()]));
  const reportId = imported.reportMappings[0].reportId;
  const legacy = await recordFeedbackInterpretation(db, interpretation(reportId));
  const before = await digest(db);
  const stats = await feedbackCategoryStats(db), recalled = await recallFeedback(db);
  assert.equal(stats.counts.legacyUnclassifiedInterpretations, 1); assert.equal(stats.counts.unclassifiedObservations, 1);
  assert.equal(recalled.observations[0].interpretations[0].interpretationId, legacy.interpretationId);
  assert.equal(Object.hasOwn(recalled.observations[0].interpretations[0], 'classification'), false);
  assert.equal((await recallFeedback(db, { categoryId: 'register-fit' })).observations.length, 0);
  assert.equal(await digest(db), before);
  await assert.rejects(recordFeedbackInterpretation(db, interpretation(reportId, { classification: {
    ...classification(), sourceTags: ['Not a source tag']
  } })), { code: 'feedback-library-classification-tag' });
  assert.equal(await digest(db), before);
});

test('metadata queries omit all private text and are byte-for-byte read-only after classification', async t => {
  const { db } = await fixture(t);
  await importFeedbackEvidence(db, evidence([report()])); await categorizeFeedback(db, { apply: true });
  const before = await digest(db);
  const results = [await recallFeedback(db), await recallFeedback(db, { categoryId: 'register-fit' }),
    await feedbackCategoryStats(db), await feedbackLibraryStats(db), await categorizeFeedback(db)];
  assert.ok(!JSON.stringify(results).includes('copper')); assert.equal(await digest(db), before);
  assert.ok(JSON.stringify(await recallFeedback(db, { includeText: true })).includes('copper'));
});

test('report-level categories remain countable when there are no sentence comments', async t => {
  const { db } = await fixture(t), imported = await importFeedbackEvidence(db, evidence([report('empty', [])]));
  await recordFeedbackInterpretation(db, interpretation(imported.reportMappings[0].reportId, {
    commentIndex: undefined, classification: { ...classification(), sourceTags: [] }
  }));
  const stats = await feedbackCategoryStats(db), group = stats.categories.find(item => item.categoryId === 'register-fit');
  assert.equal(stats.counts.classifiedInterpretations, 1); assert.equal(stats.counts.observations, 0);
  assert.equal(group.interpretations, 1); assert.equal(group.reports, 1); assert.equal(group.observations, 0);
});

test('unknown object-property names stay unclassified and classification transactions roll back completely', async t => {
  const { db } = await fixture(t);
  await importFeedbackEvidence(db, evidence([report('unknown', [comment(['toString', '__proto__'])])]));
  const unknown = await categorizeFeedback(db, { apply: true });
  assert.equal(unknown.counts.mappedObservations, 0); assert.equal(unknown.counts.unclassifiedTagInstances, 2);
  const imported = await importFeedbackEvidence(db, evidence([report('known', [
    comment(['Mechanical Precision']), comment(['Mechanical Precision'])
  ])]));
  const beforeStats = await feedbackLibraryStats(db), sourceRows = rawRows(db), sql = new DatabaseSync(db);
  sql.exec(`CREATE TRIGGER reject_second_classification BEFORE INSERT ON interpretations
    WHEN NEW.comment_index=1 BEGIN SELECT RAISE(ABORT, 'synthetic classification failure'); END`);
  sql.close();
  await assert.rejects(categorizeFeedback(db, { reportId: imported.reportMappings[0].reportId, apply: true }), /synthetic classification failure/);
  assert.deepEqual(await feedbackLibraryStats(db), beforeStats); assert.deepEqual(rawRows(db), sourceRows);
});

test('category filtering happens before the bounded result limit and rejects unsupported query metadata', async t => {
  const { db } = await fixture(t), imported = await importFeedbackEvidence(db, evidence([
    report('a-no-category'), report('b-with-category')
  ]));
  const reportId = imported.reportMappings[1].reportId;
  await recordFeedbackInterpretation(db, interpretation(reportId, { classification: classification() }));
  const result = await recallFeedback(db, { categoryId: 'register-fit', limit: 1 });
  assert.equal(result.observations.length, 1); assert.equal(result.observations[0].reportId, reportId);
  const before = await digest(db);
  for (const query of [{ taxonomyVersion: 'unknown' }, { categoryId: 'unknown' }, { interpretationHistory: 'latest' }])
    await assert.rejects(recallFeedback(db, query));
  assert.equal(await digest(db), before);
});
