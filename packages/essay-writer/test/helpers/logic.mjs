// Synthetic declarations exercise coverage; they do not establish real semantic correctness.
export function declaredLogic(prepared) {
  const r = structuredClone(prepared.template), anchors = prepared.paragraphs;
  r.reviewer = { id: 'synthetic-reader', participatedInEditing: false, independence: 'independent-reader' };
  r.centralAnswer = 'The supplied scene is described by its stated features.';
  r.requirements.forEach(q => Object.assign(q, { requirement: 'Describe the supplied scene.', status: 'answered', answerAnchors: anchors,
    reason: 'The exact source description supplies the requested scene.' }));
  r.paragraphs.forEach(p => Object.assign(p, { requirementIds: r.requirements.map(q => q.id), contribution: 'The current source feature is stated.',
    status: 'supports-answer', claimCoverageReason: 'This synthetic description asserts no additional inference.', reason: 'The source description addresses the task.' }));
  r.bridges.forEach(b => Object.assign(b, { fromPremise: 'The first scene feature is stated.', whyFollows: 'The next feature describes the same scene.',
    addedConsequence: 'The next supplied feature is distinct.', status: 'supported' }));
  for (const key of ['makesSense', 'convincing', 'answersPrompt']) r.overall[key] = { status: 'clear', reason: 'The supplied scene description is explicit.', anchors };
  r.overall.skepticalReading = 'No causal inference or claimed outcome is added in this synthetic fixture.';
  r.recommendation = 'adopt'; return r;
}
