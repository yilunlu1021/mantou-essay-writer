import { z } from 'zod';

export const FEEDBACK_TAXONOMY_VERSION = '1.0.0' as const;
export const FEEDBACK_CATEGORY_IDS = [
  'reference-recoverability', 'narrative-viewpoint', 'predicate-focus', 'clause-attachment',
  'discourse-linking', 'register-fit', 'cadence-pattern', 'information-gain', 'evidence-scope'
] as const;
export const feedbackCategoryIdSchema = z.enum(FEEDBACK_CATEGORY_IDS);
export type FeedbackCategoryId = z.infer<typeof feedbackCategoryIdSchema>;
export const feedbackClassificationSchema = z.object({
  taxonomyVersion: z.literal(FEEDBACK_TAXONOMY_VERSION),
  categories: z.array(z.object({ categoryId: feedbackCategoryIdSchema,
    relation: z.enum(['review-domain', 'supported-issue', 'retention-case', 'unresolved'])
  }).strict()).min(1).max(FEEDBACK_CATEGORY_IDS.length),
  sourceTags: z.array(z.string().min(1).max(4000)).max(100),
  explanationAssessment: z.enum(['not-reviewed', 'plausible', 'unsupported', 'misdescribed', 'unassessable'])
}).strict().superRefine((value, ctx) => {
  if (new Set(value.categories.map(item => item.categoryId)).size !== value.categories.length)
    ctx.addIssue({ code: 'custom', path: ['categories'], message: 'Classify each category once.' });
  if (new Set(value.sourceTags).size !== value.sourceTags.length)
    ctx.addIssue({ code: 'custom', path: ['sourceTags'], message: 'Reference each source tag once.' });
});

const category = (id: FeedbackCategoryId, dimension: 'diction' | 'stance' | 'main-clause' | 'attachments' |
  'logic' | 'cadence' | 'information', definition: string, reviewQuestions: string[], retainCounterexamples: string[]) =>
  ({ id, dimension, definition, reviewQuestions, retainCounterexamples });
const categories = [
  category('reference-recoverability', 'diction',
    'Whether a reader can identify a noun phrase or recover a pronoun referent from the supplied discourse.',
    ['Is the object identifiable at this point in the text?', 'Would a more specific noun preserve the available facts?'],
    ['An indefinite article can introduce a specific new object.', 'A definite article does not establish a missing referent.']),
  category('narrative-viewpoint', 'stance',
    'Whose perception, knowledge or evaluation a statement expresses, including access to another person\'s thoughts.',
    ['Could the author know or observe this statement?', 'Does the evaluation come from the author or an editor looking back?'],
    ['Another person can perform an observed action in a first-person narrative.', 'An I subject alone does not establish the source of an evaluation.']),
  category('predicate-focus', 'main-clause',
    'How the main predicate locates the action or judgment and whether framing postpones useful information.',
    ['What does the main clause actually tell the reader?', 'Does an intention or ability frame supply a necessary motive?'],
    ['An explicit intention can explain a later choice.', 'A short direct statement can advance the action without elaboration.']),
  category('clause-attachment', 'attachments',
    'The attachment and contribution of subordinate, relative and supplementary material.',
    ['Which expression does this clause modify?', 'Would removing the clause lose a fact, relationship or necessary qualification?'],
    ['A relative clause may identify the exact object.', 'A temporal clause may preserve the sequence of the experience.']),
  category('discourse-linking', 'logic',
    'Whether temporal, causal and contrastive links express the relationship supported by the available account.',
    ['Does a connector clarify a real relation or merely join activity names?', 'Has temporal sequence been mistaken for cause?'],
    ['Before, after and while can communicate essential chronology.', 'A causal connector is useful when the cause is supported.']),
  category('register-fit', 'diction',
    'Whether vocabulary, collocation and technical explanation fit the author, audience and actual task.',
    ['Does the term name the operation accurately?', 'How much explanation does the reader need to follow this experience?'],
    ['A real technical term may be the most accurate wording.', 'Necessary terminology can repeat without synonym substitution.']),
  category('cadence-pattern', 'cadence',
    'The effect of neighboring sentence structures, emphasis and information weight during continuous reading.',
    ['Does repetition obscure a distinct action or make the reading mechanical?', 'Would a structural change improve this passage without losing a relationship?'],
    ['Adjacent I subjects can track a sequence of the author\'s actions.', 'Ordinary declaratives and varied sentence lengths need no quota.']),
  category('information-gain', 'information',
    'Whether a sentence or attachment adds a fact, a necessary relationship or a sourced judgment.',
    ['What becomes known after this sentence?', 'Does an explanatory tail repeat a meaning already established?'],
    ['Background can be necessary to understand the next choice.', 'A repeated term can keep the referent and technical meaning stable.']),
  category('evidence-scope', 'stance',
    'Whether certainty, generalization and attributed knowledge stay within the source evidence.',
    ['Is this the author\'s wish, an observation or an inference?', 'Does a local event justify the claimed scope of the conclusion?'],
    ['A sourced personal judgment can be stated directly.', 'A genuine uncertainty should retain an appropriate qualification.'])
];

// These are review entry points, not descriptions of detector internals or verdicts on a sentence.
export const FEEDBACK_TAG_REVIEW_DOMAINS: Readonly<Record<string, readonly FeedbackCategoryId[]>> = {
  'Artificial Simplicity': ['cadence-pattern', 'information-gain'],
  'Detached Warmth': ['narrative-viewpoint', 'register-fit'],
  'Formulaic Flow': ['discourse-linking', 'cadence-pattern'],
  'Formulaic Transitions': ['discourse-linking', 'cadence-pattern'],
  'Functional Word Choice': ['register-fit', 'predicate-focus'],
  'Generic First-Person': ['narrative-viewpoint', 'information-gain'],
  'Impersonal Tone': ['narrative-viewpoint', 'register-fit'],
  'Lacks Complexity': ['clause-attachment', 'cadence-pattern'],
  'Lacks Creative Grammar': ['clause-attachment', 'cadence-pattern'],
  'Lacks Creativity': ['cadence-pattern', 'information-gain'],
  'Mechanical Precision': ['register-fit', 'reference-recoverability'],
  'Mechanical Transitions': ['discourse-linking', 'cadence-pattern'],
  'Mechanical Writing': ['predicate-focus', 'cadence-pattern', 'information-gain'],
  'Monotonous Syntax': ['cadence-pattern', 'predicate-focus'],
  'Predictable Rhythm': ['cadence-pattern'],
  'Predictable Syntax': ['cadence-pattern', 'predicate-focus'],
  'Rigid Guidance': ['narrative-viewpoint', 'predicate-focus'],
  'Robotic Formality': ['register-fit', 'cadence-pattern'],
  'Sophisticated Clarity': ['register-fit', 'clause-attachment'],
  'Speculative Focus': ['evidence-scope', 'predicate-focus'],
  'Technical Jargon': ['register-fit'],
  'Utilitarian Vocabulary': ['register-fit', 'predicate-focus']
};

export function getFeedbackTaxonomy() {
  return { schemaVersion: '1.0.0' as const, taxonomyVersion: FEEDBACK_TAXONOMY_VERSION,
    categories: structuredClone(categories), sourceTagMappings: Object.entries(FEEDBACK_TAG_REVIEW_DOMAINS)
      .map(([sourceTag, categoryIds]) => ({ sourceTag, categoryIds: [...categoryIds] })),
    mappingRelation: 'review-domain' as const, classificationsAreHypotheses: true as const,
    detectorCausalityEstablished: false as const, automaticRewriting: false as const,
    containsDocumentText: false as const };
}
