import { lstat, mkdir, open, chmod } from 'node:fs/promises';
import { resolve, dirname, parse, join } from 'node:path';
import { hashValue, documentSchema, type TextDocument } from '@mantou/text-quality';
import { styleEvidenceSchema, type StyleEvidence } from './style-review.js';
import { validateReviewSpan } from './source-review.js';
import { fail } from './files.js';
import {
  feedbackImportOptionsSchema, feedbackRecallQuerySchema, feedbackInterpretationSchema, feedbackTrialSchema,
  feedbackCategorizeSchema, feedbackCategoryStatsQuerySchema,
  FEEDBACK_LIBRARY_SCHEMA, FEEDBACK_LIBRARY_SCHEMA_VERSION,
  type FeedbackImportOptions, type FeedbackRecallQuery, type FeedbackInterpretationInput, type FeedbackTrialInput,
  type FeedbackCategorizeInput, type FeedbackCategoryStatsQuery
} from './feedback-library-schema.js';
import { feedbackClassificationSchema, FEEDBACK_CATEGORY_IDS, FEEDBACK_TAXONOMY_VERSION,
  FEEDBACK_TAG_REVIEW_DOMAINS, getFeedbackTaxonomy } from './feedback-taxonomy.js';
export { getFeedbackTaxonomy, feedbackCategoryIdSchema, feedbackClassificationSchema } from './feedback-taxonomy.js';
export { feedbackDimensionSchema, feedbackImportOptionsSchema, feedbackRecallQuerySchema,
  feedbackInterpretationSchema, feedbackTrialSchema, feedbackCategorizeSchema, feedbackCategoryStatsQuerySchema } from './feedback-library-schema.js';
export type { FeedbackImportOptions, FeedbackRecallQuery, FeedbackInterpretationInput, FeedbackTrialInput,
  FeedbackCategorizeInput, FeedbackCategoryStatsQuery } from './feedback-library-schema.js';

// Loading this module does not load SQLite. Existing document commands keep their runtime boundary.
type Database = import('node:sqlite').DatabaseSync;
type Parameter = string | number | null;
type Row = Record<string, string | number | bigint | null | Uint8Array>;
const json = (value: unknown) => JSON.stringify(value);
const number = (value: unknown) => Number(value);
const flags = { containsDocumentText: false, evidenceAuthenticityVerified: false,
  authorshipAuthenticated: false, detectorReplicated: false, deliveryAuthorized: false } as const;

async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function safePath(path: string, create: boolean) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0') || path === ':memory:')
    fail('feedback-library-path', 'Choose a local private database path.');
  const target = resolve(path), parent = dirname(target), root = parse(parent).root;
  let current = root;
  for (const part of parent.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    let entry = await info(current);
    if (!entry && create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      entry = await info(current);
    }
    if (!entry) fail('feedback-library-missing', 'The feedback database does not exist.');
    if (entry.isSymbolicLink() || !entry.isDirectory())
      fail('feedback-library-path', 'The feedback database and its ancestors must not be symbolic links.');
  }
  const directory = await lstat(parent);
  if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
    fail('feedback-library-permissions', 'Use a private database directory with mode 0700.');
  let file = await info(target), created = false;
  if (!file && create) {
    try {
      const handle = await open(target, 'wx', 0o600);
      try { await handle.sync(); } finally { await handle.close(); }
      // Ensure the private mode even when a permissive process umask is in use.
      await chmod(target, 0o600); created = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    file = await info(target);
  }
  if (!file) fail('feedback-library-missing', 'The feedback database does not exist.');
  if (!file.isFile() || file.isSymbolicLink())
    fail('feedback-library-path', 'Use a regular feedback database file, not a link.');
  if (process.platform !== 'win32' && (file.mode & 0o077) !== 0)
    fail('feedback-library-permissions', 'Use a private database file with mode 0600.');
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = await info(target + suffix);
    if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink()))
      fail('feedback-library-path', 'Feedback database sidecars must be regular files, not links.');
    if (sidecar && process.platform !== 'win32' && (sidecar.mode & 0o077) !== 0)
      fail('feedback-library-permissions', 'Feedback database sidecars must remain private.');
  }
  return { target, created };
}
async function database(path: string, writable = false, mustExist = false): Promise<Database> {
  const { target, created } = await safePath(path, writable && !mustExist);
  let SQLite: typeof import('node:sqlite');
  try { SQLite = await import('node:sqlite'); }
  catch { return fail('feedback-library-runtime', 'Feedback libraries require a Node runtime with node:sqlite. Other document commands remain available.'); }
  const db = new SQLite.DatabaseSync(target, { readOnly: !writable, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (created) {
      db.exec('BEGIN IMMEDIATE');
      try { db.exec(FEEDBACK_LIBRARY_SCHEMA); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    const schema = db.prepare("SELECT value FROM library_meta WHERE key = 'schema_version'").get();
    if (schema?.value !== String(FEEDBACK_LIBRARY_SCHEMA_VERSION))
      fail('feedback-library-schema', 'Use a supported feedback library schema. No implicit migration is performed.');
    return db;
  } catch (error) { db.close(); throw error; }
}
function one(db: Database, sql: string, ...parameters: Parameter[]): Row | undefined {
  return db.prepare(sql).get(...parameters);
}
function all(db: Database, sql: string, ...parameters: Parameter[]): Row[] {
  return db.prepare(sql).all(...parameters);
}
function insert(db: Database, sql: string, ...parameters: Parameter[]) {
  return number(db.prepare(sql).run(...parameters).changes) > 0;
}
function transaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function addSnapshot(db: Database, document: TextDocument) {
  const id = hashValue(document), bodyHash = hashValue(document.blocks.map(block => block.text).join('\n\n'));
  const added = insert(db, 'INSERT OR IGNORE INTO snapshots(id, body_hash, document_json) VALUES (?, ?, ?)', id, bodyHash, json(document));
  return { id, added };
}
function validatedEvidence(raw: unknown): StyleEvidence {
  const value = styleEvidenceSchema.parse(raw);
  for (const records of [value.reports, value.references])
    if (new Set(records.map(record => record.id)).size !== records.length)
      fail('feedback-library-id', 'Each supplied report and reference needs a unique source identifier.');
  for (const report of value.reports) {
    if (hashValue(report.testedDocument) !== report.testedDocumentHash)
      fail('feedback-library-hash', 'Bind the report to the exact tested document snapshot.');
    if (report.labelSource === 'not-provided' && (report.documentLabel !== 'unknown' || report.rawScore !== null))
      fail('feedback-library-score', 'An unprovided result must retain an unknown label and null raw score.');
    for (const comment of report.comments) {
      validateReviewSpan(comment.anchor, report.testedDocument.blocks, 'feedback-library-span');
      if (!comment.anchor.quote.trim()) fail('feedback-library-span', 'A feedback observation needs a substantive exact quote.');
    }
  }
  return value;
}

export async function importFeedbackEvidence(dbPath: string, rawEvidence: unknown, rawOptions: FeedbackImportOptions = {}) {
  // Validate all records before opening or initializing the database.
  const evidence = validatedEvidence(rawEvidence), options = feedbackImportOptionsSchema.parse(rawOptions);
  const evidenceHash = hashValue(evidence), batchId = hashValue({ evidenceHash, ...options });
  const db = await database(dbPath, true);
  try { return transaction(db, () => {
    const counts = {
      reports: { added: 0, existing: 0 }, observations: { added: 0, existing: 0 },
      snapshots: { added: 0, existing: 0 }, references: { added: 0, existing: 0 }
    };
    const snapshots = new Set<string>();
    const snapshot = (document: TextDocument) => {
      const value = addSnapshot(db, document);
      if (!snapshots.has(value.id)) { counts.snapshots[value.added ? 'added' : 'existing']++; snapshots.add(value.id); }
      return value.id;
    };
    insert(db, `INSERT OR IGNORE INTO import_batches(id, scope_id, evidence_hash, context_json, evidence_json, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)`, batchId, options.scopeId, evidenceHash, json(options.context), json(evidence), new Date().toISOString());
    const reportMappings = evidence.reports.map(report => {
      const snapshotId = snapshot(report.testedDocument), reportId = hashValue({ scopeId: options.scopeId, report });
      const added = insert(db, `INSERT OR IGNORE INTO reports(id, scope_id, source_id, snapshot_id, tool_name,
        model_version, observed_at, document_label, label_source, raw_score, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reportId, options.scopeId, report.id, snapshotId, report.toolName, report.modelVersion, report.observedAt,
      report.documentLabel, report.labelSource, report.rawScore, json(report));
      counts.reports[added ? 'added' : 'existing']++;
      const observationIds = report.comments.map((comment, commentIndex) => {
        const observationId = hashValue({ reportId, commentIndex });
        const wasAdded = insert(db, `INSERT OR IGNORE INTO observations(id, report_id, comment_index, block_id,
          start_offset, end_offset, quote, explanation, observed_strength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        observationId, reportId, commentIndex, comment.anchor.blockId, comment.anchor.start, comment.anchor.end,
        comment.anchor.quote, comment.explanation, comment.observedStrength);
        counts.observations[wasAdded ? 'added' : 'existing']++;
        comment.featureTags.forEach((tag, tagIndex) => insert(db,
          'INSERT OR IGNORE INTO observation_tags(observation_id, tag_index, value) VALUES (?, ?, ?)', observationId, tagIndex, tag));
        return observationId;
      });
      report.sourceArtifacts.forEach((artifact, artifactIndex) => {
        const attachmentId = hashValue(artifact);
        insert(db, 'INSERT OR IGNORE INTO attachments(id, kind, sha256) VALUES (?, ?, ?)', attachmentId, artifact.kind, artifact.sha256);
        insert(db, 'INSERT OR IGNORE INTO report_attachments(report_id, attachment_index, attachment_id) VALUES (?, ?, ?)',
          reportId, artifactIndex, attachmentId);
      });
      insert(db, 'INSERT OR IGNORE INTO batch_reports(batch_id, source_id, report_id) VALUES (?, ?, ?)', batchId, report.id, reportId);
      return { sourceReportId: report.id, reportId, snapshotId, observationIds };
    });
    const referenceMappings = evidence.references.map(reference => {
      const snapshotId = snapshot(reference.document), referenceId = hashValue({ scopeId: options.scopeId, reference });
      const added = insert(db, `INSERT OR IGNORE INTO evidence_references(id, scope_id, source_id, snapshot_id,
        origin, author_role, approval, note, reference_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      referenceId, options.scopeId, reference.id, snapshotId, reference.origin, reference.authorRole, reference.approval,
      reference.note, json(reference));
      counts.references[added ? 'added' : 'existing']++;
      insert(db, 'INSERT OR IGNORE INTO batch_references(batch_id, source_id, reference_id) VALUES (?, ?, ?)',
        batchId, reference.id, referenceId);
      return { sourceReferenceId: reference.id, referenceId, snapshotId };
    });
    return { schemaVersion: '1.0.0' as const, batchId, evidenceHash, scopeId: options.scopeId, reportMappings, referenceMappings, counts,
      ...flags, attachmentHashesAreSourceDeclarations: true as const };
  }); } finally { db.close(); }
}

export async function feedbackLibraryStats(dbPath: string) {
  const db = await database(dbPath);
  const count = (sql: string) => number(one(db, sql)?.n);
  try { return {
    schemaVersion: '1.0.0' as const,
    counts: {
      batches: count('SELECT COUNT(*) n FROM import_batches'), reports: count('SELECT COUNT(*) n FROM reports'),
      observations: count('SELECT COUNT(*) n FROM observations'), snapshots: count('SELECT COUNT(*) n FROM snapshots'),
      featureTagInstances: count('SELECT COUNT(*) n FROM observation_tags'),
      uniqueFeatureTags: count('SELECT COUNT(DISTINCT value) n FROM observation_tags'),
      independentDocumentBodies: count('SELECT COUNT(DISTINCT s.body_hash) n FROM reports r JOIN snapshots s ON s.id=r.snapshot_id'),
      references: count('SELECT COUNT(*) n FROM evidence_references'), attachments: count('SELECT COUNT(*) n FROM attachments'),
      interpretations: count('SELECT COUNT(*) n FROM interpretations'), trials: count('SELECT COUNT(*) n FROM trials'),
      retestPairs: count('SELECT COUNT(*) n FROM trials WHERE before_report_id IS NOT NULL AND after_report_id IS NOT NULL')
    }, unknown: {
      modelVersion: count('SELECT COUNT(*) n FROM reports WHERE model_version IS NULL'),
      observedAt: count('SELECT COUNT(*) n FROM reports WHERE observed_at IS NULL'),
      rawScore: count('SELECT COUNT(*) n FROM reports WHERE raw_score IS NULL'),
      documentLabel: count("SELECT COUNT(*) n FROM reports WHERE document_label='unknown'"),
      explanations: count('SELECT COUNT(*) n FROM observations WHERE explanation IS NULL'),
      observedStrength: count('SELECT COUNT(*) n FROM observations WHERE observed_strength IS NULL')
    }, labels: all(db, 'SELECT document_label label, COUNT(*) count FROM reports GROUP BY document_label ORDER BY document_label')
      .map(row => ({ label: String(row.label), count: number(row.count) })),
    ...flags, improvementEstablished: false as const
  }; } finally { db.close(); }
}

export async function recallFeedback(dbPath: string, rawQuery: FeedbackRecallQuery = {}) {
  const query = feedbackRecallQuerySchema.parse(rawQuery), db = await database(dbPath);
  try {
    const clauses: string[] = [], parameters: Parameter[] = [];
    if (query.scopeId) { clauses.push('r.scope_id=?'); parameters.push(query.scopeId); }
    if (query.featureTag) {
      clauses.push('EXISTS (SELECT 1 FROM observation_tags t WHERE t.observation_id=o.id AND t.value=?)'); parameters.push(query.featureTag);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = all(db, `SELECT o.*, r.scope_id, r.source_id, r.snapshot_id, r.tool_name, r.model_version, r.observed_at,
      r.document_label, r.label_source, r.raw_score, r.report_json FROM observations o JOIN reports r ON r.id=o.report_id
      ${where} ORDER BY r.scope_id, r.source_id, r.id, o.comment_index`, ...parameters);
    const observations = [];
    for (const row of rows) {
      const observationId = String(row.id), reportId = String(row.report_id), commentIndex = number(row.comment_index);
      const tags = all(db, 'SELECT value FROM observation_tags WHERE observation_id=? ORDER BY tag_index', observationId).map(value => String(value.value));
      const values = interpretationDetails(db, reportId, commentIndex), current = values.filter(item => item.isCurrent);
      // Historical classifications never make an observation match a current category or dimension.
      if (query.dimension && !current.some(item => item.row.dimension === query.dimension)) continue;
      if ((query.categoryId || query.taxonomyVersion) && !current.some(item => item.classification &&
        (!query.taxonomyVersion || item.classification.taxonomyVersion === query.taxonomyVersion) &&
        (!query.categoryId || item.classification.categories.some(category => category.categoryId === query.categoryId)))) continue;
      const interpretations = (query.interpretationHistory === 'all' ? values : current).map(item => ({
        interpretationId: String(item.row.id), dimension: String(item.row.dimension), status: String(item.row.status), authorRole: String(item.row.author_role),
        supersedesInterpretationId: typeof item.payload.supersedesInterpretationId === 'string' ? item.payload.supersedesInterpretationId : null,
        isSuperseded: item.supersededBy.length > 0, supersededBy: item.supersededBy, isCurrent: item.isCurrent,
        ...(item.classification ? { classification: item.classification } : {}),
        ...(query.includeText ? { record: item.payload } : {})
      }));
      const sourceArtifacts = all(db, `SELECT a.kind, a.sha256 FROM report_attachments ra JOIN attachments a ON a.id=ra.attachment_id
        WHERE ra.report_id=? ORDER BY ra.attachment_index`, reportId).map(item => ({ kind: String(item.kind), sha256: String(item.sha256) }));
      const sourceObservation = (JSON.parse(String(row.report_json)) as StyleEvidence['reports'][number])
        .comments[commentIndex]?.sourceObservation;
      observations.push({
        observationId, reportId, sourceReportId: String(row.source_id), snapshotId: String(row.snapshot_id),
        scopeId: String(row.scope_id), commentIndex, toolName: String(row.tool_name), modelVersion: row.model_version as string | null,
        observedAt: row.observed_at as string | null, documentLabel: String(row.document_label), labelSource: String(row.label_source),
        rawScore: row.raw_score as string | null, featureTags: tags, sourceArtifacts, interpretations,
        ...(sourceObservation ? { sourceObservation: {
          artifactSha256: sourceObservation.artifactSha256, visibility: sourceObservation.visibility,
          anchorRelation: sourceObservation.anchorRelation, transcription: sourceObservation.transcription,
          ...(query.includeText ? { visibleText: sourceObservation.visibleText } : {})
        } } : {}),
        hasExplanation: row.explanation !== null, observedStrength: row.observed_strength as string | null,
        ...(query.includeText ? { anchor: { blockId: String(row.block_id), start: number(row.start_offset), end: number(row.end_offset), quote: String(row.quote) },
          explanation: row.explanation as string | null,
          testedDocument: JSON.parse(String(one(db, 'SELECT document_json FROM snapshots WHERE id=?', String(row.snapshot_id))!.document_json)) as TextDocument } : {})
      });
      if (observations.length === query.limit) break;
    }
    return { schemaVersion: '1.0.0' as const, observations, limit: query.limit, containsDocumentText: query.includeText,
      evidenceAuthenticityVerified: false as const, detectorReplicated: false as const, improvementEstablished: false as const };
  } finally { db.close(); }
}

function interpretationDetails(db: Database, reportId: string, commentIndex?: number) {
  const rows = all(db, `SELECT id, comment_index, dimension, status, author_role, record_json FROM interpretations
    WHERE report_id=? ORDER BY id`, reportId).map(row => ({ row,
    payload: JSON.parse(String(row.record_json)) as Record<string, unknown> }));
  return rows.filter(item => commentIndex === undefined || item.row.comment_index === null || item.row.comment_index === commentIndex).map(item => {
    const supersededBy = rows.filter(other => other.payload.supersedesInterpretationId === item.row.id).map(other => String(other.row.id));
    const classification = item.payload.classification === undefined ? undefined : feedbackClassificationSchema.parse(item.payload.classification);
    return { ...item, classification, supersededBy, isCurrent: supersededBy.length === 0 && item.row.status !== 'rejected' };
  });
}

function appendInterpretation(db: Database, input: ReturnType<typeof feedbackInterpretationSchema.parse>) {
  const interpretationId = hashValue(input);
  const added = insert(db, `INSERT OR IGNORE INTO interpretations(id, report_id, comment_index, dimension, status,
    author_role, record_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, interpretationId, input.reportId,
  input.commentIndex ?? null, input.dimension, input.status, input.authorRole, json(input), new Date().toISOString());
  return { schemaVersion: '1.0.0' as const, interpretationId, status: input.status, added,
    containsDocumentText: false as const, confirmationAuthenticated: false as const, ruleAutomaticallyAdopted: false as const };
}

export async function categorizeFeedback(dbPath: string, rawInput: FeedbackCategorizeInput = {}) {
  const input = feedbackCategorizeSchema.parse(rawInput), db = await database(dbPath, input.apply, true);
  try {
    const clauses: string[] = [], parameters: Parameter[] = [];
    if (input.scopeId) { clauses.push('r.scope_id=?'); parameters.push(input.scopeId); }
    if (input.reportId) { clauses.push('r.id=?'); parameters.push(input.reportId); }
    if (input.reportId && !one(db, 'SELECT id FROM reports WHERE id=?' + (input.scopeId ? ' AND scope_id=?' : ''),
      input.reportId, ...(input.scopeId ? [input.scopeId] : []))) fail('feedback-library-report', 'Choose an existing report in the requested scope.');
    const rows = all(db, `SELECT o.id, o.report_id, o.comment_index FROM observations o JOIN reports r ON r.id=o.report_id
      ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY r.id, o.comment_index`, ...parameters);
    const plans: ReturnType<typeof feedbackInterpretationSchema.parse>[] = [], unknownTags = new Map<string, number>();
    let mappedTagInstances = 0, unclassifiedObservations = 0;
    const catalog = getFeedbackTaxonomy();
    const domains = (tag: string) => Object.hasOwn(FEEDBACK_TAG_REVIEW_DOMAINS, tag) ? FEEDBACK_TAG_REVIEW_DOMAINS[tag] : undefined;
    for (const row of rows) {
      const tags = all(db, 'SELECT value FROM observation_tags WHERE observation_id=? ORDER BY tag_index', String(row.id))
        .map(item => String(item.value));
      const mapped = new Set(FEEDBACK_CATEGORY_IDS.filter(categoryId => tags.some(tag => domains(tag)?.includes(categoryId))));
      for (const tag of tags) {
        if (domains(tag)) mappedTagInstances++;
        else unknownTags.set(tag, (unknownTags.get(tag) ?? 0) + 1);
      }
      if (!mapped.size) { unclassifiedObservations++; continue; }
      plans.push(feedbackInterpretationSchema.parse({ reportId: String(row.report_id), commentIndex: number(row.comment_index),
        dimension: 'other', hypothesis: 'The source labels suggest possible review domains. No sentence-level language defect has been established.',
        editingDecision: 'unresolved', reason: 'Review the source wording and its context before deciding whether any change is warranted.',
        retainCounterexample: catalog.categories.filter(category => mapped.has(category.id)).flatMap(category => category.retainCounterexamples).join(' '),
        authorRole: 'agent', status: 'candidate', methodVersion: 'taxonomy:' + FEEDBACK_TAXONOMY_VERSION,
        classification: { taxonomyVersion: FEEDBACK_TAXONOMY_VERSION,
          categories: [...mapped].map(categoryId => ({ categoryId, relation: 'review-domain' })),
          sourceTags: [...new Set(tags.filter(tag => domains(tag)))], explanationAssessment: 'not-reviewed' }
      }));
    }
    const existing = plans.filter(plan => one(db, 'SELECT id FROM interpretations WHERE id=?', hashValue(plan))).length;
    let added = 0;
    if (input.apply) transaction(db, () => { for (const plan of plans) if (appendInterpretation(db, plan).added) added++; });
    return { schemaVersion: '1.0.0' as const, taxonomyVersion: FEEDBACK_TAXONOMY_VERSION, applied: input.apply,
      counts: { observations: rows.length, mappedObservations: plans.length, unclassifiedObservations,
        mappedTagInstances, unclassifiedTagInstances: [...unknownTags.values()].reduce((a, b) => a + b, 0),
        interpretationsPlanned: plans.length - existing, interpretationsExisting: existing, interpretationsAdded: added },
      unclassifiedTags: [...unknownTags.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sourceTag, instances]) => ({ sourceTag, instances })),
      ...flags, detectorCausalityEstablished: false as const, improvementEstablished: false as const, ruleAutomaticallyAdopted: false as const };
  } finally { db.close(); }
}

export async function feedbackCategoryStats(dbPath: string, rawQuery: FeedbackCategoryStatsQuery = {}) {
  const query = feedbackCategoryStatsQuerySchema.parse(rawQuery), db = await database(dbPath);
  try {
    const reports = all(db, `SELECT r.id, r.snapshot_id, s.body_hash FROM reports r JOIN snapshots s ON s.id=r.snapshot_id
      ${query.scopeId ? 'WHERE r.scope_id=?' : ''} ORDER BY r.id`, ...(query.scopeId ? [query.scopeId] : []));
    const observations: Row[] = [], anchors = new Set<string>(), tagInstances: string[] = [], bodies = new Set<string>();
    const categoryGroups = new Map(FEEDBACK_CATEGORY_IDS.map(categoryId => [categoryId, {
      interpretationIds: new Set<string>(), observationIds: new Set<string>(), anchors: new Set<string>(), reports: new Set<string>(),
      relations: new Map<string, Set<string>>()
    }]));
    let currentInterpretations = 0, classifiedInterpretations = 0, classifiedObservations = 0, legacyUnclassifiedInterpretations = 0;
    for (const report of reports) {
      bodies.add(String(report.body_hash));
      const current = interpretationDetails(db, String(report.id)).filter(item => item.isCurrent);
      currentInterpretations += current.length;
      classifiedInterpretations += current.filter(item => item.classification).length;
      legacyUnclassifiedInterpretations += current.filter(item => !item.classification).length;
      const reportObservations = all(db, 'SELECT * FROM observations WHERE report_id=? ORDER BY comment_index', String(report.id));
      observations.push(...reportObservations);
      for (const observation of reportObservations) {
        const anchorKey = hashValue({ reportId: report.id, blockId: observation.block_id,
          start: observation.start_offset, end: observation.end_offset });
        anchors.add(anchorKey);
        tagInstances.push(...all(db, 'SELECT value FROM observation_tags WHERE observation_id=? ORDER BY tag_index', String(observation.id))
          .map(item => String(item.value)));
        const relevant = current.filter(item => item.classification && (item.row.comment_index === null || item.row.comment_index === observation.comment_index));
        if (relevant.length) classifiedObservations++;
        for (const item of relevant) for (const assignment of item.classification!.categories) {
          const group = categoryGroups.get(assignment.categoryId)!;
          group.interpretationIds.add(String(item.row.id)); group.observationIds.add(String(observation.id));
          group.anchors.add(anchorKey); group.reports.add(String(report.id));
          const relationIds = group.relations.get(assignment.relation) ?? new Set<string>();
          relationIds.add(String(item.row.id)); group.relations.set(assignment.relation, relationIds);
        }
      }
      // A report-level classification remains countable even when the report has no sentence comments.
      for (const item of current.filter(item => item.classification && item.row.comment_index === null))
        for (const assignment of item.classification!.categories) {
          const group = categoryGroups.get(assignment.categoryId)!;
          group.interpretationIds.add(String(item.row.id)); group.reports.add(String(report.id));
          const relationIds = group.relations.get(assignment.relation) ?? new Set<string>();
          relationIds.add(String(item.row.id)); group.relations.set(assignment.relation, relationIds);
        }
    }
    return { schemaVersion: '1.0.0' as const, taxonomyVersion: FEEDBACK_TAXONOMY_VERSION,
      counts: { reports: reports.length, independentDocumentBodies: bodies.size, observations: observations.length,
        uniqueAnchors: anchors.size, tagInstances: tagInstances.length, uniqueSourceTags: new Set(tagInstances).size,
        currentInterpretations, classifiedInterpretations, legacyUnclassifiedInterpretations,
        classifiedObservations, unclassifiedObservations: observations.length - classifiedObservations },
      categories: [...categoryGroups].map(([categoryId, group]) => ({ categoryId, interpretations: group.interpretationIds.size,
        observations: group.observationIds.size, uniqueAnchors: group.anchors.size, reports: group.reports.size,
        relations: Object.fromEntries(['review-domain', 'supported-issue', 'retention-case', 'unresolved']
          .map(relation => [relation, group.relations.get(relation)?.size ?? 0])) })),
      ...flags, detectorCausalityEstablished: false as const, improvementEstablished: false as const,
      authorDiversityEstablished: false as const };
  } finally { db.close(); }
}

export async function recordFeedbackInterpretation(dbPath: string, raw: FeedbackInterpretationInput) {
  const input = feedbackInterpretationSchema.parse(raw), db = await database(dbPath, true, true);
  try { return transaction(db, () => {
    if (!one(db, 'SELECT id FROM reports WHERE id=?', input.reportId))
      fail('feedback-library-report', 'Bind the interpretation to an existing report.');
    if (input.commentIndex !== undefined && !one(db, 'SELECT id FROM observations WHERE report_id=? AND comment_index=?', input.reportId, input.commentIndex))
      fail('feedback-library-observation', 'Bind the interpretation to an existing report comment.');
    if (input.supersedesInterpretationId) {
      const superseded = one(db, 'SELECT report_id, comment_index, dimension FROM interpretations WHERE id=?', input.supersedesInterpretationId);
      if (!superseded || superseded.report_id !== input.reportId || superseded.comment_index !== (input.commentIndex ?? null) ||
          superseded.dimension !== input.dimension)
        fail('feedback-library-supersedes', 'A replacement must name an existing interpretation of the same report, comment and dimension.');
    }
    if (input.classification?.sourceTags.length) {
      const tagRows = all(db, `SELECT t.value FROM observation_tags t JOIN observations o ON o.id=t.observation_id
        WHERE o.report_id=? ${input.commentIndex === undefined ? '' : 'AND o.comment_index=?'}`,
      input.reportId, ...(input.commentIndex === undefined ? [] : [input.commentIndex]));
      if (input.classification.sourceTags.some(tag => !tagRows.some(row => row.value === tag)))
        fail('feedback-library-classification-tag', 'Classification source tags must occur in the bound report or comment.');
    }
    return appendInterpretation(db, input);
  }); } finally { db.close(); }
}

export async function recordFeedbackTrial(dbPath: string, raw: FeedbackTrialInput) {
  const input = feedbackTrialSchema.parse(raw), db = await database(dbPath, true, true);
  try { return transaction(db, () => {
    if (!one(db, 'SELECT id FROM snapshots WHERE id=?', input.beforeSnapshotId))
      fail('feedback-library-snapshot', 'Bind the trial to an existing before snapshot.');
    const afterDocument = documentSchema.parse(input.afterDocument), afterSnapshotId = hashValue(afterDocument);
    for (const [reportId, snapshotId] of [[input.beforeReportId, input.beforeSnapshotId], [input.afterReportId, afterSnapshotId]]) {
      if (!reportId) continue;
      const report = one(db, 'SELECT snapshot_id FROM reports WHERE id=?', reportId);
      if (!report || report.snapshot_id !== snapshotId)
        fail('feedback-library-trial-report', 'Each supplied report must match its exact before or after snapshot.');
    }
    addSnapshot(db, afterDocument);
    const trialId = hashValue(input), status = input.afterReportId ? 'tested' as const : 'untested' as const;
    const added = insert(db, `INSERT OR IGNORE INTO trials(id, before_snapshot_id, after_snapshot_id, before_report_id,
      after_report_id, method_version, status, quality_status, record_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    trialId, input.beforeSnapshotId, afterSnapshotId, input.beforeReportId ?? null, input.afterReportId ?? null,
    input.methodVersion, status, input.qualityReview.status, json(input), new Date().toISOString());
    return { schemaVersion: '1.0.0' as const, trialId, beforeSnapshotId: input.beforeSnapshotId, afterSnapshotId,
      status, qualityStatus: input.qualityReview.status, added, containsDocumentText: false as const,
      improvementEstablished: false as const, detectionImprovementInferred: false as const };
  }); } finally { db.close(); }
}
