import {
  auditInputSchema, policySchema, CONTRACT_VERSION, ENGINE_VERSION,
  type AuditInput, type TextBlock, type Policy, type Rule, type Finding, type Coverage
} from "./contracts.js";
import { hashValue, countText, measureDocument, sentences, codepointOffset } from "./text.js";

export interface AuditOptions {
  // Host-owned verifier. Never populated from a document's own approval claims.
  verifyOriginalBlock?: (block: Readonly<TextBlock>) => boolean;
}

function applies(rule: Rule, input: AuditInput, block: TextBlock): boolean {
  const role = block.role ?? input.context.authorRole;
  const narrative = role === "student" && (block.functions.includes("narrative") ||
    ((input.context.genre === "personal-narrative" || input.context.genre === "unknown") &&
      (block.functions.length === 0 || block.functions.every((f) => f === "ending" || f === "reflection"))));
  switch (rule.scope) {
    case "student": return role === "student";
    case "advisor": return role === "advisor";
    case "advisor-comment": return role === "advisor" &&
      (input.context.genre === "advisor-feedback" || block.kind === "comment");
    case "narrative": return narrative;
    case "english-narrative": return narrative && /[A-Za-z]/.test(block.text);
    case "material": return input.context.stage === "material" &&
      (role === "student" || (role === "advisor" && input.context.genre === "advisor-feedback"));
    case "early-wechat-feedback": return role === "advisor" && input.context.stage === "material" &&
      input.context.genre === "advisor-feedback" && ["wechat", "unknown"].includes(input.context.channel);
    case "clean-draft": return role === "student" && input.context.stage === "clean-draft";
    default: return true;
  }
}

export function prepareWriting(rawInput: unknown, rawPolicy: unknown) {
  const input = auditInputSchema.parse(rawInput);
  const policy = policySchema.parse(rawPolicy);
  return {
    schemaVersion: CONTRACT_VERSION,
    engineVersion: ENGINE_VERSION,
    bindings: bindings(input, policy),
    editMode: input.context.mode,
    originalAvailable: input.original !== undefined,
    rules: policy.rules.filter((r) => input.document.blocks.some((b) => applies(r, input, b)))
      .map((r) => ({ ruleId: r.id, requirement: r.requirement, source: r.source, manualRequired: r.manualRequired,
        conditionNeedsReview: r.scope === "early-wechat-feedback" && input.context.channel === "unknown" })),
    containsDocumentText: false,
    deliveryAuthorized: false
  };
}

export function auditText(rawInput: unknown, rawPolicy: unknown, options: AuditOptions = {}) {
  const input = auditInputSchema.parse(rawInput);
  const policy = policySchema.parse(rawPolicy);
  const findings: Finding[] = [];
  let truncated = false;
  let observedErrors = 0;
  const add = (finding: Finding) => {
    if (finding.severity === "error") observedErrors++;
    if (findings.length < 1000) findings.push(finding);
    else truncated = true;
  };
  const exempt = new Set<string>();
  for (const block of input.document.blocks) {
    if (!["quote", "code", "official-name"].includes(block.kind)) continue;
    if (block.sourceRef && options.verifyOriginalBlock?.(block) === true) exempt.add(block.id);
    else add({ ruleId: "context", code: "unverified-exception", severity: "warning", blockId: block.id,
      message: "原貌例外尚未由宿主核对，继续检查正文并要求人工复核。" });
  }
  const coverage: Coverage[] = policy.rules.map((rule) => {
    const blocks = input.document.blocks.filter((b) => applies(rule, input, b) && !(rule.exemptOriginal && exempt.has(b.id)));
    if (!blocks.length) return { ruleId: rule.id, status: "not-applicable", reason: "本次范围不适用，或精确原貌区块已由宿主验证。" };
    if (rule.check === "manual") return { ruleId: rule.id, status: "needs-review", reason: rule.requirement };
    const uncertainGenre = input.context.genre === "unknown" &&
      (rule.scope === "narrative" || rule.scope === "english-narrative");
    if (uncertainGenre) return { ruleId: rule.id, status: "needs-review", reason: "缺少体裁上下文，不能推定叙事结尾规则适用。" };
    runCheck(rule, blocks, input, add);
    const needsReview = rule.manualRequired || findings.some((f) => f.ruleId === rule.id && f.severity === "warning");
    return {
      ruleId: rule.id,
      status: needsReview ? "needs-review" : "checked",
      reason: needsReview ? "已完成候选定位，仍须结合语境执行本条要求。" : "已完成本条可判定检查。"
    };
  });
  if (input.context.mode === "revision" && !input.context.revisionAuthorized)
    add({ ruleId: "context", code: "revision-authorization-required", severity: "error", message: "结构修改缺少明确任务授权。" });
  if (input.context.mode === "edit" && !input.original)
    add({ ruleId: "context", code: "original-required-for-voice", severity: "warning", message: "缺少原稿快照，尚未完成原稿与作者声音对照。" });
  if (input.context.genre === "unknown")
    add({ ruleId: "context", code: "genre-needs-review", severity: "warning", message: "体裁未明确，专用规则尚待核对。" });
  const metrics = measureDocument(input.document);
  const length = input.context.length;
  if (length) {
    const measured = length.unit === "english-words" ? metrics.englishWords :
      length.unit === "han-characters" ? metrics.hanCharacters : metrics.nonWhitespaceCodepoints;
    if ((length.min !== undefined && measured < length.min) || (length.max !== undefined && measured > length.max))
      add({ ruleId: "length", code: "word-count-range", severity: "error", message: "正文长度不在本次任务约定范围内。" });
  }
  const pending = coverage.some((c) => c.status === "needs-review" || c.status === "not-checked");
  const errors = observedErrors;
  return {
    schemaVersion: CONTRACT_VERSION,
    engineVersion: ENGINE_VERSION,
    policy: { id: policy.id, version: policy.version, sources: policy.sources },
    bindings: bindings(input, policy),
    executionStatus: truncated || pending ? "partial" as const : "complete" as const,
    qualityDecision: errors ? "blocked" as const : pending || findings.length || truncated ? "needs-review" as const : "clear" as const,
    coverage, findings, metrics, findingsTruncated: truncated, observedErrors,
    requiresHumanReview: pending || findings.some((f) => f.severity === "warning") || truncated,
    containsDocumentText: false,
    deliveryAuthorized: false
  };
}

function bindings(input: AuditInput, policy: Policy) {
  return {
    documentHash: hashValue(input.document),
    contextHash: hashValue(input.context),
    originalHash: input.original ? hashValue(input.original) : null,
    policyHash: hashValue(policy),
    engineVersion: ENGINE_VERSION,
    serializationVersion: "sorted-json-utf8@1",
    offsetUnit: "unicode-codepoint"
  };
}

function runCheck(rule: Rule, blocks: TextBlock[], input: AuditInput, add: (f: Finding) => void) {
  const emit = (block: TextBlock, code: string, severity: "error" | "warning", message: string, start = 0, end = block.text.length) =>
    add({ ruleId: rule.id, code, severity, message, blockId: block.id,
      start: codepointOffset(block.text, start), end: codepointOffset(block.text, end) });
  const scan = (block: TextBlock, regex: RegExp, code: string, severity: "error" | "warning", message: string) => {
    for (const match of block.text.matchAll(regex))
      emit(block, code, severity, message, match.index, match.index + match[0].length);
  };
  for (const block of blocks) {
    switch (rule.check) {
      case "punctuation":
        scan(block, /\u2014/g, "em-dash", "error", "改用逗号、括号或自然拆句。");
        scan(block, /\u2013/g, "en-dash", "error", "数字区间使用普通连字符。");
        scan(block, /[;；]/g, "semicolon", "error", "分号应通过拆句或连词处理。");
        if (/[A-Za-z]/.test(block.text))
          scan(block, /[\u201c\u201d\u2018\u2019]/g, "curly-quote", input.context.language === "en" ? "error" : "warning", "英文使用直引号，混合语境需核对引号归属。");
        break;
      case "english-terms":
        for (const term of rule.terms) {
          const word = escapeRegex(term.value);
          const stem = term.value.endsWith("e") ? escapeRegex(term.value.slice(0, -1)) : word;
          scan(block, new RegExp("\\b(?:" + word + "(?:s|es|ed|ing)?|" + stem + "(?:ing|ed))\\b", "gi"),
            term.conditional ? "conditional-word-en" : "banned-word-en",
            term.conditional ? "warning" : "error",
            term.conditional ? "本词仅在特定词性或含义下禁用，保留正常用法并人工核对。" : "匹配项目禁词，请按原意局部修正。");
        }
        break;
      case "chinese-terms":
      case "editorial-slots":
      case "fillers":
      case "adverbs":
      case "defensive":
        for (const term of rule.terms) {
          const english = /^[A-Za-z ]+$/.test(term.value);
          const pattern = english ? "\\b" + escapeRegex(term.value).replaceAll(" ", "\\s+") + "\\b" : escapeRegex(term.value);
          const code = { "chinese-terms": "banned-word-zh", "editorial-slots": "vague-editorial-slot-zh",
            fillers: "filler-phrase", adverbs: "ornamental-adverb", defensive: "defensive-non-claim" }[rule.check];
          scan(block, new RegExp(pattern, english ? "gi" : "g"), code,
            rule.check === "adverbs" || rule.check === "defensive" ? "warning" : "error",
            rule.check === "editorial-slots" ? term.value + ": 批注应指向对应来源的具体细节。" :
              rule.manualRequired ? "检查本处是否空泛或承担真实限定，不能只删除词语。" : "按规范处理本处表达并保护相邻逻辑。");
        }
        break;
      case "contrast":
        scan(block, /\bnot\b[^.!?;\n]{0,100}\bbut\b/gi, "not-x-but-y", "error", "直接表达实际主张。");
        scan(block, /不是[^。！？\n]{0,100}?而是/g, "not-x-but-y-zh", "error", "直接表达实际主张。");
        break;
      case "rhythm-length":
      case "rhythm-opening": {
        if (block.kind !== "body") break;
        const parts = sentences(block.text, input.context.language);
        if (rule.check === "rhythm-length") {
          const sizes = parts.map((s) => input.context.language === "en" ? countText(s).englishWords : countText(s).nonWhitespaceCodepoints);
          if (sizes.length === 1 || (sizes.length > 1 && Math.max(...sizes) === Math.min(...sizes)))
            emit(block, "uniform-rhythm", "warning", "段内节奏需要人工核对，单句段落或刻意节奏不能自动改写。");
        } else {
          const openings = parts.map((s) => s.match(/^[A-Za-z]+/)?.[0]?.toLowerCase() ?? s.slice(0, 2));
          if (openings.some((s, i) => i >= 2 && s === openings[i - 1] && s === openings[i - 2]))
            emit(block, "repetitive-openings", "warning", "连续句首相同，请结合主语和结构核对。");
        }
        break;
      }
      case "narrative-ending": break;
    }
  }
  if (rule.check === "narrative-ending") {
    const endingIds = new Set(input.document.blocks.filter((b) => b.kind === "body" &&
      (b.role ?? input.context.authorRole) === "student").slice(-2).map((b) => b.id));
    const ending = blocks.filter((b) => endingIds.has(b.id));
    for (const block of ending) {
      scan(block, /\b(?:result|success|growth|change|lesson|leadership)\b[^.!?]{0,140}:\s*[a-z]+ing\b[^.!?]{0,100},\s*[a-z]+ing\b[^.!?]{0,100},?\s+and\s+[a-z]+ing\b/gi,
        "ending-summary-inventory", "error", "叙事结尾出现三项同类行动清点，请对照正文核对收束。");
    }
    const all = ending.map((b) => b.text).join(" ");
    if (ending[0] && sentences(all, "en").filter((s) => /^I\s/.test(s)).length >= 2 &&
      /\b(?:now|before every|those steps|these steps|I learned|I realized)\b/i.test(all))
      emit(ending[0], "parallel-self-summary-ending", "warning", "最后两段连续自我说明，需核对是否重复正文或增加了具体理解。");
  }
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&");
}
