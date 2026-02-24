import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';

export interface Session extends BaseEntity {
  user_id: string;
  business_id?: string;
  session_token: string;
  refresh_token?: string;
  ip_address?: string;
  user_agent?: string;
  device_id?: string;
  device_name?: string;
  location?: string;
  expires_at: Date;
  refresh_expires_at?: Date;
  last_activity_at: Date;
  is_active: boolean;
  mfa_verified: boolean;
  mfa_verified_at?: Date;
  impersonated_by?: string; // User ID if this is an impersonation session
  metadata: Record<string, any>;
}

export interface CreateSessionDTO {
  user_id: string;
  business_id?: string;
  session_token: string;
  refresh_token?: string;
  ip_address?: string;
  user_agent?: string;
  device_id?: string;
  device_name?: string;
  location?: string;
  expires_in: number; // seconds
  refresh_expires_in?: number; // seconds
  mfa_verified?: boolean;
  metadata?: Record<string, any>;
}

export class SessionModel extends BaseModel<Session> {
  protected tableName = 'sessions';
  protected primaryKey = 'id';

  /**
   * Create a new session
   */
  async createSession(data: CreateSessionDTO): Promise<Session> {
    const now = new Date();
    const expires_at = new Date(now.getTime() + data.expires_in * 1000);
    const refresh_expires_at = data.refresh_expires_in 
      ? new Date(now.getTime() + data.refresh_expires_in * 1000)
      : undefined;

    return this.create({
      user_id: data.user_id,
      business_id: data.business_id,
      session_token: data.session_token,
      refresh_token: data.refresh_token,
      ip_address: data.ip_address,
      user_agent: data.user_agent,
      device_id: data.device_id,
      device_name: data.device_name,
      location: data.location,
      expires_at,
      refresh_expires_at,
      last_activity_at: now,
      is_active: true,
      mfa_verified: data.mfa_verified || false,
      mfa_verified_at: data.mfa_verified ? now : undefined,
      metadata: data.metadata || {},
    });
  }

  /**
   * Validate session token
   */
  async validateSession(sessionToken: string): Promise<Session | null> {
    const session = await this.findOne({ 
      session_token: sessionToken,
      is_active: true,
    });

    if (!session) {
      return null;
    }

    // Check if expired
    if (session.expires_at < new Date()) {
      await this.deactivate(session.id, 'expired');
      return null;
    }

    // Update last activity
    await this.update(session.id, {
      last_activity_at: new Date(),
    });

    return session;
  }

  /**
   * Validate refresh token
   */
  async validateRefreshToken(refreshToken: string): Promise<Session | null> {
    const session = await this.findOne({ 
      refresh_token: refreshToken,
      is_active: true,
    });

    if (!session) {
      return null;
    }

    // Check if refresh token expired
    if (session.refresh_expires_at && session.refresh_expires_at < new Date()) {
      await this.deactivate(session.id, 'refresh_expired');
      return null;
    }

    return session;
  }

  /**
   * Refresh session
   */
  async refreshSession(
    sessionId: string,
    newSessionToken: string,
    expiresIn: number
  ): Promise<Session | null> {
    const expires_at = new Date(Date.now() + expiresIn * 1000);

    return this.update(sessionId, {
      session_token: newSessionToken,
      expires_at,
      last_activity_at: new Date(),
    });
  }

  /**
   * Deactivate session
   */
  async deactivate(id: string, reason?: string): Promise<boolean> {
    const session = await this.findById(id);
    
    if (!session) {
      return false;
    }

    await this.update(id, {
      is_active: false,
      metadata: {
        ...session.metadata,
        deactivated_at: new Date(),
        deactivation_reason: reason,
      },
    });

    return true;
  }

  /**
   * Deactivate all user sessions
   */
  async deactivateAllUserSessions(
    userId: string,
    excludeSessionId?: string
  ): Promise<number> {
    let query = `
      UPDATE sessions
      SET is_active = false,
          metadata = metadata || jsonb_build_object('deactivated_at', NOW())
      WHERE user_id = $1
        AND is_active = true
    `;

    const params: any[] = [userId];

    if (excludeSessionId) {
      query += ` AND id != $2`;
      params.push(excludeSessionId);
    }

    const result = await db.query(query, params);
    return result.rowCount || 0;
  }

  /**
   * Get active sessions for user
   */
  async getUserActiveSessions(userId: string): Promise<Session[]> {
    return this.find({
      user_id: userId,
      is_active: true,
    }, {
      orderBy: 'last_activity_at',
      orderDir: 'DESC',
    });
  }

  /**
   * Get sessions by device
   */
  async getByDevice(deviceId: string): Promise<Session[]> {
    return this.find({ device_id: deviceId, is_active: true });
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpired(): Promise<number> {
    const query = `
      UPDATE sessions
      SET is_active = false,
          metadata = metadata || jsonb_build_object(
            'cleanup_reason', 'expired',
            'cleanup_at', NOW()
          )
      WHERE (expires_at < NOW() OR refresh_expires_at < NOW())
        AND is_active = true
      RETURNING id
    `;

    const result = await db.query(query);
    return result.rowCount || 0;
  }

  /**
   * Get session statistics
   */
  async getStatistics(businessId?: string): Promise<any> {
    let whereClause = 'WHERE is_active = true';
    const params: any[] = [];

    if (businessId) {
      whereClause += ' AND business_id = $1';
      params.push(businessId);
    }

    const query = `
      SELECT
        COUNT(*) as active_sessions,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT device_id) as unique_devices,
        AVG(EXTRACT(EPOCH FROM (expires_at - created_at)) / 3600) as avg_session_hours,
        MAX(last_activity_at) as most_recent_activity
      FROM sessions
      ${whereClause}
    `;

    const result = await db.query(query, params);
    return result.rows[0];
  }

  /**
   * Mark MFA as verified
   */
  async verifyMFA(id: string): Promise<Session | null> {
    return this.update(id, {
      mfa_verified: true,
      mfa_verified_at: new Date(),
    });
  }

  /**
   * Create impersonation session
   */
  async createImpersonation(
    adminUserId: string,
    targetUserId: string,
    targetBusinessId: string,
    data: Partial<CreateSessionDTO>
  ): Promise<Session> {
    return this.create({
      user_id: targetUserId,
      business_id: targetBusinessId,
      session_token: data.session_token!,
      refresh_token: data.refresh_token,
      ip_address: data.ip_address,
      user_agent: data.user_agent,
      device_id: data.device_id,
      device_name: data.device_name,
      location: data.location,
      expires_at: new Date(Date.now() + 3600 * 1000), // 1 hour
      last_activity_at: new Date(),
      is_active: true,
      mfa_verified: true,
      impersonated_by: adminUserId,
      metadata: {
        ...data.metadata,
        is_impersonation: true,
        impersonated_at: new Date(),
      },
    });
  }

  /**
   * Get active impersonation sessions
   */
  async getActiveImpersonations(adminUserId: string): Promise<Session[]> {
    return this.find({
      impersonated_by: adminUserId,
      is_active: true,
    });
  }

  /**
   * Terminate impersonation
   */
  async terminateImpersonation(sessionId: string): Promise<boolean> {
    return this.deactivate(sessionId, 'impersonation_ended');
  }

  /**
   * Get sessions by IP
   */
  async getByIP(ipAddress: string, businessId?: string): Promise<Session[]> {
    const where: any = { 
      ip_address: ipAddress,
      is_active: true,
    };
    
    if (businessId) {
      where.business_id = businessId;
    }

    return this.find(where);
  }
}

export const sessionModel = new SessionModel();
