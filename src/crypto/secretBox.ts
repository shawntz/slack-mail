import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function keyFromB64(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== KEY_LEN) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes when base64-decoded");
  }
  return key;
}

export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = keyFromB64(keyB64);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(ciphertextB64: string, keyB64: string): string {
  const key = keyFromB64(keyB64);
  const buf = Buffer.from(ciphertextB64, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
