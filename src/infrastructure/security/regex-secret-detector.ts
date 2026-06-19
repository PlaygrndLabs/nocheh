import type { RedactedContent, SensitiveFinding, SensitiveFindingKind } from "../../domain/security/redaction.js";
import type { SecretDetectorPort } from "../../application/ports/secret-detector.js";

interface SecretPattern {
  readonly kind: SensitiveFindingKind;
  readonly regex: RegExp;
}

/** Regex-based detector for common secrets that must be redacted before processing. */
export class RegexSecretDetector implements SecretDetectorPort {
  private readonly patterns: readonly SecretPattern[] = [
    { kind: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { kind: "api_key", regex: /\b(?:sk|pk|rk|ak|AIza)[A-Za-z0-9_-]{16,}\b/g },
    { kind: "access_token", regex: /\b(?:ghp|github_pat|xox[baprs]|ya29)\b[A-Za-z0-9_./-]{20,}/g },
    { kind: "connection_secret", regex: /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s]+/gi },
    { kind: "password", regex: /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?[^'"\s]{6,}/gi },
    { kind: "seed_phrase", regex: /\b(?:seed phrase|mnemonic)\s*[:=]\s*(?:[a-z]+[\s,]+){11,23}[a-z]+\b/gi },
  ];

  /** Redacts known sensitive spans and returns finding metadata without secret values. */
  public redact(text: string): RedactedContent {
    const findings = this.find(text);
    if (findings.length === 0) {
      return { text, findings };
    }

    let redacted = "";
    let cursor = 0;
    for (const finding of findings) {
      redacted += text.slice(cursor, finding.start);
      redacted += `[REDACTED:${finding.kind}]`;
      cursor = finding.end;
    }
    redacted += text.slice(cursor);

    return { text: redacted, findings };
  }

  private find(text: string): SensitiveFinding[] {
    const findings: SensitiveFinding[] = [];
    for (const pattern of this.patterns) {
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

    return this.mergeOverlaps(findings.sort((left, right) => left.start - right.start));
  }

  private mergeOverlaps(findings: readonly SensitiveFinding[]): SensitiveFinding[] {
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
}
