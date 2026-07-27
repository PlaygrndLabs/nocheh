import type { SensitiveFindingKind } from "./redaction.js";

/** The full set of protectable secret categories ("active protected items"). */
export const REDACTION_CATEGORIES: readonly SensitiveFindingKind[] = [
  "api_key",
  "access_token",
  "private_key",
  "seed_phrase",
  "password",
  "connection_secret",
];

const REGEX_FLAG_PATTERN = /^[gimsuy]*$/;

/** Default placeholder written in place of a redacted span; `{kind}` is substituted. */
export const DEFAULT_REDACTION_PLACEHOLDER = "[REDACTED:{kind}]";

/** A user-defined redaction rule stored alongside the built-in catalog. */
export interface CustomRedactionPattern {
  readonly id: string;
  readonly kind: SensitiveFindingKind;
  readonly label: string;
  readonly regex: string;
  readonly flags?: string;
  readonly enabled: boolean;
}

/** Configurable redaction policy: which categories are active plus custom rules. */
export interface RedactionPolicy {
  readonly categories: Readonly<Record<SensitiveFindingKind, boolean>>;
  readonly customPatterns: readonly CustomRedactionPattern[];
  readonly placeholder: string;
}

/** Every built-in category enabled, no custom patterns. */
export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  categories: {
    api_key: true,
    access_token: true,
    private_key: true,
    seed_phrase: true,
    password: true,
    connection_secret: true,
  },
  customPatterns: [],
  placeholder: DEFAULT_REDACTION_PLACEHOLDER,
};

/** Shape accepted when updating a policy; every field is optional. */
export interface RedactionPolicyPatch {
  readonly categories?: Partial<Record<string, unknown>>;
  readonly customPatterns?: readonly unknown[];
  readonly placeholder?: unknown;
}

export function isSensitiveFindingKind(value: unknown): value is SensitiveFindingKind {
  return typeof value === "string" && (REDACTION_CATEGORIES as readonly string[]).includes(value);
}

/** Substitutes `{kind}` in a placeholder template. */
export function renderPlaceholder(placeholder: string, kind: SensitiveFindingKind): string {
  return placeholder.replaceAll("{kind}", kind);
}

/** Normalises flags to always include the global flag and rejects unknown flags. */
export function normalizeRegexFlags(flags: string | undefined): string {
  const value = flags ?? "";
  if (!REGEX_FLAG_PATTERN.test(value)) {
    throw new Error(`Invalid regex flags: "${value}"`);
  }
  return value.includes("g") ? value : `${value}g`;
}

/** Compiles a custom pattern into a reusable global RegExp, throwing on invalid input. */
export function compileCustomPattern(
  pattern: Pick<CustomRedactionPattern, "regex" | "flags">,
): RegExp {
  if (typeof pattern.regex !== "string" || pattern.regex.length === 0) {
    throw new Error("Custom redaction pattern regex must be a non-empty string.");
  }
  return new RegExp(pattern.regex, normalizeRegexFlags(pattern.flags));
}

/**
 * Validates and merges a patch onto a base policy. Unknown/invalid category keys
 * are ignored; custom patterns are fully validated (kind + compilable regex) and
 * an invalid one throws so the caller can surface a 400.
 */
export function normalizeRedactionPolicy(
  patch: RedactionPolicyPatch,
  base: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): RedactionPolicy {
  return {
    categories: mergeCategories(base.categories, patch.categories),
    customPatterns: patch.customPatterns === undefined
      ? base.customPatterns
      : patch.customPatterns.map(normalizeCustomPattern),
    placeholder: normalizePlaceholder(patch.placeholder, base.placeholder),
  };
}

function mergeCategories(
  base: Readonly<Record<SensitiveFindingKind, boolean>>,
  patch: Partial<Record<string, unknown>> | undefined,
): Record<SensitiveFindingKind, boolean> {
  const merged = { ...base };
  if (patch === undefined) {
    return merged;
  }
  for (const kind of REDACTION_CATEGORIES) {
    const value = patch[kind];
    if (typeof value === "boolean") {
      merged[kind] = value;
    }
  }
  return merged;
}

function normalizePlaceholder(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function normalizeCustomPattern(value: unknown, index: number): CustomRedactionPattern {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Custom redaction pattern at index ${index} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (!isSensitiveFindingKind(record.kind)) {
    throw new Error(`Custom redaction pattern at index ${index} has an invalid kind.`);
  }
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
  if (id === undefined) {
    throw new Error(`Custom redaction pattern at index ${index} is missing an id.`);
  }
  const label = typeof record.label === "string" && record.label.trim().length > 0
    ? record.label.trim()
    : record.kind;
  const regex = typeof record.regex === "string" ? record.regex : "";
  const flags = typeof record.flags === "string" ? record.flags : undefined;
  // Throws when the regex or flags are invalid.
  compileCustomPattern({ regex, ...(flags === undefined ? {} : { flags }) });

  return {
    id,
    kind: record.kind,
    label,
    regex,
    ...(flags === undefined ? {} : { flags }),
    enabled: record.enabled === undefined ? true : record.enabled === true,
  };
}
