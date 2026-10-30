import { z } from 'zod';
import { reviewNoteSchema, reviewSpanSchema, type ReviewSpan } from './source-review.js';

export const compressionCheckSchema = z.object({
  alternative: reviewNoteSchema,
  complementRole: z.enum(['requested-answer', 'procedure-reasoning', 'retrospective-appraisal', 'generic-lesson', 'unresolved']),
  informationLost: reviewNoteSchema, contextReason: reviewNoteSchema,
  choice: z.enum(['retain-current', 'prefer-alternative', 'delete', 'unresolved']), reason: reviewNoteSchema,
  referenceStatus: z.enum(['compared', 'unavailable']),
  references: z.array(z.object({ referenceId: z.string().min(1), span: reviewSpanSchema,
    relation: z.enum(['supports-shorter', 'necessary-clause', 'different-register']), reason: reviewNoteSchema
  }).strict()).max(100), referenceReason: reviewNoteSchema
}).strict().superRefine((value, ctx) => {
  if ((value.referenceStatus === 'compared') !== (value.references.length > 0))
    ctx.addIssue({ code: 'custom', path: ['references'],
      message: 'A compared reference needs an exact span; unavailable references must remain empty.' });
});

export type ConstructionComponent = { feature: string; span: ReviewSpan };
export type ConstructionCue = {
  code: 'appraisal-wh-expansion' | 'appraisal-nominal-expansion' | 'generic-lesson-expansion';
  requiresCompressionCheck: true; components: ConstructionComponent[]; featureLabels: string[];
  observedCue: string; reviewQuestion: string; retainCounterexample: string;
};
type Token = { word: string; start: number; end: number };
const appraisal = /^(?:understand|understands|understood|realize|realizes|realized|realise|realises|realised|recognize|recognizes|recognized|recognise|recognises|recognised|discover|discovers|discovered|notice|notices|noticed|learn|learns|learned|learnt|see|sees|saw|seen|appreciate|appreciates|appreciated|(?:under|over)estimat(?:e|es|ed|ing))$/u;
const wh = /^(?:how|what|why|whether)$/u;
const value = /^(?:worth|worthwhile|benefit|benefits|valuable|meaningful|rewarding)$/u;
const supportVerb = /^(?:take|takes|took|taken|need|needs|needed|require|requires|required)$/u;
const wrapper = /^(?:level|amount|degree|extent|measure|quantity|scale|depth)$/u;
const abstract = /^(?:effort|work|care|patience|commitment|benefit|benefits|value|understanding|complexity|difficulty|importance|support|growth|cooperation|impact|learning)$/u;
const generic = /^(?:always|never|everyone|everybody|everything|anyone|anything|all|every|each)$/u;
const modal = /^(?:can|could|will|would|may|might|must|should)$/u;
const adjunct = /^(?:just|exactly|fully|really|only|finally|simply|better)$/u;

// Bounded token combinations expose a review question; they do not establish a dependency parse or an error.
export function locateConstructionCues(anchor: ReviewSpan): ConstructionCue[] {
  const text = anchor.quote, tokens: Token[] = Array.from(text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/gu), match =>
    ({ word: match[0].toLowerCase(), start: match.index!, end: match.index! + match[0].length }));
  const span = (start: number, end: number): ReviewSpan => ({ blockId: anchor.blockId,
    start: anchor.start + Array.from(text.slice(0, start)).length,
    end: anchor.start + Array.from(text.slice(0, end)).length, quote: text.slice(start, end) });
  const part = (feature: string, begin: number, end = begin): ConstructionComponent =>
    ({ feature, span: span(tokens[begin]!.start, tokens[end]!.end) });
  const boundary = (index: number) => index > 0 && (/[;.!?]/u.test(text.slice(tokens[index - 1]!.end, tokens[index]!.start)) ||
    (/^(?:and|but|or|yet|so)$/u.test(tokens[index]!.word) && /,/u.test(text.slice(tokens[index - 1]!.end, tokens[index]!.start))));
  function localFind(begin: number, end: number, predicate: (token: Token) => boolean) {
    for (let index = begin; index < Math.min(tokens.length, end); index++) {
      if (boundary(index)) break;
      if (predicate(tokens[index]!)) return index;
    }
    return -1;
  }
  const cues: ConstructionCue[] = [];
  function add(code: ConstructionCue['code'], components: ConstructionComponent[], description: string) {
    if (cues.some(cue => cue.code === code && cue.components[0]!.span.start === components[0]!.span.start)) return;
    cues.push({ code, requiresCompressionCheck: true, components, featureLabels: components.map(component => component.feature),
      observedCue: description,
      reviewQuestion: 'Compare a direct alternative or deletion with this construction in its paragraph. What information would be lost, and what do appropriate declared references preserve?',
      retainCounterexample: 'A requested answer, procedural explanation or substantive judgment can require a content clause. Source support and grammatical validity alone do not settle the comparison.' });
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (appraisal.test(token.word)) {
      let complement = index + 1;
      while (complement < Math.min(tokens.length, index + 4) && !boundary(complement) && adjunct.test(tokens[complement]!.word)) complement++;
      const whIndex = complement < tokens.length && !boundary(complement) && wh.test(tokens[complement]!.word) ? complement : -1;
      if (whIndex >= 0) {
        // Stop at explicit boundaries. Other attachment remains an editor judgment.
        const tailEnd = Math.min(tokens.length, whIndex + 35);
        let support: ConstructionComponent | undefined, valuation: ConstructionComponent | undefined;
        for (let next = whIndex + 1; next < tailEnd; next++) {
          const current = tokens[next]!;
          if (boundary(next)) break;
          if (value.test(current.word) && !valuation) valuation = part('value-tail', next);
          if (supportVerb.test(current.word) && !support) {
            const prior = tokens[next - 1];
            const earlier = tokens[next - 2];
            if (prior?.word === 'it' || (prior && modal.test(prior.word)))
              support = part('support-frame', earlier?.word === 'it' ? next - 2 : next - 1, next);
          }
        }
        if (support || valuation) add('appraisal-wh-expansion', [part('appraisal-predicate', index),
          part('wh-complement', whIndex), ...(support ? [support] : []), ...(valuation ? [valuation] : [])],
        'An appraisal predicate and wh-complement combine with a support frame or value tail. Compare their information with the surrounding actions.');
      }
      const nominalStart = /^(?:the|a|an)$/u.test(tokens[complement]?.word ?? '') ? complement + 1 : complement;
      if (nominalStart < tokens.length && !boundary(complement) && !boundary(nominalStart) && wrapper.test(tokens[nominalStart]!.word) &&
          tokens[nominalStart + 1]?.word === 'of' && abstract.test(tokens[nominalStart + 2]?.word ?? '') &&
          !boundary(nominalStart + 1) && !boundary(nominalStart + 2)) {
        const expansionStart = nominalStart + 3;
        const expansionEnd = Math.min(tokens.length, expansionStart + 8);
        const extension = localFind(expansionStart, expansionEnd, item => /^(?:that|which|who|it|to|needed|required|involved|necessary)$/u.test(item.word));
        if (extension >= 0) add('appraisal-nominal-expansion', [part('appraisal-predicate', index),
          part('abstract-nominal-wrapper', nominalStart, nominalStart + 2), part('postnominal-expansion', expansionStart, extension)],
        'An appraisal predicate combines with an abstract amount or level and a following expansion. A noun replacement may retain the original explanatory burden.');
      }
    }
    if (/^(?:learned|learnt|taught)$/u.test(token.word)) {
      let complement = index + 1;
      if (complement < tokens.length && !boundary(complement) && /^(?:me|us|him|her|them|you)$/u.test(tokens[complement]!.word)) complement++;
      const thatIndex = complement < tokens.length && !boundary(complement) && tokens[complement]!.word === 'that' ? complement : -1;
      if (thatIndex < 0) continue;
      const genericIndex = localFind(thatIndex + 1, thatIndex + 12, item => generic.test(item.word));
      if (genericIndex >= 0) add('generic-lesson-expansion', [part('lesson-predicate', index),
        part('lesson-complement', thatIndex), part('generic-quantifier', genericIndex)],
      'A taught or learned clause contains a broad lesson cue. Check whether the judgment adds information beyond the preceding experience.');
    }
  }
  return cues;
}
