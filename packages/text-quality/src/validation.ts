import { z } from "zod";

export function parseJsonText(value: string): unknown {
  return JSON.parse(value.replace(/^\uFEFF/, ""));
}

/** Structural diagnostics only. Never include the submitted value or Zod's prose. */
export function validationDetails(error: unknown) {
  return error instanceof z.ZodError ? error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."), code: issue.code,
    ...("expected" in issue && typeof issue.expected === "string" ? { expected: issue.expected } : {})
  })) : [];
}

export function isPortableFilename(name: string): boolean {
  return name.length > 0 && Buffer.byteLength(name, "utf8") <= 240 &&
    !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) && !/[. ]$/.test(name) &&
    name !== "." && name !== ".." && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name);
}
