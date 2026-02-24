import crypto from 'crypto';
import { logger } from './logger';

export interface EncryptionConfig {
  algorithm: string;
  keyDerivation: {
    iterations: number;
    keylen: number;
    digest: string;
  };
  authTagLength: number;
}

class EncryptionManager {
  private static instance: EncryptionManager;
  private masterKey: Buffer;
  private config: EncryptionConfig;

  private constructor() {
    this.config = {
      algorithm: 'aes-256-gcm',
      keyDerivation: {
        iterations: 100000,
        keylen: 32,
        digest: 'sha256',
      },
      authTagLength: 16,
    };

    const keyHex = process.env.ENCRYPTION_KEY;
    if (!keyHex) {
      throw new Error('ENCRYPTION_KEY environment variable is required');
    }

    // Support both hex and base64 encoded keys
    if (keyHex.length === 64) {
      // Hex encoded 32-byte key
      this.masterKey = Buffer.from(keyHex, 'hex');
    } else if (keyHex.length === 44) {
      // Base64 encoded 32-byte key
      this.masterKey = Buffer.from(keyHex, 'base64');
    } else {
      // Derive key from password
      this.masterKey = crypto.pbkdf2Sync(
        keyHex,
        'elexsol-salt',
        this.config.keyDerivation.iterations,
        this.config.keyDerivation.keylen,
        this.config.keyDerivation.digest
      );
    }

    if (this.masterKey.length !== 32) {
      throw new Error('Invalid encryption key length. Must be 32 bytes.');
    }
  }

  public static getInstance(): EncryptionManager {
    if (!EncryptionManager.instance) {
      EncryptionManager.instance = new EncryptionManager();
    }
    return EncryptionManager.instance;
  }

  /**
   * Encrypt data using AES-256-GCM
   */
  public encrypt(
    data: string | Buffer,
    aad?: Buffer // Additional authenticated data
  ): {
    encrypted: Buffer;
    iv: Buffer;
    authTag: Buffer;
  } {
    try {
      const iv = crypto.randomBytes(12); // 96 bits for GCM
      const cipher = crypto.createCipheriv(
        this.config.algorithm,
        this.masterKey,
        iv,
        { authTagLength: this.config.authTagLength }
      );

      if (aad) {
        cipher.setAAD(aad);
      }

      const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      
      const encrypted = Buffer.concat([
        cipher.update(dataBuffer),
        cipher.final()
      ]);

      const authTag = cipher.getAuthTag();

      return { encrypted, iv, authTag };
    } catch (error) {
      logger.error('Encryption failed:', error);
      throw new Error('Encryption failed');
    }
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  public decrypt(
    encrypted: Buffer,
    iv: Buffer,
    authTag: Buffer,
    aad?: Buffer
  ): Buffer {
    try {
      const decipher = crypto.createDecipheriv(
        this.config.algorithm,
        this.masterKey,
        iv,
        { authTagLength: this.config.authTagLength }
      );

      decipher.setAuthTag(authTag);

      if (aad) {
        decipher.setAAD(aad);
      }

      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);
    } catch (error) {
      logger.error('Decryption failed:', error);
      throw new Error('Decryption failed - data may be corrupted or key invalid');
    }
  }

  /**
   * Encrypt for storage (returns base64 string with metadata)
   */
  public encryptForStorage(
    data: string | Buffer,
    context?: string
  ): string {
    const aad = context ? Buffer.from(context) : undefined;
    const { encrypted, iv, authTag } = this.encrypt(data, aad);
    
    // Combine metadata with encrypted data
    const result = {
      v: 1, // version
      iv: iv.toString('base64'),
      tag: authTag.toString('base64'),
      data: encrypted.toString('base64'),
      ctx: context,
    };

    return Buffer.from(JSON.stringify(result)).toString('base64');
  }

  /**
   * Decrypt from storage format
   */
  public decryptFromStorage(
    encryptedPackage: string,
    expectedContext?: string
  ): Buffer {
    try {
      const parsed = JSON.parse(
        Buffer.from(encryptedPackage, 'base64').toString()
      );

      if (parsed.v !== 1) {
        throw new Error('Unsupported encryption version');
      }

      const iv = Buffer.from(parsed.iv, 'base64');
      const authTag = Buffer.from(parsed.tag, 'base64');
      const encrypted = Buffer.from(parsed.data, 'base64');
      
      const aad = parsed.ctx ? Buffer.from(parsed.ctx) : undefined;

      // Verify context if expected
      if (expectedContext && parsed.ctx !== expectedContext) {
        throw new Error('Context mismatch - possible tampering');
      }

      return this.decrypt(encrypted, iv, authTag, aad);
    } catch (error) {
      logger.error('Storage decryption failed:', error);
      throw new Error('Failed to decrypt stored data');
    }
  }

  /**
   * Generate a new encryption key
   */
  public generateKey(): {
    hex: string;
    base64: string;
  } {
    const key = crypto.randomBytes(32);
    return {
      hex: key.toString('hex'),
      base64: key.toString('base64'),
    };
  }

  /**
   * Rotate key for specific data
   */
  public async reencrypt(
    encryptedPackage: string,
    newContext?: string
  ): Promise<string> {
    const decrypted = this.decryptFromStorage(encryptedPackage);
    return this.encryptForStorage(decrypted, newContext);
  }

  /**
   * Hash data (for integrity checks, not encryption)
   */
  public hash(data: string | Buffer, algorithm: string = 'sha256'): string {
    const hash = crypto.createHash(algorithm);
    hash.update(data);
    return hash.digest('hex');
  }

  /**
   * Create HMAC for data
   */
  public hmac(data: string | Buffer, key?: string): string {
    const hmacKey = key || this.masterKey.toString('hex');
    const hmac = crypto.createHmac('sha256', hmacKey);
    hmac.update(data);
    return hmac.digest('hex');
  }

  /**
   * Generate random bytes
   */
  public randomBytes(size: number): Buffer {
    return crypto.randomBytes(size);
  }

  /**
   * Generate secure random string
   */
  public randomString(length: number): string {
    return crypto.randomBytes(Math.ceil(length / 2))
      .toString('hex')
      .slice(0, length);
  }
}

export const encryption = EncryptionManager.getInstance();
export const encrypt = (data: string): Buffer => {
  const result = encryption.encrypt(data);
  return Buffer.from(JSON.stringify({
    iv: result.iv.toString('base64'),
    tag: result.authTag.toString('base64'),
    data: result.encrypted.toString('base64'),
  }));
};

export const decrypt = (encryptedBuffer: Buffer): string => {
  const parsed = JSON.parse(encryptedBuffer.toString());
  const result = encryption.decrypt(
    Buffer.from(parsed.data, 'base64'),
    Buffer.from(parsed.iv, 'base64'),
    Buffer.from(parsed.tag, 'base64')
  );
  return result.toString('utf8');
};
