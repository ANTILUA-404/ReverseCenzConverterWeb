'use strict';

/**
 * AES-256-GCM envelope used for Roblox Open Cloud keys.
 *
 * The reference site advertises "ciphertext, IV and auth tag, never plaintext".
 * This implements exactly that: a 12-byte random IV per record, the 16-byte GCM
 * auth tag, and a key derived from KEY_SECRET with scrypt.
 */

const crypto = require('crypto');

const KEY_LEN = 32;
const IV_LEN = 12;

function deriveKey(secret) {
  return crypto.scryptSync(String(secret), 'cenz-studio-key-v1', KEY_LEN);
}

function createVault(secret) {
  const key = deriveKey(secret);

  return {
    encrypt(plaintext) {
      if (!plaintext) return null;
      const iv = crypto.randomBytes(IV_LEN);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
      };
    },

    decrypt(record) {
      if (!record || !record.ciphertext) return null;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(record.ciphertext, 'base64')),
          decipher.final(),
        ]);
        return plain.toString('utf8');
      } catch {
        return null;
      }
    },

    /** Only ever expose a masked hint, never the key or its ciphertext. */
    mask(plaintext) {
      if (!plaintext) return '';
      const s = String(plaintext);
      if (s.length <= 8) return '••••••••';
      return `${s.slice(0, 4)}••••••••${s.slice(-4)}`;
    },
  };
}

module.exports = { createVault };
