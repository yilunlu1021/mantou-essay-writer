#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { z } from 'zod';
import { contextSchema, describeContracts, validationDetails } from '@mantou/text-quality';
import { UserError, fail, json, readJson, readLimited, utf8, writeNew } from './files.js';
import { loadPolicy } from './policy.js';
import { importSession, loadSession, sessionStatus, prepareSession, auditSession, reviseSession, recoverSession, patchSchema, patchTemplate } from './sessions.js';
import { prepareSourceReview, reviewSource, sourceReviewSchema } from './source-review.js';
import { prepareAnswerReview, reviewAnswer, answerReviewSchema } from './answer-review.js';
import { prepareStyleReview, reviewStyle, styleReviewSchema, styleEvidenceSchema } from './style-review.js';
import { importFeedbackEvidence, feedbackLibraryStats, recallFeedback, recordFeedbackInterpretation, recordFeedbackTrial,
  feedbackInterpretationSchema, feedbackTrialSchema, feedbackDimensionSchema, feedbackRecallQuerySchema, categorizeFeedback, feedbackCategoryStats } from './feedback-library.js';
import { getFeedbackTaxonomy } from './feedback-taxonomy.js';
import { prepareLinguisticReview, reviewLinguistic, linguisticReviewSchema } from './linguistic-review.js';
import { prepareDiscourseReview, reviewDiscourse, discourseReviewSchema } from './discourse-review.js';
import { getEssayQualityBenchmark, prepareBenchmarkReview, reviewBenchmark, benchmarkProfileSchema, benchmarkReviewSchema } from './benchmark-review.js';
import { prepareAssessmentReview, reviewAssessment, assessmentReviewSchema } from './assessment-review.js';
import { getCommonAppBenchmark, prepareCurrentAssessmentReview, reviewCurrentAssessment, commonAppAssessmentSchema } from './common-app-assessment.js';
import { prepareLogicReview, reviewLogic, logicReviewSchema } from './logic-review.js';
import { prepareRuleReview, reviewRules, ruleReviewSchema } from './rule-review.js';
import { prepareWritingWorkflow, checkWritingWorkflow, writingWorkflowSchema } from './writing-workflow.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const VERSION='0.3.0-preview.1';
const HELP=`Mantou Essay Writer ${VERSION}
Local writing review and versioned edits. Uses your existing agent for writing.

node bin/essay.mjs doctor
node bin/essay.mjs demo --out "my demo"
node bin/essay.mjs import --input draft.docx --out "my essay" --language en --genre personal-narrative --prompt-file prompt.txt
node bin/essay.mjs prepare --session "my essay"
node bin/essay.mjs revise --session "my essay" --patch-file edits.json
node bin/essay.mjs status --session "my essay"
node bin/essay.mjs audit --session "my essay"
node bin/essay.mjs prepare-workflow --session "my essay"
node bin/essay.mjs prepare-logic-review --session "my essay"
node bin/essay.mjs review-logic --session "my essay" --review-file logic.json
node bin/essay.mjs prepare-rule-review --session "my essay"
node bin/essay.mjs review-rules --session "my essay" --review-file rules.json
node bin/essay.mjs check-workflow --session "my essay" --review-file workflow.json
node bin/essay.mjs prepare-source-review --session "my essay"
node bin/essay.mjs review-source --session "my essay" --review-file source-review.json
node bin/essay.mjs prepare-answer-review --session "my essay"
node bin/essay.mjs review-answer --session "my essay" --review-file answer-review.json
node bin/essay.mjs prepare-style-review --session "my essay" [--evidence-file evidence.json]
node bin/essay.mjs review-style --session "my essay" --review-file style-review.json [--evidence-file evidence.json]
node bin/essay.mjs feedback-import --db private/feedback.sqlite --evidence-file evidence.json [--scope local]
node bin/essay.mjs feedback-stats --db private/feedback.sqlite
node bin/essay.mjs feedback-recall --db private/feedback.sqlite [--feature-tag TEXT] [--dimension diction] [--category reference-recoverability] [--taxonomy-version 1.0.0] [--interpretation-history current|all] [--scope local] [--limit 30] [--include-text]
node bin/essay.mjs feedback-interpret --db private/feedback.sqlite --input interpretation.json
node bin/essay.mjs feedback-trial --db private/feedback.sqlite --input trial.json
node bin/essay.mjs feedback-taxonomy
node bin/essay.mjs feedback-categorize --db private/feedback.sqlite [--scope local] [--report-id ID] [--apply]
node bin/essay.mjs feedback-categories --db private/feedback.sqlite [--scope local]
node bin/essay.mjs prepare-linguistic-review --session "my essay" [--evidence-file evidence.json]
node bin/essay.mjs review-linguistic --session "my essay" --review-file linguistic.json [--evidence-file evidence.json]
node bin/essay.mjs prepare-discourse-review --session "my essay"
node bin/essay.mjs review-discourse --session "my essay" --review-file discourse.json
node bin/essay.mjs benchmark
node bin/essay.mjs prepare-assessment-review --session "my essay" --essay-type common-app --prompt-status supplied
node bin/essay.mjs review-assessment --session "my essay" --review-file assessment.json
node bin/essay.mjs recover --session "my essay"
node bin/essay.mjs schema
node bin/essay.mjs example

Import options:
  --language en|zh|mixed (required)  --genre personal-narrative|application-explanatory|academic|advisor-feedback|general|unknown (required)
  --prompt-file FILE  --audience TEXT  --role student|advisor|institution
  --mode edit|revision (default edit)  --authorize-revision (explicit structural-edit permission)
  --stage material|working|clean-draft  --channel document|wechat|chat|unknown
  --min NUMBER  --max NUMBER  --unit english-words|han-characters|non-whitespace-codepoints
  Complete drafts use at least max minus 15 counted units. A lower --min cannot widen this range.
  --protect-blocks p1,p2  --edit-budget NUMBER (default 2000 changed codepoints per revision)

UTF-8 TXT/MD (1 MB) and body-paragraph DOCX (5 MB) supported. Markdown imports as literal text.
Offsets use Unicode codepoints. Each version contains working-draft.docx, review.md and patch-template.json.
Copy the template outside the versions folder before editing it. Never edit stored session files.
Exit codes: 0 utility success, 1 invalid request/runtime failure, 2 mechanically blocked, 3 human review pending.
A completed import/revise can return 2 or 3. Check JSON and existing files before retrying.
No AI detector score or submission approval is provided. See README.md and AGENTS.md.
Source review validates exact references and coverage, not the truth of Agent judgments.
Answer review validates bound references and explicit review states. Meaning and independent reading remain unverified.
Style review validates bound references, logical paragraphs and feedback coverage. It neither authenticates evidence nor replicates a detector.
Discourse review validates every contiguous sentence window and adjacent paragraph transition. Connections and order choices remain Agent judgments.
New Common App scoring uses 20 integer items: main 95 plus one holistic extra 5, quality floor 83 and core checks. Acceptance/readiness remain separate.
benchmark is a read-only catalog. Legacy benchmark prepare/review execution remains only for historical replay and dependent adapters; it is not a second daily scoring route.
Unknown dimensions remain unrated, and the five existing reviews remain required.
Feedback libraries use local SQLite, require a Node runtime with node:sqlite, and keep unknown detection metadata unchanged. Queries omit student text unless explicitly requested.
`;
const allowed:Record<string,string[]>={
  import:['input','out','language','genre','prompt-file','audience','role','mode','authorize-revision','stage','channel','min','max','unit','protect-blocks','edit-budget'],
  prepare:['session'],audit:['session'],status:['session'],revise:['session','patch-file'],recover:['session'],
  'prepare-logic-review':['session'], 'review-logic':['session','review-file'],
  'prepare-rule-review':['session'], 'review-rules':['session','review-file'],
  'prepare-workflow':['session'], 'check-workflow':['session','review-file'],
  'prepare-source-review':['session'],'review-source':['session','review-file'],
  'prepare-answer-review':['session'],'review-answer':['session','review-file'],
  'prepare-style-review':['session','evidence-file'],'review-style':['session','review-file','evidence-file'],
  'feedback-import':['db','evidence-file','scope'],'feedback-stats':['db'],
  'feedback-recall':['db','scope','feature-tag','dimension','limit','include-text','category','taxonomy-version','interpretation-history'],
  'feedback-interpret':['db','input'],'feedback-trial':['db','input'],
  'feedback-taxonomy':[], 'feedback-categorize':['db','scope','report-id','apply'], 'feedback-categories':['db','scope'],
  'prepare-linguistic-review':['session','evidence-file'], 'review-linguistic':['session','review-file','evidence-file'],
  'prepare-discourse-review':['session'], 'review-discourse':['session','review-file'],
  benchmark:[], 'prepare-benchmark-review':['session','essay-type','prompt-status','task'], 'review-benchmark':['session','review-file'],
  'prepare-assessment-review':['session','essay-type','prompt-status','task'], 'review-assessment':['session','review-file'],
  demo:['out'],doctor:[],schema:[],example:[]
};
async function main(){
  const args=process.argv.slice(2);
  if(args.length===0||args.includes('--help')||args.includes('-h')){process.stdout.write(HELP);return;}
  if(args.length===1&&args[0]==='--version'){process.stdout.write(VERSION+'\n');return;}
  const {values,positionals}=parseArgs({args,strict:true,allowPositionals:true,options:Object.fromEntries([...new Set(Object.values(allowed).flat())].map(k=>[k,{type:['authorize-revision','include-text','apply'].includes(k)?'boolean':'string'}]))});
  const command=positionals[0];if(positionals.length!==1||!command||!allowed[command])fail('command','Use --help for available commands.');
  for(const k of Object.keys(values))if(!allowed[command].includes(k))fail('option','Option --'+k+' does not apply to '+command+'.');
  const required=(key:string)=>{const v=values[key];if(typeof v!=='string'||!v.trim())return fail('required-option','Provide --'+key+'.');return v;};
  const optional=(key:string)=>typeof values[key]==='string'?values[key] as string:undefined;
  const number=(key:string)=>{const value=optional(key);if(value===undefined)return undefined;if(!/^\d+$/.test(value)||Number(value)>200000)fail('number','--'+key+' must be an integer from 0 to 200000.');return Number(value);};
  let result:unknown;
  if(command==='schema')result={...describeContracts(),logicReview:z.toJSONSchema(logicReviewSchema),ruleReview:z.toJSONSchema(ruleReviewSchema),writingWorkflow:z.toJSONSchema(writingWorkflowSchema),patch:z.toJSONSchema(patchSchema),sourceReview:z.toJSONSchema(sourceReviewSchema),answerReview:z.toJSONSchema(answerReviewSchema),styleReview:z.toJSONSchema(styleReviewSchema),styleEvidence:z.toJSONSchema(styleEvidenceSchema),feedbackInterpretation:z.toJSONSchema(feedbackInterpretationSchema),feedbackTrial:z.toJSONSchema(feedbackTrialSchema),linguisticReview:z.toJSONSchema(linguisticReviewSchema),discourseReview:z.toJSONSchema(discourseReviewSchema),benchmarkProfile:z.toJSONSchema(benchmarkProfileSchema),benchmarkReview:z.toJSONSchema(benchmarkReviewSchema),assessmentReview:z.toJSONSchema(commonAppAssessmentSchema),historicalAssessmentReview:z.toJSONSchema(assessmentReviewSchema),sessionContext:z.toJSONSchema(contextSchema)};
  else if(command==='benchmark')result=getCommonAppBenchmark();
  else if(command==='prepare-assessment-review')result=await prepareCurrentAssessmentReview(root,required('session'),{essayType:required('essay-type'),promptStatus:required('prompt-status'),...(optional('task')?{task:required('task')}:{})});
  else if(command==='review-assessment')result=await reviewCurrentAssessment(root,required('session'),await readJson(required('review-file')));
  else if(command==='example')result={instructions:'Use the hashes from your version\'s patch-template.json. Replace one exact span, keeping every hash unchanged.',patchExample:{schemaVersion:'1.0.0',expectedDocumentHash:'FROM_TEMPLATE',expectedContextHash:'FROM_TEMPLATE',expectedPolicyHash:'FROM_TEMPLATE',patches:[{blockId:'p1',start:0,end:1,expectedText:'i',replacement:'I',reason:'Capitalize the existing first-person pronoun.'}]}};
  else if(command==='doctor'){
    const policy=await loadPolicy(root);const major=Number(process.versions.node.split('.')[0]);
    if(![22,24].includes(major))fail('node-version','Install Node.js 22 or 24 LTS, then rerun doctor.');
    result={status:'ready',version:VERSION,node:process.versions.node,platform:process.platform,arch:process.arch,policyGroups:policy.rules.length,
      dependencies:'bundled',networkRequired:false,pythonRequired:false,modelProvidedBy:'your existing agent',deliveryAuthorized:false};
  }else if(command==='feedback-import')result=await importFeedbackEvidence(required('db'),await readJson(required('evidence-file')),{...(optional('scope')?{scopeId:required('scope')}:{})});
  else if(command==='feedback-stats')result=await feedbackLibraryStats(required('db'));
  else if(command==='feedback-taxonomy')result=getFeedbackTaxonomy();
  else if(command==='feedback-categorize')result=await categorizeFeedback(required('db'),{
    ...(optional('scope')?{scopeId:required('scope')}:{}),...(optional('report-id')?{reportId:required('report-id')}:{}),apply:values.apply===true});
  else if(command==='feedback-categories')result=await feedbackCategoryStats(required('db'),{...(optional('scope')?{scopeId:required('scope')}: {})});
  else if(command==='feedback-recall')result=await recallFeedback(required('db'),feedbackRecallQuerySchema.parse({
    ...(optional('scope')?{scopeId:required('scope')}:{}),...(optional('feature-tag')?{featureTag:required('feature-tag')}:{}),
    ...(optional('dimension')?{dimension:feedbackDimensionSchema.parse(required('dimension'))}:{}),
    ...(optional('category')?{categoryId:required('category')}:{}),
    ...(optional('taxonomy-version')?{taxonomyVersion:required('taxonomy-version')}:{}),
    ...(optional('interpretation-history')?{interpretationHistory:required('interpretation-history')}:{}),
    ...(number('limit')!==undefined?{limit:number('limit')}:{}),includeText:values['include-text']===true}));
  else if(command==='feedback-interpret')result=await recordFeedbackInterpretation(required('db'),await readJson(required('input')) as Parameters<typeof recordFeedbackInterpretation>[1]);
  else if(command==='feedback-trial')result=await recordFeedbackTrial(required('db'),await readJson(required('input')) as Parameters<typeof recordFeedbackTrial>[1]);
  else if(command==='import'){
    const language=required('language'); const mode=optional('mode')??'edit';
    if(!['edit','revision'].includes(mode))fail('mode','Use --mode edit or --mode revision.');
    if(values['authorize-revision']&&mode!=='revision')fail('mode','Use --authorize-revision only with --mode revision.');
    const stage=optional('stage')??'working';const max=number('max');let min=number('min');
    const unit=optional('unit')??(language==='en'?'english-words':language==='zh'?'han-characters':'non-whitespace-codepoints');
    if(stage==='clean-draft'){
      if(max===undefined)fail('length-required','Provide the official limit using --max. Verify the prompt before choosing a limit.');
    }
    const promptFile=optional('prompt-file');const context=contextSchema.parse({language,genre:required('genre'),authorRole:optional('role')??'student',
      mode,revisionAuthorized:values['authorize-revision']===true,stage,channel:optional('channel')??'document',audience:optional('audience')??'reader',
      prompt:promptFile?utf8(await readLimited(promptFile,40000)).replace(/^\uFEFF/,''):'',
      ...((min!==undefined||max!==undefined)?{length:{unit,...(min!==undefined?{min}:{}),...(max!==undefined?{max}:{})}}:{})});
    const budget=number('edit-budget'); const protectedValue=optional('protect-blocks');
    result=await importSession(root,{input:required('input'),out:required('out'),context,
      ...(budget!==undefined?{maxChangedCodepoints:budget}:{}),...(protectedValue?{protectedBlocks:protectedValue.split(',')}: {})});
  }else if(command==='demo'){
    const out=required('out');const temp=await mkdtemp(join(tmpdir(),'essay-demo-'));
    try{
      const input=join(temp,'draft.txt');await writeNew(input,'I kept the damaged wheel; we tested it after lunch.\n\nThe cart rolled to the doorway.');
      await importSession(root,{input,out,context:contextSchema.parse({language:'en',genre:'personal-narrative',authorRole:'student',audience:'reader',prompt:'Describe a project you worked on.'})});
      const s=await loadSession(root,out);const patch={...patchTemplate(s.manifest.context,s.document,s.policy),patches:[{blockId:'p1',start:24,end:28,expectedText:'; we',replacement:'. We',reason:'Split the existing sentence without adding facts.'}]};
      await reviseSession(root,out,patch);result={demo:'completed',...await sessionStatus(root,out)};
    }finally{await rm(temp,{recursive:true,force:true});}
  }else if(command==='prepare')result=await prepareSession(root,required('session'));
  else if(command==='prepare-logic-review')result=await prepareLogicReview(root,required('session'));
  else if(command==='review-logic')result=await reviewLogic(root,required('session'),await readJson(required('review-file'),8_000_000));
  else if(command==='prepare-rule-review')result=await prepareRuleReview(root,required('session'));
  else if(command==='review-rules')result=await reviewRules(root,required('session'),await readJson(required('review-file'),8_000_000));
  else if(command==='prepare-workflow')result=await prepareWritingWorkflow(root,required('session'));
  else if(command==='check-workflow')result=await checkWritingWorkflow(root,required('session'),await readJson(required('review-file'),20_000_000));
  else if(command==='audit')result=await auditSession(root,required('session'));
  else if(command==='status')result=await sessionStatus(root,required('session'));
  else if(command==='recover')result=await recoverSession(root,required('session'));
  else if(command==='prepare-source-review')result=await prepareSourceReview(root,required('session'));
  else if(command==='review-source')result=await reviewSource(root,required('session'),await readJson(required('review-file')));
  else if(command==='prepare-answer-review')result=await prepareAnswerReview(root,required('session'));
  else if(command==='review-answer')result=await reviewAnswer(root,required('session'),await readJson(required('review-file')));
  else if(command==='prepare-discourse-review')result=await prepareDiscourseReview(root,required('session'));
  else if(command==='review-discourse')result=await reviewDiscourse(root,required('session'),await readJson(required('review-file')));
  else if(command==='prepare-benchmark-review')result=await prepareBenchmarkReview(root,required('session'),{
    essayType:required('essay-type'),promptStatus:required('prompt-status'),...(optional('task')?{task:required('task')}:{})});
  else if(command==='review-benchmark')result=await reviewBenchmark(root,required('session'),await readJson(required('review-file')));
  else if(command==='prepare-style-review')result=await prepareStyleReview(root,required('session'),optional('evidence-file')?await readJson(required('evidence-file')):undefined);
  else if(command==='prepare-linguistic-review')result=await prepareLinguisticReview(root,required('session'),optional('evidence-file')?styleEvidenceSchema.parse(await readJson(required('evidence-file'))):undefined);
  else if(command==='review-linguistic')result=await reviewLinguistic(root,required('session'),await readJson(required('review-file')),optional('evidence-file')?styleEvidenceSchema.parse(await readJson(required('evidence-file'))):undefined);
  else if(command==='review-style')result=await reviewStyle(root,required('session'),await readJson(required('review-file')),optional('evidence-file')?await readJson(required('evidence-file')):undefined);
  else result=await reviseSession(root,required('session'),await readJson(required('patch-file')));
  process.stdout.write(json(result));
  if(command!=='demo'&&result&&typeof result==='object'&&'qualityDecision' in result){process.exitCode=result.qualityDecision==='blocked'?2:result.qualityDecision==='needs-review'?3:0;}
  if(result&&typeof result==='object'&&('reviewDecision' in result||'editorialStatus' in result))process.exitCode=3;
  if(result&&typeof result==='object'&&'workflowStatus' in result)process.exitCode=result.workflowStatus==='needs-rework'?2:3;
}
main().catch((error:unknown)=>{
  const fields=validationDetails(error); const e=error as NodeJS.ErrnoException;
  const hint=error instanceof UserError?error.hint:fields.length?'Correct the listed fields.':e.code==='ENOENT'?'A required file or directory was not found. Check the supplied path.':e.code==='EACCES'||e.code==='EPERM'?'Use a writable local folder and check file permissions.':error instanceof SyntaxError?'Provide valid UTF-8 JSON.':'Use --help and check your options and input files.';
  process.stderr.write(json({error:error instanceof UserError?error.code:fields.length?'invalid-request':e.code??'invalid-request',hint,...(fields.length?{fields}:{})}));process.exitCode=1;
});
