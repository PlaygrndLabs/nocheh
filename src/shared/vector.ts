/**
 * Vector math for associative recall.
 *
 * Pure and dependency-free so both the application layer (which writes vectors) and the
 * infrastructure layer (which scores them) use one implementation. Storing normalised
 * vectors and comparing with a dot product is the whole reason no vector database is
 * involved: at one owner's corpus size this is a microsecond-scale loop.
 */

/** Scales a vector to unit length so cosine similarity is a plain dot product. */
export function normalizeVector(vector: readonly number[]): readonly number[] {
  let sumOfSquares = 0;
  for (const value of vector) {
    sumOfSquares += value * value;
  }
  if (sumOfSquares === 0) {
    return vector;
  }
  const magnitude = Math.sqrt(sumOfSquares);
  return vector.map((value) => value / magnitude);
}

/** Cosine similarity, valid because every stored vector is unit length. */
export function dotProduct(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}
