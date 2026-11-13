import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformAndroidMiguDecrypt } from './migu-decrypt-transform.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const miguUtilPath = path.join(repoRoot, 'danmu_api/utils/migu-util.js');
const codecUtilPath = path.join(repoRoot, 'danmu_api/utils/codec-util.js');

function deriveGatewayKey(encodedKey) {
  const sourceKey = Buffer.from(encodedKey, 'base64');
  const substitution = [3, 5, 7, 0, 15, 10, 13, 1, 11, 14, 4, 6, 9, 12, 8, 2];
  return Buffer.from(sourceKey.map(value => (substitution[value >>> 4] << 4) | substitution[value & 0x0f]));
}

function encryptPadded(text, key) {
  const cipher = createCipheriv('aes-256-ecb', key, null);
  return Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString('base64');
}

function encryptRawBlock(block, key) {
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]).toString('base64');
}

function decryptStrict(ciphertextBase64, keyBase64) {
  const decipher = createDecipheriv('aes-256-ecb', Buffer.from(keyBase64, 'base64'), null);
  return new TextDecoder('utf-8', { fatal: true })
    .decode(Buffer.concat([decipher.update(Buffer.from(ciphertextBase64, 'base64')), decipher.final()]));
}

test('Android migu transform prefers strict host AES while preserving validation and JS fallback errors', async () => {
  const originalSource = await readFile(miguUtilPath, 'utf8');
  const transformedSource = transformAndroidMiguDecrypt(originalSource)
    .replaceAll('"./codec-util.js"', JSON.stringify(pathToFileURL(codecUtilPath).href));
  const transformed = await import(`data:text/javascript;base64,${Buffer.from(transformedSource).toString('base64')}`);
  const original = await import(pathToFileURL(miguUtilPath).href);
  const defaultKey = 'vwwLu7e6ug4HAQMAug8CsA8HD7oHDwuxAg4HAQG6DLA=';
  const derivedKey = deriveGatewayKey(defaultKey);
  const plaintext = '咪咕 AES-256 ECB native compatibility ✓';
  const ciphertext = encryptPadded(plaintext, derivedKey);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'DanmakuHost');
  let nativeCalls = [];

  try {
    globalThis.DanmakuHost = {
      decryptAesEcbPkcs7(ciphertextBase64, keyBase64) {
        nativeCalls.push({ ciphertextBase64, keyBase64 });
        return decryptStrict(ciphertextBase64, keyBase64);
      },
    };
    assert.equal(await transformed.decrypt(ciphertext), await original.decrypt(ciphertext));
    assert.equal(await transformed.decrypt(ciphertext), plaintext);
    assert.equal(nativeCalls.length, 2);
    assert.deepEqual(nativeCalls[0], {
      ciphertextBase64: ciphertext,
      keyBase64: derivedKey.toString('base64'),
    });

    const callsBeforeValidation = nativeCalls.length;
    await assert.rejects(transformed.decrypt('%%%'), /Error decoding cipher text 1/);
    await assert.rejects(transformed.decrypt(Buffer.from([1]).toString('base64')), /Error decrypting cipher text 2/);
    assert.equal(nativeCalls.length, callsBeforeValidation);

    const invalidPadding = encryptRawBlock(Buffer.alloc(16), derivedKey);
    await assert.rejects(transformed.decrypt(invalidPadding), /Error decrypting cipher text 2/);

    const invalidUtf8Block = Buffer.alloc(16);
    invalidUtf8Block[0] = 0xff;
    invalidUtf8Block[15] = 1;
    const invalidUtf8 = encryptRawBlock(invalidUtf8Block, derivedKey);
    await assert.rejects(original.decrypt(invalidUtf8), /Error decrypting cipher text 2/);
    await assert.rejects(transformed.decrypt(invalidUtf8), /Error decrypting cipher text 2/);

    const beforeNullHostResult = nativeCalls.length;
    globalThis.DanmakuHost.decryptAesEcbPkcs7 = () => null;
    await assert.rejects(transformed.decrypt(ciphertext), /Error decrypting cipher text 2/);
    assert.equal(nativeCalls.length, beforeNullHostResult);

    delete globalThis.DanmakuHost.decryptAesEcbPkcs7;
    assert.equal(await transformed.decrypt(ciphertext), await original.decrypt(ciphertext));
    await assert.rejects(transformed.decrypt(invalidUtf8), /Error decrypting cipher text 2/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'DanmakuHost', descriptor);
    else delete globalThis.DanmakuHost;
  }
});

test('Android migu transform fails fast when upstream validation or decrypt markers drift', () => {
  const source = 'import { aesEcbDecrypt, base64ToBytes, utf8BytesToString } from "./codec-util.js";\n'
    + '    const decryptedBytes = aesEcbDecrypt(cipherBytes, gatewayKey);';
  assert.throws(() => transformAndroidMiguDecrypt(source.replace('aesEcbDecrypt, ', '')), /codec import/);
  assert.throws(() => transformAndroidMiguDecrypt(source.replace('const decryptedBytes', 'const plaintextBytes')), /AES decrypt call/);
});
