import { z } from 'zod';
import { documentSchema } from '@mantou/text-quality';
import { feedbackCategoryIdSchema, feedbackClassificationSchema, FEEDBACK_TAXONOMY_VERSION } from './feedback-taxonomy.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const note = z.string().trim().min(1).max(4000);
export const feedbackDimensionSchema = z.enum([
  'main-clause', 'attachments', 'diction', 'stance', 'cadence', 'information', 'logic', 'narrative', 'other'
]);
export const feedbackImportOptionsSchema = z.object({
  scopeId: identifier.default('local'),
  context: z.object({ genre: note.optional(), authorRole: z.enum(['student', 'advisor', 'unknown']).optional(),
    language: note.optional(), note: note.optional() }).strict().default({})
}).strict();
export const feedbackRecallQuerySchema = z.object({
  scopeId: identifier.optional(), featureTag: note.optional(), dimension: feedbackDimensionSchema.optional(),
  categoryId: feedbackCategoryIdSchema.optional(), taxonomyVersion: z.literal(FEEDBACK_TAXONOMY_VERSION).optional(),
  interpretationHistory: z.enum(['current', 'all']).default('current'),
  limit: z.number().int().min(1).max(100).default(30), includeText: z.boolean().default(false)
}).strict();
export const feedbackCategorizeSchema = z.object({
  scopeId: identifier.optional(), reportId: digest.optional(), apply: z.boolean().default(false)
}).strict();
export const feedbackCategoryStatsQuerySchema = z.object({ scopeId: identifier.optional() }).strict();
export const feedbackInterpretationSchema = z.object({
  reportId: digest, commentIndex: z.number().int().nonnegative().optional(), dimension: feedbackDimensionSchema,
  hypothesis: note, editingDecision: z.enum(['retain', 'revise', 'unresolved']), reason: note, retainCounterexample: note,
  authorRole: z.enum(['agent', 'advisor', 'student', 'unknown']), status: z.enum(['candidate', 'confirmed', 'rejected']),
  confirmationSource: note.optional(), contextDocumentHash: digest.optional(), reviewRecordHash: digest.optional(), methodVersion: note.optional(),
  supersedesInterpretationId: digest.optional(), classification: feedbackClassificationSchema.optional()
}).strict().superRefine((value, ctx) => {
  if (value.status === 'confirmed' && !value.confirmationSource)
    ctx.addIssue({ code: 'custom', path: ['confirmationSource'], message: 'A confirmed interpretation needs its declared confirmation source.' });
});
export const feedbackTrialSchema = z.object({
  beforeSnapshotId: digest, afterDocument: documentSchema, beforeReportId: digest.optional(), afterReportId: digest.optional(),
  methodVersion: note, changes: z.array(note).min(1).max(100),
  qualityReview: z.object({ status: z.enum(['pending', 'acceptable', 'needs-rework']), reason: note,
    reviewerRole: z.enum(['agent', 'advisor', 'student', 'unknown']) }).strict(),
  comparisonConditions: z.object({ sameToolVersion: z.boolean().nullable(), sameSettings: z.boolean().nullable(),
    sameScope: z.boolean().nullable(), note }).strict()
}).strict();
export type FeedbackImportOptions = z.input<typeof feedbackImportOptionsSchema>;
export type FeedbackRecallQuery = z.input<typeof feedbackRecallQuerySchema>;
export type FeedbackInterpretationInput = z.input<typeof feedbackInterpretationSchema>;
export type FeedbackTrialInput = z.input<typeof feedbackTrialSchema>;
export type FeedbackCategorizeInput = z.input<typeof feedbackCategorizeSchema>;
export type FeedbackCategoryStatsQuery = z.input<typeof feedbackCategoryStatsQuerySchema>;

export const FEEDBACK_LIBRARY_SCHEMA_VERSION = 1;
export const FEEDBACK_LIBRARY_SCHEMA = `
CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO library_meta VALUES ('schema_version', '1');
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, document_json TEXT NOT NULL
) STRICT;
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, evidence_hash TEXT NOT NULL,
  context_json TEXT NOT NULL, evidence_json TEXT NOT NULL, imported_at TEXT NOT NULL
) STRICT;
CREATE TABLE reports (
  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id), tool_name TEXT NOT NULL,
  model_version TEXT, observed_at TEXT, document_label TEXT NOT NULL, label_source TEXT NOT NULL,
  raw_score TEXT, report_json TEXT NOT NULL
) STRICT;
CREATE TABLE observations (
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id), comment_index INTEGER NOT NULL,
  block_id TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, quote TEXT NOT NULL,
  explanation TEXT, observed_strength TEXT, UNIQUE(report_id, comment_index)
) STRICT;
CREATE TABLE observation_tags (
  observation_id TEXT NOT NULL REFERENCES observations(id), tag_index INTEGER NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(observation_id, tag_index)
) STRICT;
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT NOT NULL, UNIQUE(kind, sha256)
) STRICT;
CREATE TABLE report_attachments (
  report_id TEXT NOT NULL REFERENCES reports(id), attachment_index INTEGER NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY(report_id, attachment_index)
) STRICT;
CREATE TABLE evidence_references (
  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, source_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id), origin TEXT NOT NULL,
  author_role TEXT NOT NULL, approval TEXT NOT NULL, note TEXT NOT NULL, reference_json TEXT NOT NULL
) STRICT;
CREATE TABLE batch_reports (
  batch_id TEXT NOT NULL REFERENCES import_batches(id), source_id TEXT NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id), PRIMARY KEY(batch_id, source_id)
) STRICT;
CREATE TABLE batch_references (
  batch_id TEXT NOT NULL REFERENCES import_batches(id), source_id TEXT NOT NULL,
  reference_id TEXT NOT NULL REFERENCES evidence_references(id), PRIMARY KEY(batch_id, source_id)
) STRICT;
CREATE TABLE interpretations (
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id), comment_index INTEGER,
  dimension TEXT NOT NULL, status TEXT NOT NULL, author_role TEXT NOT NULL,
  record_json TEXT NOT NULL, recorded_at TEXT NOT NULL
) STRICT;
CREATE TABLE trials (
  id TEXT PRIMARY KEY, before_snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  after_snapshot_id TEXT NOT NULL REFERENCES snapshots(id), before_report_id TEXT REFERENCES reports(id),
  after_report_id TEXT REFERENCES reports(id), method_version TEXT NOT NULL, status TEXT NOT NULL,
  quality_status TEXT NOT NULL, record_json TEXT NOT NULL, recorded_at TEXT NOT NULL
) STRICT;
CREATE INDEX reports_scope ON reports(scope_id);
CREATE INDEX observations_report ON observations(report_id);
CREATE INDEX tags_value ON observation_tags(value);
CREATE INDEX interpretations_dimension ON interpretations(dimension, report_id, comment_index);
`;
