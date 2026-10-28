import { hashValue } from '@mantou/text-quality';

export const ESSAY_ASSESSMENT_PROTOCOL_VERSION = '1.1.0' as const;
const protocol = {
  version: ESSAY_ASSESSMENT_PROTOCOL_VERSION,
  confirmedAt: '2026-10-20',
  readingFirst: 'Record the actual task, what the reader learns about the author or purpose, exact evidence, unanswered questions and the role in the available application before rating dimensions.',
  genre: 'Apply Common App, Why Major, Why School or the actual supplemental task. Ordinary experience, direct pride, useful plain language and unresolved questions can receive the highest level.',
  detail: 'Details earn their place by explaining motives, choices, limits, viewpoints or consequences. Do not require a technical obstacle, extra action, commercial success, broad impact or a finished growth arc.',
  taskValue: 'Explain what this text adds for its actual application task. For Common App, identify a specific, meaningful understanding of the person beyond an activity description or a generic quality label. One ordinary experience can be sufficient. Neither small scale nor multiple activities determines the grade.',
  evidenceLimits: 'Distinguish an observed choice in this episode from a stable trait or wider contribution. State what the cited evidence supports and what would require inference. A plausible trait signal is not by itself proof that the personal task is fully completed.',
  presentationVsContent: 'Separate engaging narration, a coherent arc and editor-added wit from the personal substance the text establishes. Explain the origin or uncertainty of edited observations. Do not reward your own polishing as independent proof of the applicant qualities.',
  highestLevel: 'For every level 4, explicitly compare with level 3 using the actual dimension anchors. Explain why its task is fully supported, address counterevidence or limits, and avoid treating the presence of a scene, conflict and change as a full-mark checklist. A remaining optional improvement need not prevent level 4.',
  issueAttribution: 'Give each issue one primary dimension. Additional dimension effects need distinct explanations. Optional enhancements are not automatically material failures.',
  separateStates: 'Keep quality, source and authorship, detector evidence, advisor acceptance and submission readiness separate. A score or school tier never authorizes submission.',
  target: 'An advisor sets a documented revision target for this application and student context. Meet that target and explicit human acceptance before freezing content. Retain known limitations instead of pursuing endless polish.',
  history: 'The numeric rubric, profile weights and arithmetic are unchanged. Preserve historical scores and their bindings. This protocol checks declared reasoning and coverage, not its correctness, human judgment, authorship or admissions outcomes. Consistent ratings require continued independent calibration.'
} as const;

export function getEssayAssessmentProtocol() {
  return { protocolVersion: ESSAY_ASSESSMENT_PROTOCOL_VERSION,
    protocolHash: hashValue(protocol), protocol: structuredClone(protocol) };
}
