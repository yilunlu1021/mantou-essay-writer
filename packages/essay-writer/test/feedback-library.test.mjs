import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, chmod, stat, access, symlink, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { documentSchema, hashValue } from '@mantou/text-quality';
import { importFeedbackEvidence, feedbackLibraryStats, recallFeedback,
  recordFeedbackInterpretation, recordFeedbackTrial } from '../dist/feedback-library.js';

const document = (text, revision = 'observed') => documentSchema.parse({ revision, blocks: [{ id: 'p1', text }] });
const span = (text, start = 0) => ({ blockId: 'p1', start, end: start + Array.from(text).length, quote: text });
function report(id = 'scan-1', testedDocument = document('I catalogued the bronze key.'), label = 'mixed') {
  return { id, toolName: 'Synthetic feedback tool', modelVersion: null, observedAt: null, testedDocument,
    testedDocumentHash: hashValue(testedDocument), documentLabel: label, labelSource: 'user-reported', rawScore: null,
    comments: [{ anchor: span(testedDocument.blocks[0].text), featureTags: ['Plain syntax', 'Functional words'],
      explanation: null, observedStrength: null }], sourceArtifacts: [{ kind: 'image', sha256: 'a'.repeat(64) }] };
}
const evidence = (reports = [report()]) => ({ schemaVersion: '1.0.0', reports, references: [] });
async function fixture(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'humanier-feedback-'));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { force: true, recursive: true }));
  return { dir, db: join(dir, 'private', 'feedback.sqlite') };
}
async function digest(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
const interpretation = (reportId, overrides = {}) => ({ reportId, commentIndex: 0, dimension: 'diction',
  hypothesis: 'The general verb may have obscured the object, an editorial hypothesis only.', editingDecision: 'retain',
  reason: 'The sentence describes a distinct necessary action.', retainCounterexample: 'A direct verb is appropriate for cataloguing.',
  authorRole: 'agent', status: 'candidate', ...overrides });
const trial = (beforeSnapshotId, afterDocument, overrides = {}) => ({ beforeSnapshotId, afterDocument,
  methodVersion: '1.4.0', changes: ['Retain the concrete object and tighten the action.'],
  qualityReview: { status: 'pending', reason: 'Advisor review is pending.', reviewerRole: 'agent' },
  comparisonConditions: { sameToolVersion: null, sameSettings: null, sameScope: null, note: 'No matched retest was supplied.' },
  ...overrides });

test('strict transactional import preserves snapshots, unknowns, source declarations and reference author roles', async t => {
  const { db } = await fixture(t), input = evidence();
  input.references = [{ id: 'advisor-edit', origin: 'user-confirmed-edit', authorRole: 'advisor', approval: 'user-confirmed',
    document: document('I checked the label twice.', 'reference'), note: 'Advisor wording, not authenticated student authorship.' }];
  const imported = await importFeedbackEvidence(db, input, { scopeId: 'workstation-private', context: { genre: 'personal essay' } });
  assert.equal(imported.scopeId, 'workstation-private');
  assert.equal(imported.counts.reports.added, 1); assert.equal(imported.counts.observations.added, 1);
  assert.equal(imported.counts.snapshots.added, 2); assert.equal(imported.counts.references.added, 1);
  assert.equal(imported.evidenceAuthenticityVerified, false); assert.equal(imported.attachmentHashesAreSourceDeclarations, true);
  assert.ok(!JSON.stringify(imported).includes('bronze'));
  const raw = new DatabaseSync(db, { readOnly: true });
  assert.equal(raw.prepare('SELECT author_role FROM evidence_references').get().author_role, 'advisor');
  assert.deepEqual(JSON.parse(raw.prepare('SELECT evidence_json FROM import_batches').get().evidence_json), input);
  raw.close();
  const metadata = await recallFeedback(db, {}), full = await recallFeedback(db, { includeText: true });
  assert.ok(!JSON.stringify(metadata).includes('bronze')); assert.equal(metadata.containsDocumentText, false);
  assert.deepEqual(metadata.observations[0].featureTags, ['Plain syntax', 'Functional words']);
  assert.equal(metadata.observations[0].modelVersion, null); assert.equal(metadata.observations[0].rawScore, null);
  assert.equal(full.observations[0].explanation, null); assert.equal(full.observations[0].observedStrength, null);
  assert.equal(full.observations[0].anchor.quote, input.reports[0].comments[0].anchor.quote);
  assert.deepEqual(full.observations[0].testedDocument, input.reports[0].testedDocument);
});

test('repeated import is idempotent; separate scans and revision metadata do not inflate independent bodies', async t => {
  const { db } = await fixture(t), first = evidence();
  const a = await importFeedbackEvidence(db, first), b = await importFeedbackEvidence(db, first);
  assert.equal(a.batchId, b.batchId); assert.equal(b.counts.reports.added, 0); assert.equal(b.counts.reports.existing, 1);
  assert.equal(b.counts.observations.added, 0); assert.equal(b.counts.snapshots.existing, 1);
  const repeatedBody = document(first.reports[0].testedDocument.blocks[0].text, 'different-revision');
  await importFeedbackEvidence(db, evidence([report('scan-2', repeatedBody, 'human')]));
  await importFeedbackEvidence(db, evidence([report('scan-3', first.reports[0].testedDocument, 'ai-generated')]));
  const stats = await feedbackLibraryStats(db);
  assert.equal(stats.counts.batches, 3); assert.equal(stats.counts.reports, 3); assert.equal(stats.counts.observations, 3);
  assert.equal(stats.counts.snapshots, 2); assert.equal(stats.counts.independentDocumentBodies, 1);
  assert.equal(stats.counts.attachments, 1); assert.equal(stats.unknown.explanations, 3);
  assert.equal(stats.unknown.rawScore, 3); assert.equal(stats.unknown.modelVersion, 3);
  assert.equal(stats.improvementEstablished, false); assert.ok(!JSON.stringify(stats).includes('bronze'));
});

test('exact tag, dimension and scope intersect, limit is bounded and default queries never return private interpretations', async t => {
  const { db } = await fixture(t), a = await importFeedbackEvidence(db, evidence(), { scopeId: 'scope-a' });
  await importFeedbackEvidence(db, evidence(), { scopeId: 'scope-b' });
  const reportId = a.reportMappings[0].reportId;
  await recordFeedbackInterpretation(db, interpretation(reportId, { hypothesis: 'The bronze key remains specific.' }));
  await recordFeedbackInterpretation(db, interpretation(reportId, { dimension: 'cadence', commentIndex: undefined }));
  const queried = await recallFeedback(db, { scopeId: 'scope-a', featureTag: 'Plain syntax', dimension: 'diction', limit: 1 });
  assert.equal(queried.observations.length, 1); assert.equal(queried.observations[0].reportId, reportId);
  assert.ok(!JSON.stringify(queried).includes('bronze'));
  assert.equal((await recallFeedback(db, { featureTag: 'plain syntax' })).observations.length, 0);
  assert.equal((await recallFeedback(db, { featureTag: "Plain syntax' OR 1=1 --" })).observations.length, 0);
  assert.equal((await recallFeedback(db, { scopeId: 'scope-b', dimension: 'diction' })).observations.length, 0);
  assert.equal((await recallFeedback(db, { dimension: 'cadence' })).observations.length, 1);
  assert.ok(JSON.stringify(await recallFeedback(db, { includeText: true })).includes('bronze'));
  for (const query of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { sql: 'SELECT * FROM snapshots' }, { includeText: 'yes' }])
    await assert.rejects(recallFeedback(db, query));
});

test('interpretations append separate hypotheses and confirmation declarations without authenticating authority', async t => {
  const { db } = await fixture(t), imported = await importFeedbackEvidence(db, evidence()), reportId = imported.reportMappings[0].reportId;
  await assert.rejects(recordFeedbackInterpretation(db, interpretation(reportId, { status: 'confirmed' })));
  await assert.rejects(recordFeedbackInterpretation(db, interpretation('f'.repeat(64))), { code: 'feedback-library-report' });
  await assert.rejects(recordFeedbackInterpretation(db, interpretation(reportId, { commentIndex: 1 })), { code: 'feedback-library-observation' });
  const candidate = await recordFeedbackInterpretation(db, interpretation(reportId));
  const confirmed = await recordFeedbackInterpretation(db, interpretation(reportId, { status: 'confirmed',
    confirmationSource: 'Advisor explicitly approved this interpretation in the task.' }));
  assert.notEqual(candidate.interpretationId, confirmed.interpretationId);
  assert.equal(confirmed.confirmationAuthenticated, false); assert.equal(confirmed.ruleAutomaticallyAdopted, false);
  assert.equal((await recordFeedbackInterpretation(db, interpretation(reportId))).added, false);
  assert.equal((await feedbackLibraryStats(db)).counts.interpretations, 2);
  const linked = await recordFeedbackInterpretation(db, interpretation(reportId, { contextDocumentHash: 'b'.repeat(64),
    reviewRecordHash: 'c'.repeat(64), methodVersion: '1.4.0' }));
  assert.equal(linked.status, 'candidate');
  const linkedRecall = await recallFeedback(db, { includeText: true });
  const payload = linkedRecall.observations[0].interpretations.find(value => value.interpretationId === linked.interpretationId).record;
  assert.equal(payload.contextDocumentHash, 'b'.repeat(64)); assert.equal(payload.reviewRecordHash, 'c'.repeat(64));
  await assert.rejects(recordFeedbackInterpretation(db, interpretation(reportId, { contextDocumentHash: 'bad' })));
});

test('trials preserve untested drafts and only bind a retest to the exact matching after snapshot', async t => {
  const { db } = await fixture(t), input = evidence(), first = await importFeedbackEvidence(db, input);
  const before = first.reportMappings[0], afterDocument = document('I checked the bronze label twice.', 'after');
  const untested = await recordFeedbackTrial(db, trial(before.snapshotId, afterDocument, { beforeReportId: before.reportId }));
  assert.equal(untested.status, 'untested'); assert.equal(untested.improvementEstablished, false);
  const after = (await importFeedbackEvidence(db, evidence([report('scan-after', afterDocument, 'human')]))).reportMappings[0];
  const tested = await recordFeedbackTrial(db, trial(before.snapshotId, afterDocument, { beforeReportId: before.reportId, afterReportId: after.reportId }));
  assert.equal(tested.status, 'tested'); assert.equal(tested.improvementEstablished, false);
  const beforeStats = await feedbackLibraryStats(db);
  await assert.rejects(recordFeedbackTrial(db, trial(before.snapshotId, document('A different sentence.'), { afterReportId: after.reportId })),
    { code: 'feedback-library-trial-report' });
  await assert.rejects(recordFeedbackTrial(db, trial(before.snapshotId, afterDocument, { beforeReportId: after.reportId })),
    { code: 'feedback-library-trial-report' });
  await assert.rejects(recordFeedbackTrial(db, trial('f'.repeat(64), afterDocument)), { code: 'feedback-library-snapshot' });
  assert.deepEqual(await feedbackLibraryStats(db), beforeStats);
  assert.equal(beforeStats.counts.retestPairs, 1); assert.equal(beforeStats.counts.trials, 2);
});

test('interpretation replacements preserve an immutable scoped chain with explicit current metadata', async t => {
  const { db } = await fixture(t), input = evidence([report('first'), report('second')]);
  input.reports[0].comments.push(structuredClone(input.reports[0].comments[0]));
  const imported = await importFeedbackEvidence(db, input), reportId = imported.reportMappings[0].reportId;
  const original = await recordFeedbackInterpretation(db, interpretation(reportId));
  const replacement = interpretation(reportId, { hypothesis: 'The first hypothesis lacked direct support.',
    editingDecision: 'unresolved', supersedesInterpretationId: original.interpretationId });
  const revised = await recordFeedbackInterpretation(db, replacement);
  const last = await recordFeedbackInterpretation(db, interpretation(reportId, { hypothesis: 'The revision now identifies a useful retention case.',
    supersedesInterpretationId: revised.interpretationId }));
  assert.equal((await recordFeedbackInterpretation(db, replacement)).added, false);
  const beforeStats = await feedbackLibraryStats(db);
  for (const bad of [
    { supersedesInterpretationId: 'f'.repeat(64) },
    { supersedesInterpretationId: original.interpretationId, commentIndex: 1 },
    { supersedesInterpretationId: original.interpretationId, reportId: imported.reportMappings[1].reportId },
    { supersedesInterpretationId: original.interpretationId, dimension: 'stance' },
    { supersedesInterpretationId: original.interpretationId, commentIndex: undefined }
  ]) await assert.rejects(recordFeedbackInterpretation(db, interpretation(reportId, bad)), { code: 'feedback-library-supersedes' });
  assert.deepEqual(await feedbackLibraryStats(db), beforeStats);
  const recall = await recallFeedback(db, { interpretationHistory: 'all' }), values = recall.observations.find(item => item.reportId === reportId && item.commentIndex === 0).interpretations;
  const first = values.find(item => item.interpretationId === original.interpretationId);
  const middle = values.find(item => item.interpretationId === revised.interpretationId);
  const current = values.find(item => item.interpretationId === last.interpretationId);
  assert.equal(first.supersedesInterpretationId, null); assert.equal(first.isSuperseded, true);
  assert.deepEqual(first.supersededBy, [revised.interpretationId]);
  assert.equal(middle.supersedesInterpretationId, original.interpretationId); assert.equal(middle.isSuperseded, true);
  assert.equal(current.supersedesInterpretationId, revised.interpretationId); assert.equal(current.isSuperseded, false);
  assert.deepEqual(current.supersededBy, []); assert.equal(values.length, 3);
  assert.equal(Object.hasOwn(current, 'record'), false); assert.ok(!JSON.stringify(recall).includes('lacked direct support'));
  const currentOnly = await recallFeedback(db);
  assert.deepEqual(currentOnly.observations.find(item => item.reportId === reportId && item.commentIndex === 0).interpretations
    .map(item => item.interpretationId), [last.interpretationId]);
});

test('hash and Unicode quote failures reject the whole input before database creation', async t => {
  const { db, dir } = await fixture(t);
  const invalidHash = evidence(); invalidHash.reports[0].testedDocumentHash = 'f'.repeat(64);
  await assert.rejects(importFeedbackEvidence(db, invalidHash), { code: 'feedback-library-hash' });
  await assert.rejects(access(join(dir, 'private')));
  const unicode = evidence([report('unicode', document('I held 🗝️.'))]);
  await importFeedbackEvidence(db, unicode);
  const before = await feedbackLibraryStats(db);
  const invalidSpan = structuredClone(unicode); invalidSpan.reports[0].comments[0].anchor.end++;
  await assert.rejects(importFeedbackEvidence(db, invalidSpan), { code: 'feedback-library-span' });
  const whitespace = evidence([report('blank', document('   '))]);
  await assert.rejects(importFeedbackEvidence(db, whitespace), { code: 'feedback-library-span' });
  const mismatchedScore = evidence(); mismatchedScore.reports[0].labelSource = 'not-provided';
  await assert.rejects(importFeedbackEvidence(db, mismatchedScore), { code: 'feedback-library-score' });
  const duplicate = evidence([report(), report()]);
  await assert.rejects(importFeedbackEvidence(db, duplicate), { code: 'feedback-library-id' });
  assert.deepEqual(await feedbackLibraryStats(db), before);
});

test('a database failure midway through import rolls back snapshots, batches, reports and comments', async t => {
  const { db } = await fixture(t); await importFeedbackEvidence(db, evidence());
  const before = await feedbackLibraryStats(db), sql = new DatabaseSync(db);
  sql.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON reports WHEN NEW.source_id='blocked'
    BEGIN SELECT RAISE(ABORT, 'synthetic transaction failure'); END`);
  sql.close();
  await assert.rejects(importFeedbackEvidence(db, evidence([
    report('accepted-first', document('A new accepted document.')), report('blocked', document('A new blocked document.'))
  ])), /synthetic transaction failure/);
  assert.deepEqual(await feedbackLibraryStats(db), before);
});

test('read-only missing queries create nothing, and normal statistics and recall do not alter database bytes', async t => {
  const { db, dir } = await fixture(t);
  await assert.rejects(feedbackLibraryStats(db), { code: 'feedback-library-missing' });
  await assert.rejects(recallFeedback(db), { code: 'feedback-library-missing' });
  await assert.rejects(recordFeedbackInterpretation(db, interpretation('f'.repeat(64))), { code: 'feedback-library-missing' });
  await assert.rejects(recordFeedbackTrial(db, trial('f'.repeat(64), document('After.'))), { code: 'feedback-library-missing' });
  assert.deepEqual(await readdir(dir), []);
  await importFeedbackEvidence(db, evidence()); const before = await digest(db);
  await feedbackLibraryStats(db); await recallFeedback(db, { includeText: true });
  assert.equal(await digest(db), before);
  if (process.platform !== 'win32') {
    assert.equal((await stat(db)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'private'))).mode & 0o777, 0o700);
  }
});

test('database links, linked parents and permissive files are refused without touching their targets', async t => {
  const { db, dir } = await fixture(t); await importFeedbackEvidence(db, evidence());
  const before = await digest(db), linked = join(dir, 'linked.sqlite');
  await symlink(db, linked);
  await assert.rejects(feedbackLibraryStats(linked), { code: 'feedback-library-path' });
  await assert.rejects(importFeedbackEvidence(linked, evidence()), { code: 'feedback-library-path' });
  const parentLink = join(dir, 'parent-link'); await symlink(join(dir, 'private'), parentLink);
  await assert.rejects(importFeedbackEvidence(join(parentLink, 'other.sqlite'), evidence()), { code: 'feedback-library-path' });
  if (process.platform !== 'win32') {
    await chmod(db, 0o644);
    await assert.rejects(feedbackLibraryStats(db), { code: 'feedback-library-permissions' });
    await chmod(db, 0o600);
  }
  assert.equal(await digest(db), before);
});
