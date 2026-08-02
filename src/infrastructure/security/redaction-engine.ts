import type {
  RedactedContent,
  SensitiveFinding,
  SensitiveFindingKind,
} from "../../domain/security/redaction.js";

/** A compiled secret pattern ready for matching. Regexes must carry the global flag. */
export interface CompiledSecretPattern {
  readonly kind: SensitiveFindingKind;
  readonly regex: RegExp;
}

/**
 * Runs the given patterns over `text`, merges overlapping findings, and replaces
 * each span with `placeholderFor(kind)`. Pure and shared by all detectors.
 */
export function redactWithPatterns(
  text: string,
  patterns: readonly CompiledSecretPattern[],
  placeholderFor: (kind: SensitiveFindingKind) => string,
): RedactedContent {
  const findings = findSecrets(text, patterns);
  if (findings.length === 0) {
    return { text, findings };
  }

  let redacted = "";
  let cursor = 0;
  for (const finding of findings) {
    redacted += text.slice(cursor, finding.start);
    redacted += placeholderFor(finding.kind);
    cursor = finding.end;
  }
  redacted += text.slice(cursor);

  return { text: redacted, findings };
}

function findSecrets(text: string, patterns: readonly CompiledSecretPattern[]): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  for (const pattern of patterns) {
    // matchAll clones the regex, so shared/global patterns are safe to reuse.
    for (const match of text.matchAll(pattern.regex)) {
      if (match.index === undefined) {
        continue;
      }
      findings.push({
        kind: pattern.kind,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return mergeOverlaps(findings.sort((left, right) => left.start - right.start));
}

/** A secret a detector reported by value rather than by position. */
export interface LiteralSecretMatch {
  readonly kind: SensitiveFindingKind;
  readonly value: string;
}

/**
 * Shortest literal a detector may report.
 *
 * A model that returns a very short string (" a", "the") would mask most of the
 * message, so short literals are rejected rather than trusted.
 */
export const MINIMUM_LITERAL_SECRET_LENGTH = 4;

/**
 * Masks every occurrence of each reported literal.
 *
 * Used for detectors that identify secrets by value, such as a model. The model
 * reports what to mask; the masking itself happens here, locally and
 * deterministically, so the message text is never rewritten by a model. Literals
 * that do not appear in the text are ignored, which makes a hallucinated finding
 * harmless instead of destructive.
 */
export function redactLiterals(
  text: string,
  matches: readonly LiteralSecretMatch[],
  placeholderFor: (kind: SensitiveFindingKind) => string,
): RedactedContent {
  const findings: SensitiveFinding[] = [];
  for (const match of matches) {
    const value = match.value;
    if (value.length < MINIMUM_LITERAL_SECRET_LENGTH) {
      continue;
    }
    let index = text.indexOf(value);
    while (index !== -1) {
      findings.push({ kind: match.kind, start: index, end: index + value.length });
      index = text.indexOf(value, index + value.length);
    }
  }

  if (findings.length === 0) {
    return { text, findings: [] };
  }

  const merged = mergeOverlaps(findings.sort((left, right) => left.start - right.start));
  let redacted = "";
  let cursor = 0;
  for (const finding of merged) {
    redacted += text.slice(cursor, finding.start);
    redacted += placeholderFor(finding.kind);
    cursor = finding.end;
  }
  redacted += text.slice(cursor);
  return { text: redacted, findings: merged };
}

function mergeOverlaps(findings: readonly SensitiveFinding[]): SensitiveFinding[] {
  const merged: SensitiveFinding[] = [];
  for (const finding of findings) {
    const previous = merged.at(-1);
    if (previous === undefined || finding.start >= previous.end) {
      merged.push(finding);
      continue;
    }

    merged[merged.length - 1] = {
      kind: previous.kind,
      start: previous.start,
      end: Math.max(previous.end, finding.end),
    };
  }
  return merged;
}
