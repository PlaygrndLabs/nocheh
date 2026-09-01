import type { RedactionPolicyProvider } from "../../application/ports/redaction-policy-provider.js";
import type { SecretDetectorPort } from "../../application/ports/secret-detector.js";
import type { TextCompletionPort } from "../../application/ports/text-completion.js";
import type { LoggerPort } from "../../application/ports/logger.js";
import {
  renderPlaceholder,
  REDACTION_CATEGORIES,
  type RedactionPolicy,
} from "../../domain/security/redaction-policy.js";
import type { RedactedContent, SensitiveFindingKind } from "../../domain/security/redaction.js";
import { redactLiterals, type LiteralSecretMatch } from "./redaction-engine.js";

/**
 * Raised when the guard model cannot be reached or its answer cannot be trusted.
 *
 * Callers must treat this as a hard stop for anything that would send text onward:
 * the point of the guard is that unguarded text never reaches the analysis model.
 */
export class SecretGuardUnavailableError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SecretGuardUnavailableError";
  }
}

export interface LlmSecretDetectorConfig {
  /** Hard cap on characters sent per call, so one huge window cannot blow the budget. */
  readonly maxInputCharacters?: number;
  readonly maxOutputTokens?: number;
}

const DEFAULT_MAX_INPUT_CHARACTERS = 24_000;
/**
 * Generous relative to the visible answer.
 *
 * The JSON the guard returns is tiny, but small reasoning models spend several
 * hundred hidden tokens before emitting it: a four-segment window measured ~510
 * output tokens for ~60 tokens of JSON. A 1024 ceiling sat close enough to that to
 * truncate intermittently, and a truncated guard means a stalled window.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

interface GuardFinding {
  readonly kind: string;
  readonly value: string;
}

/**
 * Model-backed secret detector.
 *
 * The model only *identifies* secrets, returning the exact literal substrings it
 * found. Masking happens locally in {@link redactLiterals}. The model never returns
 * rewritten text, because a model asked to rewrite will also quietly alter wording,
 * and there would be no way to tell an edit from a redaction.
 *
 * A whole window is inspected in one call, so cost is per window rather than per
 * field. Failures raise {@link SecretGuardUnavailableError} rather than returning
 * unredacted text.
 */
export class LlmSecretDetector implements SecretDetectorPort {
  private readonly maxInputCharacters: number;
  private readonly maxOutputTokens: number;

  public constructor(
    private readonly completion: TextCompletionPort,
    private readonly policyProvider: RedactionPolicyProvider,
    private readonly logger: LoggerPort,
    config: LlmSecretDetectorConfig = {},
  ) {
    this.maxInputCharacters = config.maxInputCharacters ?? DEFAULT_MAX_INPUT_CHARACTERS;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  public async redact(text: string): Promise<RedactedContent> {
    const results = await this.redactMany([text]);
    return results[0] ?? { text, findings: [] };
  }

  public async redactMany(texts: readonly string[]): Promise<readonly RedactedContent[]> {
    if (texts.length === 0) {
      return [];
    }

    const policy = this.policyProvider.currentRedactionPolicy();
    const enabledKinds = REDACTION_CATEGORIES.filter((kind) => policy.categories[kind]);
    if (enabledKinds.length === 0) {
      // Every category is disabled, so there is nothing to look for and no reason to pay.
      return texts.map((text) => ({ text, findings: [] }));
    }

    const payload = JSON.stringify(texts.map((text, index) => ({ id: index, text: truncate(text, this.maxInputCharacters) })));
    let response: string;
    try {
      const result = await this.completion.complete({
        system: guardSystemPrompt(enabledKinds),
        user: payload,
        maxTokens: this.maxOutputTokens,
        jsonOutput: true,
      });
      response = result.text;
    } catch (error) {
      throw new SecretGuardUnavailableError(
        `Secret guard model call failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const findings = this.parseFindings(response, texts.length);
    return texts.map((text, index) => {
      const matches = findings.get(index) ?? [];
      if (matches.length === 0) {
        return { text, findings: [] };
      }
      return redactLiterals(text, matches, (kind) => renderPlaceholder(policy.placeholder, kind));
    });
  }

  /**
   * Parses the guard contract into per-segment literals.
   *
   * A malformed answer is a guard failure, not an empty result: silently treating
   * unparseable output as "no secrets found" would turn every model hiccup into a
   * leak.
   */
  private parseFindings(response: string, segmentCount: number): Map<number, LiteralSecretMatch[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(response.trim()));
    } catch (error) {
      parsed = extractSegmentsJsonObject(response);
      if (parsed === undefined) {
        throw new SecretGuardUnavailableError("Secret guard model returned output that is not JSON.", { cause: error });
      }
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new SecretGuardUnavailableError("Secret guard model returned a non-object response.");
    }

    const segments = (parsed as { readonly segments?: unknown }).segments;
    if (!Array.isArray(segments)) {
      throw new SecretGuardUnavailableError("Secret guard model response is missing a segments array.");
    }

    const byIndex = new Map<number, LiteralSecretMatch[]>();
    for (const segment of segments) {
      if (typeof segment !== "object" || segment === null) {
        continue;
      }
      const record = segment as { readonly id?: unknown; readonly findings?: unknown };
      const id = typeof record.id === "number" ? record.id : Number.NaN;
      if (!Number.isInteger(id) || id < 0 || id >= segmentCount) {
        // An id outside the input range cannot be mapped back to a field. Ignoring it
        // is safe; the corresponding real segment simply gets no model findings.
        continue;
      }
      if (!Array.isArray(record.findings)) {
        continue;
      }

      const matches: LiteralSecretMatch[] = [];
      for (const finding of record.findings as readonly GuardFinding[]) {
        const kind = normalizeKind(finding?.kind);
        if (kind === undefined || typeof finding?.value !== "string" || finding.value.length === 0) {
          continue;
        }
        matches.push({ kind, value: finding.value });
      }
      if (matches.length > 0) {
        byIndex.set(id, matches);
      }
    }

    this.logger.info("Secret guard completed.", {
      segments: segmentCount,
      segmentsWithFindings: byIndex.size,
    });
    return byIndex;
  }
}

/** Maps a model-reported kind onto the domain vocabulary, ignoring anything else. */
function normalizeKind(value: unknown): SensitiveFindingKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return REDACTION_CATEGORIES.find((kind) => kind === normalized);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function stripFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1] ?? text;
}

/** Accepts a balanced contract object surrounded by provider reasoning, without logging it. */
function extractSegmentsJsonObject(text: string): unknown | undefined {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      if (character !== "}") continue;
      depth -= 1;
      if (depth !== 0) continue;
      try {
        const candidate = JSON.parse(text.slice(start, index + 1)) as unknown;
        if (typeof candidate === "object" && candidate !== null
          && Array.isArray((candidate as { readonly segments?: unknown }).segments)) {
          return candidate;
        }
      } catch {
        // Continue looking for another balanced object; provider reasoning may use braces.
      }
      break;
    }
  }
  return undefined;
}

export function guardSystemPrompt(kinds: readonly SensitiveFindingKind[]): string {
  return [
    "You are a security filter for a personal assistant. You find secrets in chat text.",
    "You receive a JSON array of segments: [{ \"id\": number, \"text\": string }].",
    "Some segments are typed messages; others are descriptions or transcripts derived from images and voice notes.",
    "",
    "For every segment, report the EXACT substrings that are secrets, copied character for character from the segment text.",
    "Do not paraphrase, trim, reformat, or correct them. Do not report the surrounding sentence, only the secret itself.",
    "Never rewrite the segment text. Never return the text back. Only report the substrings.",
    "",
    `Allowed kinds: ${kinds.join(", ")}.`,
    "",
    "Report a secret even when it is written casually in prose or spoken aloud, for example:",
    "\"the wifi password is bluebird77\" -> value \"bluebird77\", kind password.",
    "\"my recovery words are ...\" -> the words themselves, kind seed_phrase.",
    "",
    "Do NOT report: usernames, email addresses, phone numbers, URLs without credentials,",
    "public identifiers, project names, prices, dates, or anything already replaced by a [REDACTED:...] placeholder.",
    "",
    "Return only JSON, with this exact shape and no prose:",
    "{ \"segments\": [ { \"id\": number, \"findings\": [ { \"kind\": string, \"value\": string } ] } ] }",
    "Include a segment only when it has findings. Return { \"segments\": [] } when the text is clean.",
  ].join("\n");
}
