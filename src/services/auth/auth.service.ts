import { userRepository } from '../../repositories/UserRepository';
import { sessionRepository } from '../../repositories/SessionRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';

export interface LoginCredentials {
  email: string;
  password: string;
  mfaCode?: string;
  rememberMe?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface MFAConfig {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export class AuthService {
  private readonly accessTokenExpiry = 15 * 60; // 15 minutes
  private readonly refreshTokenExpiry = 7 * 24 * 60 * 60; // 7 days

  /**
   * Authenticate user
   */
  async login(
    credentials: LoginCredentials,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ user: any; tokens: AuthTokens; requiresMFA: boolean }> {
    try {
      // Find user by email
      const user = await userRepository.findByEmail(credentials.email);
      
      if (!user) {
        throw new Error('Invalid email or password');
      }

      // Check if account is locked
      if (user.locked_until && user.locked_until > new Date()) {
        throw new Error(`Account locked until ${user.locked_until.toISOString()}`);
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(
        credentials.password,
        user.password_hash
      );

      if (!isValidPassword) {
        // Increment login attempts
        await userRepository.incrementLoginAttempts(user.id);
        
        // Log failed attempt
        await auditLogRepository.log({
          user_id: user.id,
          business_id: user.business_id,
          action: 'LOGIN',
          entity_type: 'user',
          entity_id: user.id,
          metadata: {
            success: false,
            reason: 'Invalid password',
            ip_address: ipAddress,
            user_agent: userAgent,
          },
        });

        throw new Error('Invalid email or password');
      }

      // Check if MFA is required
      if (user.mfa_enabled && !credentials.mfaCode) {
        return {
          user: this.sanitizeUser(user),
          tokens: null!,
          requiresMFA: true,
        };
      }

      // Verify MFA if enabled
      if (user.mfa_enabled && credentials.mfaCode) {
        const isValidMFA = await this.verifyMFA(user.id, credentials.mfaCode);
        if (!isValidMFA) {
          throw new Error('Invalid MFA code');
        }
      }

      // Reset login attempts
      await userRepository.resetLoginAttempts(user.id);

      // Create session
      const tokens = await this.createSession(
        user.id,
        user.business_id,
        ipAddress,
        userAgent,
        credentials.rememberMe
      );

      // Log successful login
      await auditLogRepository.log({
        user_id: user.id,
        business_id: user.business_id,
        action: 'LOGIN',
        entity_type: 'user',
        entity_id: user.id,
        metadata: {
          success: true,
          mfa_used: user.mfa_enabled,
          ip_address: ipAddress,
          user_agent: userAgent,
        },
      });

      return {
        user: this.sanitizeUser(user),
        tokens,
        requiresMFA: false,
      };
    } catch (error) {
      logger.error('Login error:', error);
      throw error;
    }
  }

  /**
   * Create new session
   */
  async createSession(
    userId: string,
    businessId: string,
    ipAddress?: string,
    userAgent?: string,
    rememberMe: boolean = false
  ): Promise<AuthTokens> {
    const sessionToken = uuidv4();
    const refreshToken = uuidv4();

    const expiresIn = rememberMe ? this.refreshTokenExpiry : this.accessTokenExpiry;

    // Create session record
    await sessionRepository.createSession({
      user_id: userId,
      business_id: businessId,
      session_token: sessionToken,
      refresh_token: refreshToken,
      ip_address: ipAddress,
      user_agent: userAgent,
      expires_in: expiresIn,
      refresh_expires_in: rememberMe ? this.refreshTokenExpiry : undefined,
    });

    // Generate JWT
    const accessToken = jwt.sign(
      {
        sub: userId,
        business_id: businessId,
        session_id: sessionToken,
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: this.accessTokenExpiry }
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTokenExpiry,
      tokenType: 'Bearer',
    };
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    // Validate refresh token
    const session = await sessionRepository.validateRefreshToken(refreshToken);
    
    if (!session) {
      throw new Error('Invalid or expired refresh token');
    }

    // Generate new access token
    const accessToken = jwt.sign(
      {
        sub: session.user_id,
        business_id: session.business_id,
        session_id: session.session_token,
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: this.accessTokenExpiry }
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTokenExpiry,
      tokenType: 'Bearer',
    };
  }

  /**
   * Logout user
   */
  async logout(sessionToken: string): Promise<void> {
    await sessionRepository.deactivateAllUserSessions(sessionToken);
    
    // Remove from cache
    await redis.del(`session:${sessionToken}`);
  }

  /**
   * Logout from all devices
   */
  async logoutAll(userId: string, currentSessionId?: string): Promise<void> {
    await sessionRepository.deactivateAllUserSessions(userId, currentSessionId);
    
    // Clear all session caches
    const sessions = await sessionRepository.getUserActiveSessions(userId);
    for (const session of sessions) {
      if (session.id !== currentSessionId) {
        await redis.del(`session:${session.session_token}`);
      }
    }
  }

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
      name: `Elexsol:${user.email}`,
    });

    // Generate backup codes
    const backupCodes = Array.from({ length: 8 }, () => 
      Math.random().toString(36).substring(2, 10).toUpperCase()
    );

    // Generate QR code
    const qrCode = await QRCode.toDataURL(secret.otpauth_url!);

    // Save to user
    await userRepository.updateMFA(userId, secret.base32, backupCodes);

    return {
      secret: secret.base32,
      qrCode,
      backupCodes,
    };
  }

  /**
   * Verify MFA code
   */
  async verifyMFA(userId: string, code: string): Promise<boolean> {
    const user = await userRepository.findById(userId);
    
    if (!user || !user.mfa_secret) {
      return false;
    }

    // Check if it's a backup code
    if (user.mfa_backup_codes) {
      const isValidBackup = await userRepository.verifyBackupCode(userId, code);
      if (isValidBackup) {
        return true;
      }
    }

    // Verify TOTP
    return speakeasy.totp.verify({
      secret: user.mfa_secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
  }

  /**
   * Disable MFA
   */
  async disableMFA(userId: string, code: string): Promise<void> {
    const isValid = await this.verifyMFA(userId, code);
    
    if (!isValid) {
      throw new Error('Invalid MFA code');
    }

    await userRepository.disableMFA(userId);
  }

  /**
   * Validate session
   */
  async validateSession(sessionToken: string): Promise<any> {
    // Check cache first
    const cached = await redis.get(`session:${sessionToken}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Check database
    const session = await sessionRepository.validateSession(sessionToken);
    
    if (!session) {
      return null;
    }

    // Cache session
    await redis.set(
      `session:${sessionToken}`,
      JSON.stringify(session),
      300 // 5 minutes
    );

    return session;
  }

  /**
   * Change password
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    // Verify old password
    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) {
      throw new Error('Current password is incorrect');
    }

    // Check password history
    const isReused = await userRepository.isPasswordReused(userId, newPassword);
    if (isReused) {
      throw new Error('Cannot reuse a recent password');
    }

    // Update password
    const saltRounds = 10;
    const newHash = await bcrypt.hash(newPassword, saltRounds);
    
    await userRepository.updatePassword(userId, newHash);
    await userRepository.addToPasswordHistory(userId, newHash);

    // Logout from all other devices
    const sessions = await sessionRepository.getUserActiveSessions(userId);
    for (const session of sessions) {
      await sessionRepository.deactivate(session.id, 'password_changed');
    }

    // Log audit
    await auditLogRepository.log({
      user_id: userId,
      business_id: user.business_id,
      action: 'PASSWORD_CHANGE',
      entity_type: 'user',
      entity_id: userId,
    });
  }

  /**
   * Request password reset
   */
  async requestPasswordReset(email: string): Promise<string> {
    const user = await userRepository.findByEmail(email);
    
    if (!user) {
      // Don't reveal that user doesn't exist
      return 'reset_token_placeholder';
    }

    // Generate reset token
    const resetToken = uuidv4();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    // Store in Redis
    await redis.set(
      `password_reset:${resetToken}`,
      JSON.stringify({
        user_id: user.id,
        email: user.email,
      }),
      3600 // 1 hour
    );

    return resetToken;
  }

  /**
   * Reset password with token
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    // Get token data
    const data = await redis.get(`password_reset:${token}`);
    if (!data) {
      throw new Error('Invalid or expired reset token');
    }

    const { user_id } = JSON.parse(data);

    // Update password
    const saltRounds = 10;
    const newHash = await bcrypt.hash(newPassword, saltRounds);
    
    await userRepository.updatePassword(user_id, newHash);
    await userRepository.addToPasswordHistory(user_id, newHash);

    // Delete token
    await redis.del(`password_reset:${token}`);

    // Logout all sessions
    await sessionRepository.deactivateAllUserSessions(user_id);
  }

  /**
   * Verify email
   */
  async verifyEmail(userId: string): Promise<void> {
    await userRepository.update(userId, { email_verified: true });
  }

  /**
   * Check permissions
   */
  async checkPermission(
    userId: string,
    permission: string
  ): Promise<boolean> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      return false;
    }

    // Super admin has all permissions
    if (user.role === 'super_admin') {
      return true;
    }

    // Get user permissions
    const permissions = await userRepository.getPermissions(userId);
    
    return permissions.includes(permission) || permissions.includes('*');
  }

  /**
   * Sanitize user object (remove sensitive data)
   */
  private sanitizeUser(user: any): any {
    const sanitized = { ...user };
    delete sanitized.password_hash;
    delete sanitized.mfa_secret;
    delete sanitized.mfa_backup_codes;
    delete sanitized.password_history;
    return sanitized;
  }
}

export const authService = new AuthService();
