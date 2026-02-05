import crypto from "crypto";

export function generateUserKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" }
  });
}

export function encryptForUser(fileKey, publicKey) {
  return crypto.publicEncrypt(publicKey, fileKey);
}

export function decryptForUser(encryptedKey, privateKey) {
  return crypto.privateDecrypt(privateKey, encryptedKey);
}