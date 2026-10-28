import { hashValue, type Policy } from '@mantou/text-quality';

/** Stable display units. A unit can contain several obligations; this is not a semantic parser. */
export function requirementUnits(requirement: string): string[] {
  return requirement.split(/(?<=。)\s*|\n+/u).map(part => part.trim()).filter(Boolean);
}

export function portableRequirement(requirement: string): string {
  return requirement.replaceAll('文书修改先读故事手册', '文书修改先执行本文件的故事要求')
    .replaceAll('完整定义只在语言规范维护', '完整定义按本文件对应规则执行');
}

export function writingRuleCards(policy: Policy, applicable: Set<string>) {
  return policy.rules.filter(rule => applicable.has(rule.id)).flatMap(rule =>
    requirementUnits(portableRequirement(rule.requirement)).map((requirement, index) => ({
      checkId: `${rule.id}.${String(index + 1).padStart(2, '0')}`, ruleId: rule.id,
      requirement, requirementHash: hashValue({ rule, index, requirement }), scope: rule.scope,
      terms: rule.terms, automaticCheck: rule.check, manualRequired: rule.manualRequired,
      phase: /^[MR]/u.test(rule.id) ? 'syntax' : /^[LVNE]/u.test(rule.id) ? 'content' : 'process',
      failureAction: 'repair-or-record-unverified',
      atomicCoverageCertified: false
    })));
}
