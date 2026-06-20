/** Reads and updates persisted environment configuration (e.g. a .env file). */
export interface EnvStorePort {
  /** Returns all configured key/value pairs. */
  read(): Promise<Record<string, string>>;
  /** Writes the given keys, preserving existing content. Returns the keys written. */
  setMany(values: Record<string, string>): Promise<readonly string[]>;
  /** Returns whether each requested key has a non-empty value. */
  presence(keys: readonly string[]): Promise<Record<string, boolean>>;
}
