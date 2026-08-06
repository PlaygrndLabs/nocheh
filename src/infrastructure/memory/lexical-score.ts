/**
 * Word-overlap scoring, shared by the lexical retrieval service and the hybrid one.
 *
 * Kept as the secondary signal rather than deleted: exact tokens are the one thing
 * embeddings blur. A project slug, a person's name, or an id matches here even when the
 * vector space puts two unrelated projects close together.
 *
 * Known limit: the split keeps only `a-z0-9`, so non-Latin text tokenises to nothing.
 * That is precisely the gap embeddings close, and the reason lexical scoring alone was
 * never enough for a multilingual owner.
 */
export function lexicalScore(queryText: string, documentText: string): number {
  return score(tokenize(queryText), tokenize(documentText));
}

export function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

/** F1 of token-set overlap: rewards covering the query without rewarding length. */
export function score(queryTokens: readonly string[], documentTokens: readonly string[]): number {
  if (queryTokens.length === 0 || documentTokens.length === 0) {
    return 0;
  }

  const document = new Set(documentTokens);
  const matches = queryTokens.filter((token) => document.has(token)).length;
  const recall = matches / queryTokens.length;
  const precision = matches / document.size;
  return recall === 0 || precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "we",
  "with",
]);
