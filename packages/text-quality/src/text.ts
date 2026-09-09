import { createHash } from "node:crypto";
import type { TextDocument } from "./contracts.js";

export function hashValue(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .filter(([, x]) => x !== undefined).map(([k, x]) => [k, canonical(x)]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

export function countText(text: string) {
  return {
    englishWords: (text.match(/\d+(?:[.,]\d+)+|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length,
    hanCharacters: (text.match(/\p{Script=Han}/gu) ?? []).length,
    nonWhitespaceCodepoints: [...text].filter((c) => !/\s/u.test(c)).length
  };
}

export function measureDocument(document: TextDocument) {
  return countText(document.blocks.filter((b) => b.kind !== "heading" && b.kind !== "code")
    .map((b) => b.text).join("\n\n"));
}

export function sentences(text: string, language: string): string[] {
  return [...new Intl.Segmenter(language === "en" ? "en" : "zh", { granularity: "sentence" }).segment(text)]
    .map((s) => s.segment.trim()).filter(Boolean);
}

export function codepointOffset(text: string, utf16Offset: number): number {
  return [...text.slice(0, utf16Offset)].length;
}
