import { redis } from '../../config/redis';
import { sessionRepository } from '../../repositories/SessionRepository';
import { logger } from '../../config/logger';
import { v4 as uuidv4 } from 'uuid';
import UAParser from 'ua-parser-js';

export interface SessionInfo {
  id: string;
  userId: string;
  businessId: string;
  createdAt: Date;
  lastActivity: Date;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  deviceInfo?: {
    browser?: string;
    os?: string;
    device?: string;
  };
  location?: string;
  isCurrent: boolean;
}

export class SessionService {
  private readonly sessionPrefix = 'session:';
  private readonly userSessionsPrefix = 'user_sessions:';

  /**
   * Create session
   */
  async createSession(
    userId: string,
    businessId: string,
    ipAddress?: string,
    userAgent?: string,
    metadata: any = {}
  ): Promise<string> {
    const sessionId = uuidv4();
    const parser = new UAParser(userAgent);
    const deviceInfo = parser.getResult();

    const sessionData = {
      id: sessionId,
      user_id: userId,
      business_id: businessId,
      created_at: new Date().toISOString(),
      last_activity: new Date().toISOString(),
      ip_address: ipAddress,
      user_agent: userAgent,
      device_info: {
        browser: `${deviceInfo.browser.name || 'Unknown'} ${deviceInfo.browser.version || ''}`,
        os: `${deviceInfo.os.name || 'Unknown'} ${deviceInfo.os.version || ''}`,
        device: deviceInfo.device.type || 'desktop',
        model: deviceInfo.device.model,
      },
      ...metadata,
    };

    // Store in Redis
    await redis.setex(
      `${this.sessionPrefix}${sessionId}`,
      7 * 24 * 60 * 60, // 7 days
      JSON.stringify(sessionData)
    );

    // Add to user's session list
    await redis.sadd(
      `${this.userSessionsPrefix}${userId}`,
      sessionId
    );

    return sessionId;
  }

  /**
   * Get session
   */
  async getSession(sessionId: string): Promise<any | null> {
    const data = await redis.get(`${this.sessionPrefix}${sessionId}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Update session activity
   */
  async updateActivity(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    
    if (session) {
      session.last_activity = new Date().toISOString();
      await redis.setex(
        `${this.sessionPrefix}${sessionId}`,
        7 * 24 * 60 * 60,
        JSON.stringify(session)
      );
    }
  }

  /**
   * Destroy session
   */
  async destroySession(sessionId: string, userId?: string): Promise<void> {
    const session = await this.getSession(sessionId);
    
    if (session) {
      await redis.del(`${this.sessionPrefix}${sessionId}`);
      
      if (session.user_id) {
        await redis.srem(`${this.userSessionsPrefix}${session.user_id}`, sessionId);
      }
    }
  }

  /**
   * Destroy all user sessions
   */
  async destroyAllUserSessions(userId: string, excludeSessionId?: string): Promise<number> {
    const sessionIds = await redis.smembers(`${this.userSessionsPrefix}${userId}`);
    let count = 0;

    for (const sessionId of sessionIds) {
      if (sessionId !== excludeSessionId) {
        await this.destroySession(sessionId);
        count++;
      }
    }

    return count;
  }

  /**
   * Get user sessions
   */
  async getUserSessions(userId: string, currentSessionId?: string): Promise<SessionInfo[]> {
    const sessionIds = await redis.smembers(`${this.userSessionsPrefix}${userId}`);
    const sessions: SessionInfo[] = [];

    for (const sessionId of sessionIds) {
      const session = await this.getSession(sessionId);
      if (session) {
        sessions.push({
          id: sessionId,
          userId: session.user_id,
          businessId: session.business_id,
          createdAt: new Date(session.created_at),
          lastActivity: new Date(session.last_activity),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          ipAddress: session.ip_address,
          userAgent: session.user_agent,
          deviceInfo: session.device_info,
          location: session.location,
          isCurrent: sessionId === currentSessionId,
        });
      }
    }

    return sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    // Redis handles TTL automatically
    // This method is for cleaning up user session sets
    let cleaned = 0;

    // Get all user session keys
    const keys = await redis.keys(`${this.userSessionsPrefix}*`);
    
    for (const key of keys) {
      const userId = key.replace(this.userSessionsPrefix, '');
      const sessionIds = await redis.smembers(key);
      
      for (const sessionId of sessionIds) {
        const exists = await redis.exists(`${this.sessionPrefix}${sessionId}`);
        if (!exists) {
          await redis.srem(key, sessionId);
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  /**
   * Get session count
   */
  async getSessionCount(userId?: string): Promise<number> {
    if (userId) {
      return redis.scard(`${this.userSessionsPrefix}${userId}`);
    }

    // Count all sessions
    const keys = await redis.keys(`${this.sessionPrefix}*`);
    return keys.length;
  }

  /**
   * Touch session (extend expiry)
   */
  async touchSession(sessionId: string, ttlSeconds: number = 7 * 24 * 60 * 60): Promise<void> {
    await redis.expire(`${this.sessionPrefix}${sessionId}`, ttlSeconds);
  }

  /**
   * Get session metadata
   */
  async getSessionMetadata(sessionId: string, key: string): Promise<any> {
    const session = await this.getSession(sessionId);
    return session?.metadata?.[key];
  }

  /**
   * Update session metadata
   */
  async updateSessionMetadata(
    sessionId: string,
    key: string,
    value: any
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    
    if (session) {
      session.metadata = {
        ...session.metadata,
        [key]: value,
      };
      await redis.setex(
        `${this.sessionPrefix}${sessionId}`,
        7 * 24 * 60 * 60,
        JSON.stringify(session)
      );
    }
  }

  /**
   * Validate session
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const exists = await redis.exists(`${this.sessionPrefix}${sessionId}`);
    return exists === 1;
  }

  /**
   * Get active sessions count for business
   */
  async getBusinessActiveSessions(businessId: string): Promise<number> {
    let count = 0;
    const keys = await redis.keys(`${this.sessionPrefix}*`);
    
    for (const key of keys) {
      const session = await this.getSession(key.replace(this.sessionPrefix, ''));
      if (session && session.business_id === businessId) {
        count++;
      }
    }

    return count;
  }
}

export const sessionService = new SessionService();
