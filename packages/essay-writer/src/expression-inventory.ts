import type { TextDocument } from '@mantou/text-quality';
import type { ReviewSpan } from './source-review.js';

/** Surface locations for contextual review. No item is a POS parse or an error verdict. */
export function expressionInventory(document: TextDocument) {
  const sentenceRows: { id: string; span: ReviewSpan }[] = [];
  const to: { id: string; span: ReviewSpan; sentence: ReviewSpan }[] = [];
  for (const block of document.blocks.filter(block => block.kind === 'body')) {
    for (const part of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(block.text)) {
      const quote = part.segment.trim(); if (!quote || !/[A-Za-z]/u.test(quote)) continue;
      const begin = part.index + part.segment.indexOf(quote);
      const start = Array.from(block.text.slice(0, begin)).length;
      const sentence: ReviewSpan = { blockId: block.id, start, end: start + Array.from(quote).length, quote };
      sentenceRows.push({ id: `es${sentenceRows.length + 1}`, span: sentence });
      for (const hit of quote.matchAll(/\bto\b/giu)) {
        const offset = Array.from(quote.slice(0, hit.index)).length;
        to.push({ id: `to${to.length + 1}`, span: { blockId: block.id, start: start + offset, end: start + offset + 2, quote: hit[0] }, sentence });
      }
    }
  }
  const families = [
    { id: 'enabling-shell', description: 'Repeated allow/let/help/give/offer frames may postpone the actual action.',
      pattern: /\b(?:allow(?:s|ed)?|enable(?:s|d)?|lets?|help(?:s|ed)?|gives?|gave|given|offer(?:s|ed)?|provide(?:s|d)?)\b/giu },
    { id: 'opportunity-shell', description: 'Repeated opportunity/chance/room/permission frames need distinct information functions.',
      pattern: /\b(?:opportunit(?:y|ies)|chance|room|permission|prospect|goal)\b/giu },
    { id: 'predicate-to-shell', description: 'Repeated goal/attempt/need plus to may replace direct source actions.',
      pattern: /\b(?:need(?:s|ed)?|learn(?:s|ed)?|tr(?:y|ies|ied)|seek(?:s)?|sought|plan(?:s|ned)?|hope(?:s|d)?|aim(?:s|ed)?|struggle(?:s|d)?|agree(?:s|d)?)\s+to\b/giu },
    { id: 'purpose-opening', description: 'Repeated To openings require comparison of the actual relation and sentence focus.', pattern: /^To\b/gu }
  ];
  const patterns = families.flatMap(family => {
    const occurrences = sentenceRows.flatMap(row => {
      const matches = [...row.span.quote.matchAll(family.pattern)];
      return matches.length ? [{ sentenceId: row.id, anchor: row.span, hits: matches.length }] : [];
    });
    return occurrences.length < 2 ? [] : [{ id: family.id, description: family.description, occurrences,
      candidateOnly: true, numericLimit: null }];
  });
  return { to, patterns, metrics: { toWords: to.length, sentencesWithTo: sentenceRows.filter(row => /\bto\b/iu.test(row.span.quote)).length,
    sentences: sentenceRows.length }, classificationCertified: false, numericLimit: null };
}
