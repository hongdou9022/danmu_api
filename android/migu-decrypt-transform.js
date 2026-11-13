const codecImport = 'import { aesEcbDecrypt, base64ToBytes, utf8BytesToString } from "./codec-util.js";';
const javascriptDecrypt = '    const decryptedBytes = aesEcbDecrypt(cipherBytes, gatewayKey);';

export function transformAndroidMiguDecrypt(contents) {
  if (contents.split(codecImport).length !== 2) {
    throw new Error('Could not locate the migu codec import for Android native AES decryption.');
  }
  if (contents.split(javascriptDecrypt).length !== 2) {
    throw new Error('Could not locate the migu AES decrypt call for Android native AES decryption.');
  }

  return contents
    .replace(codecImport,
      'import { aesEcbDecrypt, base64ToBytes, bytesToBase64 as androidBytesToBase64, utf8BytesToString } from "./codec-util.js";')
    .replace(javascriptDecrypt, `    const androidHost = globalThis.DanmakuHost;
    if (typeof androidHost?.decryptAesEcbPkcs7 === "function") {
      const plaintext = androidHost.decryptAesEcbPkcs7(compactCipherText, androidBytesToBase64(gatewayKey));
      if (typeof plaintext !== "string") throw new Error("Native AES decryption failed");
      return plaintext;
    }
${javascriptDecrypt}`);
}
