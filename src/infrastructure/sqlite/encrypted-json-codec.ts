import type { EncryptionPort } from "../../application/ports/encryption.js";

export class EncryptedJsonCodec {
  public constructor(private readonly encryption: EncryptionPort) {}

  public async encode(value: unknown): Promise<string> {
    return this.encryption.encryptUtf8(JSON.stringify(value));
  }

  public async decode<T>(payload: string): Promise<T> {
    return JSON.parse(await this.encryption.decryptUtf8(payload)) as T;
  }
}
