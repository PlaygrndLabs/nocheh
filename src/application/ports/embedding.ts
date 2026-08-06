import type { AiTokenUsage } from "../../domain/observability/audit.js";

/**
 * Why a text is being embedded.
 *
 * Retrieval embedding models are often asymmetric: the same sentence produces a
 * different vector depending on whether it is the question or the thing being searched.
 * NVIDIA's nv-embedqa family requires an explicit `input_type` and Gemini takes a
 * `taskType`, so the distinction belongs in the port rather than in each adapter's
 * assumptions. A symmetric model can ignore it.
 */
export type EmbeddingKind = "query" | "document";

export interface EmbeddingRequest {
  /** Embedded in one call: a batch costs far less than one request per text. */
  readonly texts: readonly string[];
  readonly kind: EmbeddingKind;
}

export interface EmbeddingResult {
  /** Model that produced the vectors. Stored per record so a model change is detectable. */
  readonly model: string;
  /** One vector per input text, in the same order. */
  readonly vectors: readonly (readonly number[])[];
  readonly tokenUsage?: AiTokenUsage;
}

/**
 * Turns text into vectors for associative recall.
 *
 * Absent when no embedding provider is configured, in which case retrieval degrades to
 * word overlap rather than failing — roles degrade independently (ADR-0010).
 */
export interface EmbeddingPort {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}
