import { z } from 'zod';
import { hashValue } from '@mantou/text-quality';
import { loadSession } from './sessions.js';
import { fail } from './files.js';

export const HUMANIER_METHOD_VERSION = '1.4.0' as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewNoteSchema = z.string().trim().min(1).max(4000);
export const reviewSpanSchema = z.object({ blockId:z.string().min(1), start:z.number().int().nonnegative(),
  end:z.number().int().positive(), quote:z.string().min(1) }).strict();
export const reviewBindingsSchema = z.object({ sessionHash:digest, versionHash:digest, originalHash:digest,
  documentHash:digest, contextHash:digest, policyHash:digest }).strict();
const note = reviewNoteSchema;
const spanSchema = reviewSpanSchema;
export const sourceReviewSchema = z.object({ schemaVersion:z.literal('1.0.0'), methodVersion:z.literal(HUMANIER_METHOD_VERSION),
  bindings:reviewBindingsSchema, reviewerRole:z.literal('agent'), passages:z.array(z.object({
    candidate:spanSchema, sources:z.array(spanSchema).min(1).max(100),
    changeKind:z.enum(['grammar','expression','meaning','addition']),
    semanticStatus:z.enum(['preserved','unresolved']), semanticNote:note,
    voiceStatus:z.enum(['preserved','unresolved']), voiceNote:note,
    function:z.enum(['event','judgment','context','connection']), relevanceStatus:z.enum(['relevant','unresolved','padding']), relevanceNote:note,
    verdict:z.enum(['retain','rework'])
  }).strict()).max(2000), omissions:z.array(z.object({source:spanSchema,reason:note}).strict()).max(2000),
  wholeDocument:z.object({verdict:z.enum(['retain','rework']), standaloneReason:note,
    interchangeabilityReason:note, endingReason:note}).strict()
}).strict();
export type ReviewSpan = z.infer<typeof reviewSpanSchema>;
type Span = ReviewSpan;
type Session = Awaited<ReturnType<typeof loadSession>>;
export function reviewBindings(s:Session) { return {sessionHash:s.manifest.sessionHash,versionHash:s.current.versionHash,
  originalHash:hashValue(s.original),documentHash:hashValue(s.document),
  contextHash:hashValue(s.manifest.context),policyHash:hashValue(s.policy)}; }
export function fullReviewSpan(block:{id:string;text:string}) {return {blockId:block.id,start:0,end:Array.from(block.text).length,quote:block.text};}
export function validateReviewSpan(span:ReviewSpan,blocks:Session['document']['blocks'],code:string){
  const block=blocks.find(b=>b.id===span.blockId);
  if(!block)fail(code,'Use a block from the bound document.');
  const text=Array.from(block.text);
  if(span.end<=span.start||span.end>text.length||text.slice(span.start,span.end).join('')!==span.quote)
    fail(code,'Use exact, nonempty codepoint spans and quotes from the bound document.');
  return text;
}

export async function prepareSourceReview(policyRoot:string,path:string) {
  const s=await loadSession(policyRoot,path);
  return {schemaVersion:'1.0.0',methodVersion:HUMANIER_METHOD_VERSION,bindings:reviewBindings(s),
    instructions:[
      'Read the current prepare and original before reviewing. This template is incomplete and must be saved outside the immutable version folders.',
      'Split candidate spans by sentence or inseparable adjacent meaning. Cover every non-whitespace codepoint once. Use codepoint offsets, not UTF-16 offsets.',
      'Quote exact source spans. Account for every non-whitespace original codepoint through a source reference or an omission with a reason.',
      'Compare judgment strength, emotion, uncertainty and causal meaning. Explain what each passage adds for this prompt, even when the fact is sourced.',
      'Keep useful plain language. Do not add imagery, dialogue, psychology, mature qualifications or unusual grammar just to change a detector label.',
      'Read the candidate independently and record interchangeable paragraphs and the ending. Explicit meaning/addition or unresolved judgments need rework.',
      'These are Agent opinions. A recorded result validates bindings and coverage only, never semantic equivalence, voice, a detector score or submission approval.'
    ],
    original:s.original,
    template:{schemaVersion:'1.0.0',methodVersion:HUMANIER_METHOD_VERSION,bindings:reviewBindings(s),reviewerRole:'agent',
      passages:s.document.blocks.filter(b=>b.text.trim()).map(b=>({candidate:fullReviewSpan(b),sources:[],changeKind:'expression',
        semanticStatus:'unresolved',semanticNote:'',voiceStatus:'unresolved',voiceNote:'',function:'event',relevanceStatus:'unresolved',relevanceNote:'',verdict:'rework'})),
      omissions:[],wholeDocument:{verdict:'rework',standaloneReason:'',interchangeabilityReason:'',endingReason:''}},
    containsDocumentText:true,requiresHumanReview:true,deliveryAuthorized:false};
}

export async function reviewSource(policyRoot:string,path:string,raw:unknown) {
  const s=await loadSession(policyRoot,path);const record=sourceReviewSchema.parse(raw);
  if(hashValue(record.bindings)!==hashValue(reviewBindings(s)))fail('source-review-stale','Prepare a source review for the current original, version, context and policy.');
  const candidateCoverage=new Map(s.document.blocks.map(b=>[b.id,new Uint8Array(Array.from(b.text).length)]));
  const sourceCoverage=new Map(s.original.blocks.map(b=>[b.id,new Uint8Array(Array.from(b.text).length)]));
  function cover(span:Span,blocks:Session['document']['blocks'],coverage:Map<string,Uint8Array>,unique:boolean){
    validateReviewSpan(span,blocks,'source-review-span');const marks=coverage.get(span.blockId)!;
    for(let i=span.start;i<span.end;i++){
      if(unique&&marks[i])fail('source-review-overlap','Candidate passages must not overlap.');
      marks[i]=1;
    }
  }
  for(const passage of record.passages){
    cover(passage.candidate,s.document.blocks,candidateCoverage,true);
    for(const span of passage.sources)cover(span,s.original.blocks,sourceCoverage,false);
  }
  for(const omission of record.omissions)cover(omission.source,s.original.blocks,sourceCoverage,false);
  for(const [blocks,coverage] of [[s.document.blocks,candidateCoverage],[s.original.blocks,sourceCoverage]] as const)
    for(const block of blocks)if(Array.from(block.text).some((c,i)=>/\S/u.test(c)&&!coverage.get(block.id)?.[i]))
      fail('source-review-incomplete','Cover all candidate text and account for all original content.');
  const reworkPassages=record.passages.flatMap((p,i)=>p.verdict==='rework'||p.semanticStatus==='unresolved'||p.voiceStatus==='unresolved'||p.relevanceStatus!=='relevant'||
    p.changeKind==='meaning'||p.changeKind==='addition'?[i+1]:[]);
  return {schemaVersion:'1.0.0',methodVersion:HUMANIER_METHOD_VERSION,bindings:reviewBindings(s),recordHash:hashValue(record),
    reviewDecision:reworkPassages.length||record.wholeDocument.verdict==='rework'?'needs-rework':'recorded',
    passageCount:record.passages.length,omissionCount:record.omissions.length,reworkPassages,
    wholeDocumentNeedsRework:record.wholeDocument.verdict==='rework',coverageVerified:true,
    reviewerRole:'agent',containsDocumentText:false,requiresHumanReview:true,semanticEquivalenceChecked:false,
    voiceCertified:false,deliveryAuthorized:false};
}
