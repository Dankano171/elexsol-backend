import jwt from 'jsonwebtoken';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { v4 as uuidv4 } from 'uuid';

export interface TokenPayload {
  sub: string;
  business_id?: string;
  session_id?: string;
  type: 'access' | 'refresh' | 'api' | 'email_verification' | 'password_reset';
  permissions?: string[];
}

export interface TokenResponse {
  token: string;
  expiresAt: Date;
  tokenType: string;
}

export class TokenService {
  private readonly accessTokenExpiry = 15 * 60; // 15 minutes
  private readonly refreshTokenExpiry = 7 * 24 * 60 * 60; // 7 days
  private readonly apiTokenExpiry = 365 * 24 * 60 * 60; // 1 year
  private readonly emailTokenExpiry = 24 * 60 * 60; // 24 hours
  private readonly resetTokenExpiry = 60 * 60; // 1 hour

  /**
   * Generate access token
   */
  generateAccessToken(
    userId: string,
    businessId?: string,
    sessionId?: string
  ): TokenResponse {
    const payload: TokenPayload = {
      sub: userId,
      business_id: businessId,
      session_id: sessionId,
      type: 'access',
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET!, {
      expiresIn: this.accessTokenExpiry,
      jwtid: uuidv4(),
    });

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + this.accessTokenExpiry);

    return {
      token,
      expiresAt,
      tokenType: 'Bearer',
    };
  }

  /**
   * Generate refresh token
   */
  generateRefreshToken(userId: string, sessionId: string): TokenResponse {
    const payload: TokenPayload = {
      sub: userId,
      session_id: sessionId,
      type: 'refresh',
    };

    const token = jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, {
      expiresIn: this.refreshTokenExpiry,
      jwtid: uuidv4(),
    });

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + this.refreshTokenExpiry);

    return {
      token,
      expiresAt,
      tokenType: 'Bearer',
    };
  }

  /**
   * Generate API token
   */
  generateApiToken(
    userId: string,
    businessId: string,
    permissions: string[] = []
  ): TokenResponse {
    const payload: TokenPayload = {
      sub: userId,
      business_id: businessId,
      type: 'api',
      permissions,
    };

    const token = jwt.sign(payload, process.env.JWT_API_SECRET!, {
      expiresIn: this.apiTokenExpiry,
      jwtid: uuidv4(),
    });

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + this.apiTokenExpiry);

    return {
      token,
      expiresAt,
      tokenType: 'Bearer',
    };
  }

  /**
   * Generate email verification token
   */
  generateEmailVerificationToken(userId: string, email: string): TokenResponse {
    const payload: TokenPayload = {
      sub: userId,
      type: 'email_verification',
    };

    const token = jwt.sign(payload, process.env.JWT_EMAIL_SECRET! + email, {
      expiresIn: this.emailTokenExpiry,
      jwtid: uuidv4(),
    });

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + this.emailTokenExpiry);

    return {
      token,
      expiresAt,
      tokenType: 'Bearer',
    };
  }

  /**
   * Generate password reset token
   */
  generatePasswordResetToken(userId: string, email: string): TokenResponse {
    const payload: TokenPayload = {
      sub: userId,
      type: 'password_reset',
    };

    const token = jwt.sign(payload, process.env.JWT_RESET_SECRET! + email, {
      expiresIn: this.resetTokenExpiry,
      jwtid: uuidv4(),
    });

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + this.resetTokenExpiry);

    return {
      token,
      expiresAt,
      tokenType: 'Bearer',
    };
  }

  /**
   * Verify access token
   */
  verifyAccessToken(token: string): TokenPayload {
    try {
      return jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
    } catch (error) {
      throw new Error('Invalid or expired access token');
    }
  }

  /**
   * Verify refresh token
   */
  verifyRefreshToken(token: string): TokenPayload {
    try {
      return jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as TokenPayload;
    } catch (error) {
      throw new Error('Invalid or expired refresh token');
    }
  }

  /**
   * Verify API token
   */
  verifyApiToken(token: string): TokenPayload {
    try {
      return jwt.verify(token, process.env.JWT_API_SECRET!) as TokenPayload;
    } catch (error) {
      throw new Error('Invalid or expired API token');
    }
  }

  /**
   * Verify email token
   */
  verifyEmailToken(token: string, email: string): TokenPayload {
    try {
      return jwt.verify(token, process.env.JWT_EMAIL_SECRET! + email) as TokenPayload;
    } catch (error) {
      throw new Error('Invalid or expired email verification token');
    }
  }

  /**
   * Verify password reset token
   */
  verifyPasswordResetToken(token: string, email: string): TokenPayload {
    try {
      return jwt.verify(token, process.env.JWT_RESET_SECRET! + email) as TokenPayload;
    } catch (error) {
      throw new Error('Invalid or expired password reset token');
    }
  }

  /**
   * Decode token without verification
   */
  decodeToken(token: string): TokenPayload | null {
    try {
      return jwt.decode(token) as TokenPayload;
    } catch {
      return null;
    }
  }

  /**
   * Blacklist token
   */
  async blacklistToken(token: string, expiresIn: number): Promise<void> {
    const tokenHash = this.hashToken(token);
    await redis.setex(`blacklist:${tokenHash}`, expiresIn, 'true');
  }

  /**
   * Check if token is blacklisted
   */
  async isTokenBlacklisted(token: string): Promise<boolean> {
    const tokenHash = this.hashToken(token);
    const result = await redis.get(`blacklist:${tokenHash}`);
    return !!result;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const payload = this.verifyRefreshToken(refreshToken);
    
    if (!payload.session_id) {
      throw new Error('Invalid refresh token payload');
    }

    // Check if session exists and is active
    const session = await redis.get(`session:${payload.session_id}`);
    if (!session) {
      throw new Error('Session not found or expired');
    }

    return this.generateAccessToken(
      payload.sub,
      JSON.parse(session).business_id,
      payload.session_id
    );
  }

  /**
   * Create session token
   */
  async createSessionToken(
    userId: string,
    businessId: string,
    metadata: any = {}
  ): Promise<string> {
    const sessionId = uuidv4();
    const sessionData = {
      user_id: userId,
      business_id: businessId,
      created_at: new Date().toISOString(),
      ...metadata,
    };

    await redis.setex(
      `session:${sessionId}`,
      this.refreshTokenExpiry,
      JSON.stringify(sessionData)
    );

    return sessionId;
  }

  /**
   * Get session data
   */
  async getSession(sessionId: string): Promise<any | null> {
    const data = await redis.get(`session:${sessionId}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Destroy session
   */
  async destroySession(sessionId: string): Promise<void> {
    await redis.del(`session:${sessionId}`);
  }

  /**
   * Hash token for blacklisting
   */
  private hashToken(token: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generate random token
   */
  generateRandomToken(length: number = 32): string {
    const crypto = require('crypto');
    return crypto.randomBytes(length).toString('hex');
  }
}

export const tokenService = new TokenService();
