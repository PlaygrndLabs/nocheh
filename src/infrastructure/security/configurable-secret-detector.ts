import type { RedactedContent } from "../../domain/security/redaction.js";
import { compileCustomPattern, renderPlaceholder, type RedactionPolicy } from "../../domain/security/redaction-policy.js";
import type { RedactionPolicyProvider } from "../../application/ports/redaction-policy-provider.js";
import type { SecretDetectorPort } from "../../application/ports/secret-detector.js";
import { BUILT_IN_SECRET_PATTERNS } from "./built-in-secret-patterns.js";
import { redactWithPatterns, type CompiledSecretPattern } from "./redaction-engine.js";

/**
 * Config-driven secret detector. On each call it reads the current redaction
 * policy (synchronously, from a cached provider), keeps only the built-in
 * patterns whose category is enabled, and appends enabled custom patterns.
 *
 * The compiled pattern list is memoised by policy identity, so recompilation
 * only happens when the policy object is replaced (i.e. on a config update).
 */
export class ConfigurableSecretDetector implements SecretDetectorPort {
  private compiled?: { readonly policy: RedactionPolicy; readonly patterns: readonly CompiledSecretPattern[] };

  public constructor(private readonly policyProvider: RedactionPolicyProvider) {}

  public redact(text: string): RedactedContent {
    const policy = this.policyProvider.currentRedactionPolicy();
    const patterns = this.patternsFor(policy);
    return redactWithPatterns(text, patterns, (kind) => renderPlaceholder(policy.placeholder, kind));
  }

  /** Pattern matching is local and cheap, so there is nothing to batch. */
  public async redactMany(texts: readonly string[]): Promise<readonly RedactedContent[]> {
    return texts.map((text) => this.redact(text));
  }

  private patternsFor(policy: RedactionPolicy): readonly CompiledSecretPattern[] {
    if (this.compiled?.policy === policy) {
      return this.compiled.patterns;
    }

    const patterns: CompiledSecretPattern[] = [];
    for (const pattern of BUILT_IN_SECRET_PATTERNS) {
      if (policy.categories[pattern.kind]) {
        patterns.push(pattern);
      }
    }
    for (const custom of policy.customPatterns) {
      if (!custom.enabled) {
        continue;
      }
      try {
        patterns.push({ kind: custom.kind, regex: compileCustomPattern(custom) });
      } catch {
        // Patterns are validated on write; skip defensively if one is malformed.
      }
    }

    this.compiled = { policy, patterns };
    return patterns;
  }
}
