/** Encrypted-capable key/value store for global application configuration. */
export interface AppConfigRepositoryPort {
  /** Returns all config entries as a key -> JSON-string map (decrypted). */
  getAll(): Promise<Record<string, string>>;
  /** Upserts a single entry. When `encrypted` is true the value is stored encrypted at rest. */
  set(key: string, value: string, encrypted?: boolean): Promise<void>;
}
