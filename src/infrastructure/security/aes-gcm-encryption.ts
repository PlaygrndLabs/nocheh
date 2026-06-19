import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { EncryptionPort } from "../../application/ports/encryption.js";

/** AES-256-GCM encryption for local persisted JSON payloads. */
export class AesGcmEncryption implements EncryptionPort {
  private readonly key: Buffer;

  public constructor(secret: string, salt = "my-nocheh-local-store") {
    if (secret.length < 16) {
      throw new Error("Encryption secret must contain at least 16 characters.");
    }
    this.key = scryptSync(secret, salt, 32);
  }

  /** Encrypts UTF-8 text into a versioned base64 payload. */
  public async encryptUtf8(plainText: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
  }

  /** Decrypts a payload produced by {@link encryptUtf8}. */
  public async decryptUtf8(cipherText: string): Promise<string> {
    const [version, iv, tag, encrypted] = cipherText.split(".");
    if (version !== "v1" || iv === undefined || tag === undefined || encrypted === undefined) {
      throw new Error("Unsupported encrypted payload format.");
    }

    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
