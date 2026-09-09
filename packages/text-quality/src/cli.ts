#!/usr/bin/env node
import { z } from "zod";
import { createReadStream } from "node:fs";
import { auditText, prepareWriting } from "./audit.js";
import { validateEdits } from "./edits.js";
import { parseJsonText, validationDetails } from "./validation.js";
import { auditInputSchema, editInputSchema, policySchema, describeContracts, CONTRACT_VERSION, ENGINE_VERSION, MAX_REQUEST_BYTES } from "./contracts.js";

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ schemaVersion: z.literal(CONTRACT_VERSION), operation: z.literal("describe") }).strict(),
  z.object({ schemaVersion: z.literal(CONTRACT_VERSION), operation: z.enum(["audit", "prepare"]), input: auditInputSchema, policy: policySchema }).strict(),
  z.object({ schemaVersion: z.literal(CONTRACT_VERSION), operation: z.literal("validate-edits"), input: editInputSchema }).strict()
]);
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    process.stdout.write("text-quality [--input request.json]\nSend a JSON request or read a UTF-8 file.\n--version  --schema\nOperations: describe, prepare, audit, validate-edits\nAudit and prepare require an explicit policy. Exit: 0 complete, 1 invalid, 2 blocked, 3 review needed.\n"); return;
  }
  if (args.length === 1 && args[0] === "--version") { process.stdout.write(ENGINE_VERSION + "\n"); return; }
  if (args.length === 1 && args[0] === "--schema") { process.stdout.write(JSON.stringify({ ...describeContracts(), request: z.toJSONSchema(requestSchema) }) + "\n"); return; }
  if (args.length && !(args.length === 2 && args[0] === "--input")) throw new Error("invalid-argument");
  if (!args.length && process.stdin.isTTY) throw new Error("input-required");
  const stream = args.length ? createReadStream(args[1]!) : process.stdin;
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of stream) { const b = Buffer.from(chunk); size += b.length; if (size > MAX_REQUEST_BYTES) throw new Error("input-too-large"); chunks.push(b); }
  const request = requestSchema.parse(parseJsonText(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
  let result: unknown;
  if (request.operation === "describe") result = { schemaVersion: CONTRACT_VERSION, engineVersion: ENGINE_VERSION,
    operations: ["describe", "prepare", "audit", "validate-edits"], languages: ["en", "zh", "mixed"], maxRequestBytes: MAX_REQUEST_BYTES,
    offsetUnit: "unicode-codepoint", policyRequired: true, automaticSemanticReview: false, schemaCommand: "text-quality --schema" };
  else if (request.operation === "validate-edits") {
    const { candidate, ...summary } = validateEdits(request.input);
    result = { ...summary, candidateAvailable: candidate !== null, containsDocumentText: false };
    process.exitCode = summary.status === "rejected" ? 2 : 3;
  } else if (request.operation === "prepare") result = prepareWriting(request.input, request.policy);
  else { const audit = auditText(request.input, request.policy); result = audit; process.exitCode = audit.qualityDecision === "blocked" ? 2 : audit.qualityDecision === "needs-review" ? 3 : 0; }
  process.stdout.write(JSON.stringify(result) + "\n");
}
main().catch((error: unknown) => {
  const code = error instanceof Error && ["input-too-large", "input-required", "invalid-argument"].includes(error.message) ? error.message : "invalid-request";
  process.stdout.write(JSON.stringify({ schemaVersion: CONTRACT_VERSION, executionStatus: "failed", error: { code, fields: validationDetails(error) }, containsDocumentText: false, deliveryAuthorized: false }) + "\n");
  process.exitCode = 1;
});
