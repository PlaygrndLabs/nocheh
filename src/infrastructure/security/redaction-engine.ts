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
