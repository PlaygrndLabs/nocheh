import type { RedactionPolicy } from "../../domain/security/redaction-policy.js";

/** Supplies the current redaction policy synchronously for the hot path. */
export interface RedactionPolicyProvider {
  currentRedactionPolicy(): RedactionPolicy;
}
