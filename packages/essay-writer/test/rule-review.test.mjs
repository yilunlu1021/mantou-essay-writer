import test from 'node:test';
import { declaredLogic } from './helpers/logic.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { contextSchema } from '@mantou/text-quality';
import { importSession, prepareRuleReview, reviewRules, prepareWritingWorkflow, checkWritingWorkflow,
  loadSession, patchTemplate, reviseSession, prepareSourceReview, prepareAnswerReview, prepareStyleReview,
  prepareLinguisticReview, prepareDiscourseReview, prepareLogicReview } from '../dist/index.js';

const root = resolve('.');
async function fixture(t, text = 'The door was blue.', genre = 'personal-narrative') {
  const dir = await mkdtemp(join(tmpdir(), 'rule-review-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), session = join(dir, 'session'); await writeFile(input, text);
  await importSession(root, { input, out: session,
    context: contextSchema.parse({ language: 'en', genre, authorRole: 'student', audience: 'reader', prompt: 'Describe the supplied scene.' }) });
  return session;
}
// Synthetic declarations exercise the record contract, not their semantic truth or actual model behavior.
function declarations(prep) {
  const r = structuredClone(prep.template);
  const evidence = [{ kind: 'process', note: 'Synthetic contract fixture covers the complete bound document.' }];
  r.checks = r.checks.map(c => ({ ...c, status: 'PASS', reason: 'Synthetic declared review for the current bound task.', evidence,
    details: [{ requirement: c.checkId + ' contract fixture', status: 'PASS', reason: 'A declared decision is present.', evidence, authority: '' }] }));
  r.grammar.ing.forEach(i => { i.classification = 'excluded-word'; i.reason = 'Synthetic lexical classification, not certified by the program.'; });
  r.grammar.referents.forEach(i => { i.verdict = 'retain'; i.reason = 'Synthetic specific object declaration.'; });
  r.grammar.sentences.forEach(i => Object.assign(i, { mainClauseOrder: 'SVC', relativeClause: 'clear', mentalFrame: 'clear',
    clauseConnection: 'clear', unnecessaryTail: 'clear', triad: 'clear', reason: 'Synthetic sentence-level declaration.' }));
  r.grammar.sequences.forEach(i => Object.assign(i,{informationGain:'A different source feature is stated.',relation:'The next source feature continues the scene.',judgment:'necessary-continuation',reason:'Distinct source information can use the same main-clause order.'}));
  r.expression.to.forEach(i => Object.assign(i, {role:'preposition',status:'retain', informationFunction:'Synthetic relation.',sourceComparison:'The source relation remains.',reason:'Synthetic classification only.'}));
  r.expression.patterns.forEach(i => Object.assign(i,{judgment:'distinct-functions',status:'retain',reason:'Synthetic different functions.',operation:'retain'}));
  return r;
}
test('preparation covers every applicable policy unit and starts unverified', async t => {
  const session = await fixture(t), p = await prepareRuleReview(root, session);
  assert.equal(p.cards.length, p.template.checks.length); assert.ok(p.cards.length > 100);
  assert.ok(p.template.checks.every(c => c.status === 'UNVERIFIED' && !c.evidence.length));
  assert.equal(p.template.execution.model, null); assert.equal(p.inventory.sentences.length, 1);
  const r = await reviewRules(root, session, p.template);
  assert.equal(r.reviewDecision, 'needs-review'); assert.ok(r.pending.length > 0);
});
test('complete declarations record coverage while keeping certification and approval false', async t => {
  const session = await fixture(t, 'The door was blue.', 'academic'), p = await prepareRuleReview(root, session);
  const result = await reviewRules(root, session, declarations(p));
  assert.equal(result.reviewDecision, 'recorded'); assert.equal(result.coverageVerified, true);
  for (const k of ['atomicCoverageCertified', 'syntaxCertified', 'factsCertified', 'deliveryAuthorized', 'containsDocumentText']) assert.equal(result[k], false);
  assert.equal(result.requiresHumanReview, true); assert.equal(result.execution.model, null);
});
test('omission, duplication, reorder, extra checks and requirement changes cannot pass', async t => {
  const session = await fixture(t), record = declarations(await prepareRuleReview(root, session));
  for (const mutate of [r => r.checks.pop(), r => r.checks.push(r.checks[0]), r => r.checks.reverse()]) {
    const r = structuredClone(record); mutate(r); await assert.rejects(reviewRules(root, session, r), { code: 'rule-review-coverage' });
  }
  const r = structuredClone(record); r.checks[0].requirementHash = '0'.repeat(64);
  await assert.rejects(reviewRules(root, session, r), { code: 'rule-review-requirement' });
});
test('empty evidence, blank decisions, missing details and exception authority remain unverified', async t => {
  const session = await fixture(t), base = declarations(await prepareRuleReview(root, session));
  for (const mutate of [r => r.checks[0].evidence = [], r => r.checks[0].reason = '',
    r => r.checks[0].details = [], r => { r.checks[0].status = 'EXEMPT'; r.checks[0].authority = ''; },
    r => r.checks[0].details[0].evidence = []]) {
    const r = structuredClone(base); mutate(r); assert.equal((await reviewRules(root, session, r)).reviewDecision, 'needs-review');
  }
  const failed = structuredClone(base); failed.checks[0].details[0].status = 'FAIL';
  assert.equal((await reviewRules(root, session, failed)).reviewDecision, 'needs-rework');
});
test('invented spans and every stale binding are rejected; source quotes use codepoints', async t => {
  const session = await fixture(t, '😀 The door was blue.'), p = await prepareRuleReview(root, session), base = declarations(p);
  const r = structuredClone(base); r.checks[0].evidence = [{ kind: 'document', span: p.inventory.sentences[0].span }];
  assert.equal((await reviewRules(root, session, r)).reviewDecision, 'recorded');
  r.checks[0].evidence[0].span.quote = 'FORGED';
  await assert.rejects(reviewRules(root, session, r), { code: 'rule-review-span' });
  for (const key of Object.keys(base.bindings)) {
    const stale = structuredClone(base); stale.bindings[key] = '0'.repeat(64);
    await assert.rejects(reviewRules(root, session, stale), { code: 'rule-review-stale' });
  }
  const s = await loadSession(root, session);
  await reviseSession(root, session, { ...patchTemplate(s.manifest.context, s.document, s.policy), patches: [
    { blockId: 'p1', start: 15, end: 19, expectedText: 'blue', replacement: 'red', reason: 'Synthetic source correction.' }
  ] });
  await assert.rejects(reviewRules(root, session, base), { code: 'rule-review-stale' });
});
test('ing candidates include lexical suffixes, prohibited use blocks and no candidate can be omitted', async t => {
  const session = await fixture(t, 'During the morning, we discussed swimming.'), p = await prepareRuleReview(root, session);
  assert.deepEqual(p.inventory.ing.map(i => i.span.quote), ['During', 'morning', 'swimming']);
  const r = declarations(p); r.grammar.ing[2].classification = 'prohibited';
  assert.ok((await reviewRules(root, session, r)).blockers.some(b => b.code === 'ing-prohibited'));
  r.grammar.ing.pop(); await assert.rejects(reviewRules(root, session, r), { code: 'rule-review-coverage' });
});
test('progressive construction must contain the candidate and density is recomputed', async t => {
  const session = await fixture(t, 'We were swimming.'), p = await prepareRuleReview(root, session), r = declarations(p);
  r.grammar.ing[0].classification = 'past-progressive';
  r.grammar.ing[0].construction = p.inventory.sentences[0].span;
  assert.ok((await reviewRules(root, session, r)).blockers.some(b => b.code === 'ing-limit'));
  r.grammar.ing[0].construction = { blockId: 'p1', start: 0, end: 2, quote: 'We' };
  await assert.rejects(reviewRules(root, session, r), { code: 'rule-review-construction' });
});
test('some series is blocked despite retain claims, articles require individual evidence', async t => {
  const session = await fixture(t, 'Someone left a cup somewhere. A dog slept.'), p = await prepareRuleReview(root, session), r = declarations(p);
  assert.deepEqual(p.inventory.referents.map(i => i.span.quote), ['Someone', 'a', 'somewhere', 'A']);
  assert.equal((await reviewRules(root, session, r)).blockers.filter(b => b.code === 'referent-prohibited').length, 2);
  r.grammar.referents[1].reason = '';
  assert.ok((await reviewRules(root, session, r)).pending.some(i => i.code === 'referent-unverified'));
});
test('necessary adjacent SVO and basic statements can stay while nominal counts and remaining prohibitions block', async t => {
  const session = await fixture(t, 'I chose the cup.\n\nWe closed the door.'), p = await prepareRuleReview(root, session), r = declarations(p);
  r.grammar.sentences.forEach(s => s.mainClauseOrder = 'SVO');
  let result = await reviewRules(root, session, r); assert.ok(!result.blockers.some(b => b.code === 'adjacent-svo')); assert.equal(result.limits.basicStatements,null);
  r.grammar.sentences[0].nominalClauses = [p.inventory.sentences[0].span];
  r.grammar.sentences.forEach((s, i) => s.basicStatements = [p.inventory.sentences[i].span]);
  r.grammar.sentences[0].relativeClause = 'prohibited'; result = await reviewRules(root, session, r);
  for (const code of ['nominal-clause-limit', 'relativeClause-prohibited'])
    assert.ok(result.blockers.some(b => b.code === code), code);
  for (const code of ['adjacent-svo', 'basic-statement-limit', 'basic-statement-spacing']) assert.ok(!result.blockers.some(b => b.code === code));
});
test('source-supported finite cause and adjacent actions can stay; forced links, repetition and remaining bans cannot', async t => {
  const session = await fixture(t, 'I closed the door because the rain soaked the floor.\n\nI checked the latch.'), p = await prepareRuleReview(root,session), base = declarations(p);
  base.grammar.sentences.forEach((s,i) => Object.assign(s,{mainClauseOrder:'SVO',basicStatements:[p.inventory.sentences[i].span],clauseConnection:'clear'}));
  assert.equal((await reviewRules(root,session,base)).reviewDecision,'recorded');
  for(const mutate of [r=>r.grammar.sentences[0].clauseConnection='forced',r=>r.grammar.sequences[0].judgment='repetitive-template',
    ...['relativeClause','mentalFrame','unnecessaryTail','triad'].map(key=>r=>r.grammar.sentences[0][key]='prohibited')]){
    const r=structuredClone(base);mutate(r);assert.equal((await reviewRules(root,session,r)).reviewDecision,'needs-rework');
  }
  const missing=structuredClone(base);missing.grammar.sequences=[];await assert.rejects(reviewRules(root,session,missing),{code:'rule-review-coverage'});
});
test('mechanical errors cannot be hidden with a complete PASS ledger', async t => {
  const session = await fixture(t, 'The door was blue; the wall was red.', 'academic'), p = await prepareRuleReview(root, session);
  const r = await reviewRules(root, session, declarations(p));
  assert.equal(r.reviewDecision, 'needs-rework'); assert.ok(r.blockers.some(b => b.code === 'semicolon'));
});
test('workflow requires all raw reviews, rejects summaries and stale results, never authorizes delivery', async t => {
  const session = await fixture(t, 'The door was blue.', 'academic'), p = await prepareWritingWorkflow(root, session);
  const audit = await readFile(join(session, 'versions/v0000/audit.json'));
  assert.equal((await checkWritingWorkflow(root, session, p.template)).workflowStatus, 'needs-review');
  p.template.reviews.rules = declarations(p.ruleReview);
  const r = await checkWritingWorkflow(root, session, p.template);
  assert.equal(r.workflowStatus, 'needs-review'); assert.equal(r.reviews[0].state, 'recorded');
  assert.equal(r.deliveryAuthorized, false); assert.equal(r.recordsComplete, false);
  p.template.reviews.rules = await reviewRules(root, session, p.template.reviews.rules);
  await assert.rejects(checkWritingWorkflow(root, session, p.template));
  assert.deepEqual(await readFile(join(session, 'versions/v0000/audit.json')), audit);
});

test('seven actual review contracts reach human-review state; local rework cannot be overridden', async t => {
  const session = await fixture(t, 'The door was blue.', 'academic');
  const workflow = (await prepareWritingWorkflow(root, session)).template;
  workflow.reviews.rules = declarations(await prepareRuleReview(root, session));
  const source = (await prepareSourceReview(root, session)).template;
  source.passages.forEach(p => Object.assign(p, { sources: [p.candidate], changeKind: 'expression', semanticStatus: 'preserved',
    semanticNote: 'The same color and object are stated.', voiceStatus: 'preserved', voiceNote: 'The source wording is unchanged.',
    relevanceStatus: 'relevant', relevanceNote: 'The scene prompt calls for the stated door color.', verdict: 'retain' }));
  source.wholeDocument = { verdict: 'retain', standaloneReason: 'The object and color are explicit.',
    interchangeabilityReason: 'This is the exact supplied scene description.', endingReason: 'The description ends after the stated color.' };
  workflow.reviews.source = source;
  const answerPrep = await prepareAnswerReview(root, session), answer = answerPrep.template;
  const anchors = [source.passages[0].candidate];
  answer.response = { status: 'answered', promptInterpretation: 'Describe the supplied scene.', readerTakeaway: 'The door color is blue.', anchors,
    reason: 'The description addresses the supplied scene.' };
  answer.relationsReason = 'This single descriptive statement asserts no additional relationship.';
  answer.conclusionsReason = 'No inference extends beyond the supplied description.';
  answer.selection = { status: 'relevant', anchors, reason: 'The door color supplies the scene description.' };
  answer.standaloneRead = { status: 'clear', anchors, reason: 'The door and its color are explicit.', questions: [] };
  answer.recommendation = 'adopt'; workflow.reviews.answer = answer;
  const sp = await prepareStyleReview(root, session), style = sp.template;
  style.paragraphs.forEach(p => Object.assign(p, { purpose: 'Describe the door.', concreteContent: 'The supplied blue door.',
    status: 'distinct', reason: 'One description supplies one scene detail.' }));
  style.languageChecks.forEach(c => Object.assign(c, { anchors: sp.paragraphs, observation: 'The exact source description remains.',
    decision: 'retain', reason: 'No added meaning or qualification is declared.', retainCounterexample: 'A precise short scene description can be useful.' }));
  style.patternsReason = 'No repeated paragraph pattern exists in this one-sentence fixture.';
  style.voice = { status: 'unavailable', anchors: [], preserve: 'Keep the exact scene description.', avoidCopying: 'No other author is a reference.',
    reason: 'No independent voice sample was supplied.' };
  style.feedbackReason = 'No detector result was supplied.';
  style.protectedChoices.forEach(c => c.reason = 'The source description provides the scene detail.');
  style.overall = { status: 'retain', reason: 'The source description addresses the synthetic task.' };
  style.recommendation = 'adopt'; workflow.reviews.style = style;
  const lp = await prepareLinguisticReview(root, session), linguistic = lp.template;
  linguistic.decisions.forEach(c => Object.assign(c, { decision: 'retain', linguisticObservation: 'A surface candidate requires contextual review.',
    informationFunction: 'context', sourceBasis: 'editorial-hypothesis', originalAnchors: [], referents: [], perspective: 'not-applicable',
    clauseFunction: 'not-applicable', reason: 'The source object and state remain explicit.', preserveCounterexample: 'A useful plain description may remain.' }));
  linguistic.paragraphs.forEach(p => Object.assign(p, { role: 'context', status: 'retain',
    informationIncrement: 'The door color supplies the scene detail.', authorAccess: 'This is the supplied source description.' }));
  linguistic.overall = { decision: 'retain', reason: 'The fixture records current references without certifying grammar.' };
  workflow.reviews.linguistic = linguistic;
  const discourse = (await prepareDiscourseReview(root, session)).template;
  discourse.windows.forEach(w => Object.assign(w, { sentences: w.sentences.map(s => ({ ...s, informationGain: 'The door color is supplied.' })),
    readerConnection: 'One explicit scene detail is stated.', alternative: { kind: 'deletion', text: 'Delete the description.',
      informationLost: 'The scene would lose its only stated detail.', choice: 'retain', reason: 'The detail answers the prompt.' },
    decision: 'retain', reason: 'The sentence provides the sole supplied scene detail.' }));
  Object.assign(discourse.order, { alternativeOrder: [...discourse.order.currentOrder], currentOrderReason: 'There is one description.',
    alternativeOrderReason: 'One paragraph has no distinct permutation.', sourceLimit: 'No further event sequence is supplied.',
    choice: 'retain', decision: 'retain', reason: 'The single description is retained.' });
  discourse.recommendation = 'adopt'; workflow.reviews.discourse = discourse;
  workflow.reviews.logic = declaredLogic(await prepareLogicReview(root, session));
  const result = await checkWritingWorkflow(root, session, workflow);
  assert.equal(result.workflowStatus, 'ready-for-human-review'); assert.equal(result.recordsComplete, true);
  assert.equal(result.deliveryAuthorized, false); assert.equal(result.factsCertified, false);
  workflow.reviews.source.passages[0].semanticStatus = 'unresolved';
  assert.equal((await checkWritingWorkflow(root, session, workflow)).workflowStatus, 'needs-rework');
});

test('bounded findings cannot conceal mechanical errors beyond the display limit', async t => {
  const session = await fixture(t, 'navigate '.repeat(1001) + 'foster.', 'academic');
  const p = await prepareRuleReview(root, session), rules = await reviewRules(root, session, declarations(p));
  assert.equal(rules.reviewDecision, 'needs-rework'); assert.equal(rules.findingsTruncated, true);
  assert.ok(rules.mechanicalErrorsObserved > 0); assert.ok(rules.blockers.some(b => b.code === 'additional-mechanical-errors'));
  const w = (await prepareWritingWorkflow(root, session)).template;
  const result = await checkWritingWorkflow(root, session, w);
  assert.equal(result.workflowStatus, 'needs-rework'); assert.ok(result.mechanicalErrors.length > 0);
});

test('mixed-language application text keeps English inventories and excludes Chinese-only sentences', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rule-mixed-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'source.txt'), session = join(dir, 'session');
  await writeFile(input, '中文背景。 Someone was swimming.\n\nI checked the cup.');
  await importSession(root, { input, out: session, context: contextSchema.parse({ language: 'mixed', genre: 'personal-narrative',
    authorRole: 'student', audience: 'reader', prompt: 'Describe the supplied scene.' }) });
  const p = await prepareRuleReview(root, session);
  assert.equal(p.inventory.ing.length, 1); assert.equal(p.inventory.referents[0].span.quote, 'Someone');
  assert.equal(p.inventory.sentences.length, 2);
});
