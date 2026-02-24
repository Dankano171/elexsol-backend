import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { userRepository } from '../../repositories/UserRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';

export interface MFAConfig {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export interface MFAVerification {
  success: boolean;
  type: 'totp' | 'backup';
  remainingBackupCodes?: number;
}

export class MFAService {
  private readonly backupCodeCount = 8;
  private readonly backupCodeLength = 10;

  /**
   * Setup MFA for user
   */
  async setupMFA(userId: string): Promise<MFAConfig> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    // Generate MFA secret
    const secret = speakeasy.generateSecret({
      name: `Elexsol (${user.email})`,
      issuer: 'Elexsol',
    });

    // Generate backup codes
    const backupCodes = this.generateBackupCodes();

    // Generate QR code
    const qrCode = await QRCode.toDataURL(secret.otpauth_url!);

    // Hash backup codes for storage
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => this.hashBackupCode(code))
    );

    // Save to user
    await userRepository.updateMFA(userId, secret.base32, hashedBackupCodes);

    // Log audit
    await auditLogRepository.log({
      user_id: userId,
      business_id: user.business_id,
      action: 'MFA_ENABLE',
      entity_type: 'user',
      entity_id: userId,
      metadata: {
        method: 'totp',
      },
    });

    return {
      secret: secret.base32,
      qrCode,
      backupCodes,
    };
  }

  /**
   * Verify MFA code
   */
  async verifyMFA(
    userId: string,
    code: string
  ): Promise<MFAVerification> {
    const user = await userRepository.findById(userId);
    
    if (!user || !user.mfa_secret) {
      throw new Error('MFA not configured');
    }

    // Check if it's a backup code
    if (user.mfa_backup_codes) {
      for (let i = 0; i < user.mfa_backup_codes.length; i++) {
        const isValid = await this.verifyBackupCode(code, user.mfa_backup_codes[i]);
        if (isValid) {
          // Remove used backup code
          const remainingCodes = [...user.mfa_backup_codes];
          remainingCodes.splice(i, 1);
          await userRepository.update(userId, {
            mfa_backup_codes: remainingCodes,
          });

          return {
            success: true,
            type: 'backup',
            remainingBackupCodes: remainingCodes.length,
          };
        }
      }
    }

    // Verify TOTP
    const isValid = speakeasy.totp.verify({
      secret: user.mfa_secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (isValid) {
      return {
        success: true,
        type: 'totp',
      };
    }

    return {
      success: false,
      type: 'totp',
    };
  }

  /**
   * Disable MFA
   */
  async disableMFA(userId: string, code: string): Promise<boolean> {
    const verification = await this.verifyMFA(userId, code);
    
    if (!verification.success) {
      throw new Error('Invalid MFA code');
    }

    await userRepository.disableMFA(userId);

    // Log audit
    const user = await userRepository.findById(userId);
    if (user) {
      await auditLogRepository.log({
        user_id: userId,
        business_id: user.business_id,
        action: 'MFA_DISABLE',
        entity_type: 'user',
        entity_id: userId,
      });
    }

    return true;
  }

  /**
   * Generate new backup codes
   */
  async regenerateBackupCodes(userId: string, code: string): Promise<string[]> {
    const verification = await this.verifyMFA(userId, code);
    
    if (!verification.success) {
      throw new Error('Invalid MFA code');
    }

    const backupCodes = this.generateBackupCodes();
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => this.hashBackupCode(code))
    );

    await userRepository.update(userId, {
      mfa_backup_codes: hashedBackupCodes,
    });

    return backupCodes;
  }

  /**
   * Generate backup codes
   */
  private generateBackupCodes(): string[] {
    const codes: string[] = [];
    
    for (let i = 0; i < this
