import { z } from "zod";

export const CONTRACT_VERSION = "1.0.0";
export const ENGINE_VERSION = "0.2.0";
export const MAX_REQUEST_BYTES = 1_000_000;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(120_000).refine(
  (value) => [...value].every((c) => !/^[\uD800-\uDFFF]$/.test(c)), "Invalid Unicode text"
);
export const genreSchema = z.enum([
  "personal-narrative", "application-explanatory", "academic", "advisor-feedback", "general", "unknown"
]);
const roleSchema = z.enum(["student", "advisor", "institution"]);
export const blockSchema = z.object({
  id,
  text,
  kind: z.enum(["body", "comment", "heading", "quote", "code", "official-name"]).default("body"),
  role: roleSchema.optional(),
  functions: z.array(z.enum(["narrative", "reflection", "explanation", "plan", "ending"])).max(5).default([]),
  sourceRef: id.optional()
}).strict();
export const documentSchema = z.object({
  revision: id,
  blocks: z.array(blockSchema).min(1).max(200)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.blocks.map((b) => b.id)).size !== value.blocks.length)
    ctx.addIssue({ code: "custom", message: "Duplicate block ID" });
  if (value.blocks.reduce((n, b) => n + b.text.length, 0) > 200_000)
    ctx.addIssue({ code: "custom", message: "Document exceeds text limit" });
});
export const contextSchema = z.object({
  language: z.enum(["en", "zh", "mixed"]),
  genre: genreSchema,
  authorRole: roleSchema,
  mode: z.enum(["edit", "revision", "draft"]).default("edit"),
  revisionAuthorized: z.boolean().default(false),
  stage: z.enum(["material", "working", "clean-draft"]).default("working"),
  channel: z.enum(["wechat", "document", "chat", "unknown"]).default("unknown"),
  audience: z.string().min(1).max(200),
  prompt: z.string().max(10_000).default(""),
  length: z.object({
    unit: z.enum(["english-words", "han-characters", "non-whitespace-codepoints"]),
    min: z.number().int().nonnegative().max(200_000).optional(),
    max: z.number().int().nonnegative().max(200_000).optional()
  }).strict().refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, "Invalid length range").optional()
}).strict();
export const auditInputSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  context: contextSchema,
  document: documentSchema,
  original: documentSchema.optional()
}).strict();
export const ruleSchema = z.object({
  id,
  source: z.string().min(1).max(300),
  requirement: z.string().min(1).max(2500),
  scope: z.enum(["all", "student", "advisor", "advisor-comment", "narrative", "english-narrative", "material", "early-wechat-feedback", "clean-draft"]),
  check: z.enum(["manual", "punctuation", "english-terms", "adverbs", "chinese-terms", "contrast",
    "defensive", "fillers", "rhythm-length", "rhythm-opening", "narrative-ending", "editorial-slots"]),
  manualRequired: z.boolean(),
  exemptOriginal: z.boolean().default(false),
  terms: z.array(z.object({ value: z.string().min(1).max(120), conditional: z.boolean().default(false) }).strict()).max(100).default([])
}).strict();
export const policySchema = z.object({
  id, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sources: z.array(z.object({ path: z.string().min(1).max(300), version: z.string().min(1), sha256: sha,
    normalization: z.enum(["raw-utf8", "lf-utf8"]).default("raw-utf8") }).strict()).min(1).max(10),
  rules: z.array(ruleSchema).min(1).max(200)
}).strict().superRefine((p, ctx) => {
  if (new Set(p.rules.map((r) => r.id)).size !== p.rules.length)
    ctx.addIssue({ code: "custom", message: "Duplicate rule ID" });
  for (const r of p.rules) {
    if (r.check === "manual" && !r.manualRequired)
      ctx.addIssue({ code: "custom", message: "Manual rule cannot be automatically complete" });
  }
});
const rangeSchema = z.object({
  blockId: id, start: z.number().int().nonnegative(), end: z.number().int().nonnegative()
}).strict().refine((r) => r.end >= r.start, "Invalid range");
export const editInputSchema = z.object({
  schemaVersion: z.literal(CONTRACT_VERSION),
  context: contextSchema,
  original: documentSchema,
  expectedDocumentHash: sha,
  expectedContextHash: sha,
  protectedRanges: z.array(rangeSchema).max(500).default([]),
  maxChangedCodepoints: z.number().int().nonnegative().max(200_000).optional(),
  patches: z.array(rangeSchema.safeExtend({
    expectedText: text,
    replacement: text,
    reason: z.string().min(1).max(1000)
  })).max(200)
}).strict().superRefine((v, ctx) => {
  if (v.patches.reduce((n, p) => n + p.expectedText.length + p.replacement.length, 0) > 200_000)
    ctx.addIssue({ code: "custom", message: "Edit request exceeds text limit" });
});
export type TextContext = z.infer<typeof contextSchema>;
export type TextDocument = z.infer<typeof documentSchema>;
export type TextBlock = z.infer<typeof blockSchema>;
export type AuditInput = z.infer<typeof auditInputSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Rule = z.infer<typeof ruleSchema>;
export function describeContracts() {
  return {
    schemaVersion: CONTRACT_VERSION,
    auditInput: z.toJSONSchema(auditInputSchema),
    editInput: z.toJSONSchema(editInputSchema),
    policy: z.toJSONSchema(policySchema)
  };
}
export interface Finding {
  ruleId: string;
  code: string;
  severity: "error" | "warning";
  message: string;
  blockId?: string;
  start?: number;
  end?: number;
}
export interface Coverage {
  ruleId: string;
  status: "checked" | "not-applicable" | "not-checked" | "needs-review";
  reason: string;
}
