// src/lib/crypto/jades-signer.ts
import forge from 'node-forge';
import { createHash, createSign, createVerify } from 'crypto';
import { logger } from '../../config/logger';

export interface SignatureResult {
  signature: string;
  certificate: string;
  signingTime: string;
  digestValue: string;
}

export class JAdESSigner {
  private privateKey: forge.pki.PrivateKey;
  private certificate: forge.pki.Certificate;
  private csid: string;

  constructor(privateKeyPem: string, certificatePem: string, csid: string) {
    this.privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    this.certificate = forge.pki.certificateFromPem(certificatePem);
    this.csid = csid;
  }

  /**
   * Sign invoice data according to JAdES (JSON Advanced Electronic Signature)
   */
  async signInvoice(invoiceData: object, irn: string): Promise<SignatureResult> {
    try {
      // Step 1: Create canonical JSON (deterministic)
      const canonicalJson = this.canonicalize(invoiceData);
      
      // Step 2: Compute digest (SHA-256)
      const digest = createHash('sha256')
        .update(canonicalJson)
        .update(irn)
        .digest('base64');
      
      // Step 3: Create signature (ECDSA with SHA-256)
      const signer = createSign('SHA256');
      signer.update(canonicalJson + irn);
      signer.end();
      
      const signature = signer.sign({
        key: forge.pki.privateKeyToPem(this.privateKey),
        format: 'der',
        type: 'pkcs1'
      }).toString('base64');
      
      // Step 4: Get signing time (UTC)
      const signingTime = new Date().toISOString();
      
      // Step 5: Prepare JAdES structure
      const jadesSignature = this.buildJAdESStructure(
        signature,
        digest,
        signingTime,
        irn
      );
      
      return {
        signature: jadesSignature,
        certificate: forge.pki.certificateToPem(this.certificate),
        signingTime,
        digestValue: digest
      };
      
    } catch (error) {
      logger.error('JAdES signing failed:', error);
      throw new Error(`JAdES signature generation failed: ${error.message}`);
    }
  }

  /**
   * Verify JAdES signature
   */
  verifySignature(
    invoiceData: object,
    signature: string,
    certificatePem: string,
    irn: string
  ): boolean {
    try {
      const canonicalJson = this.canonicalize(invoiceData);
      const parsedSignature = this.parseJAdESStructure(signature);
      
      const verifier = createVerify('SHA256');
      verifier.update(canonicalJson + irn);
      verifier.end();
      
      return verifier.verify({
        key: certificatePem,
        format: 'der',
        type: 'pkcs1'
      }, Buffer.from(parsedSignature.signature, 'base64'));
      
    } catch (error) {
      logger.error('JAdES verification failed:', error);
      return false;
    }
  }

  /**
   * Canonicalize JSON for deterministic signing
   */
  private canonicalize(obj: any): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    
    if (Array.isArray(obj)) {
      return '[' + obj.map(item => this.canonicalize(item)).join(',') + ']';
    }
    
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(key => 
      `"${key}":${this.canonicalize(obj[key])}`
    );
    
    return '{' + pairs.join(',') + '}';
  }

  /**
   * Build JAdES signature structure
   */
  private buildJAdESStructure(
    signature: string,
    digestValue: string,
    signingTime: string,
    irn: string
  ): string {
    const jades = {
      signatures: [{
        protected: {
          alg: "ES256",
          kid: this.csid,
          sigT: signingTime
        },
        header: {
          x5c: [forge.pki.certificateToPem(this.certificate)],
          dig: {
            alg: "SHA256",
            value: digestValue
          },
          irn: irn,
          references: [{
            uri: "",
            dig: {
              alg: "SHA256",
              value: digestValue
            }
          }]
        },
        signature: signature
      }]
    };
    
    return Buffer.from(JSON.stringify(jades)).toString('base64');
  }

  /**
   * Parse JAdES structure
   */
  private parseJAdESStructure(base64Signature: string): any {
    const jsonStr = Buffer.from(base64Signature, 'base64').toString();
    return JSON.parse(jsonStr).signatures[0];
  }
}
