/** Encrypts and decrypts persisted local data. */
export interface EncryptionPort {
  encryptUtf8(plainText: string): Promise<string>;
  decryptUtf8(cipherText: string): Promise<string>;
}
