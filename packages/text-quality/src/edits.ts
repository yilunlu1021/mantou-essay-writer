import { editInputSchema, documentSchema, CONTRACT_VERSION } from "./contracts.js";
import { hashValue } from "./text.js";

export function validateEdits(raw: unknown) {
  const input = editInputSchema.parse(raw);
  const issues: string[] = [];
  if (hashValue(input.original) !== input.expectedDocumentHash) issues.push("stale-document");
  if (hashValue(input.context) !== input.expectedContextHash) issues.push("stale-context");
  if (input.context.mode === "revision" && !input.context.revisionAuthorized) issues.push("revision-authorization-required");
  const blocks = new Map(input.original.blocks.map((b) => [b.id, b]));
  for (const range of [...input.patches, ...input.protectedRanges]) {
    const b = blocks.get(range.blockId);
    if (!b || range.end > [...b.text].length) issues.push("invalid-range");
  }
  let changedCodepoints = 0;
  const sorted = [...input.patches].sort((a, b) => a.blockId.localeCompare(b.blockId) || a.start - b.start || a.end - b.end);
  for (let i = 0; i < sorted.length; i++) {
    const patch = sorted[i]!;
    const block = blocks.get(patch.blockId);
    const actual = block ? [...block.text].slice(patch.start, patch.end).join("") : null;
    if (actual !== patch.expectedText) issues.push("source-mismatch");
    const prior = sorted[i - 1];
    if (prior && prior.blockId === patch.blockId &&
      (patch.start < prior.end || patch.start === prior.start)) issues.push("overlapping-patches");
    if (input.protectedRanges.some((r) => r.blockId === patch.blockId &&
      (patch.start === patch.end ? patch.start >= r.start && patch.start < r.end : patch.start < r.end && patch.end > r.start)))
      issues.push("protected-range");
    if (patch.expectedText !== patch.replacement)
      changedCodepoints += [...patch.expectedText].length + [...patch.replacement].length;
  }
  if (input.maxChangedCodepoints !== undefined && changedCodepoints > input.maxChangedCodepoints)
    issues.push("edit-budget-exceeded");
  let valid = issues.length === 0;
  const candidate = valid ? {
    ...input.original,
    revision: changedCodepoints === 0 ? input.original.revision : "edited-" + hashValue(input.patches).slice(0, 16),
    blocks: input.original.blocks.map((b) => {
      let chars = [...b.text];
      for (const p of sorted.filter((p) => p.blockId === b.id).reverse())
        chars = chars.slice(0, p.start).concat([...p.replacement], chars.slice(p.end));
      return { ...b, text: chars.join("") };
    })
  } : null;
  if (candidate && !documentSchema.safeParse(candidate).success) {
    issues.push("candidate-limit-exceeded");
    valid = false;
  }
  return {
    schemaVersion: CONTRACT_VERSION,
    status: valid ? "valid-needs-review" as const : "rejected" as const,
    issues: [...new Set(issues)],
    changedCodepoints,
    candidate: valid ? candidate : null,
    requiresHumanReview: true,
    semanticEquivalenceChecked: false,
    deliveryAuthorized: false
  };
}
