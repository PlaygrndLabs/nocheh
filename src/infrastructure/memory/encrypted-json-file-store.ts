import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EncryptionPort } from "../../application/ports/encryption.js";

/** Encrypted local JSON document store for small Phase 1 deployments. */
export class EncryptedJsonFileStore<T> {
  public constructor(
    private readonly filePath: string,
    private readonly encryption: EncryptionPort,
    private readonly defaultValue: T,
  ) {}

  /** Reads and decrypts the JSON document, returning the default value if absent. */
  public async read(): Promise<T> {
    try {
      const encrypted = await readFile(this.filePath, "utf8");
      const json = await this.encryption.decryptUtf8(encrypted);
      return JSON.parse(json) as T;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return this.defaultValue;
      }
      throw error;
    }
  }

  /** Encrypts and atomically writes the JSON document. */
  public async write(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const encrypted = await this.encryption.encryptUtf8(JSON.stringify(value, null, 2));
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, encrypted, "utf8");
    await rename(tempPath, this.filePath);
  }
}
