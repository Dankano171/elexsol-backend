import { BaseRepository } from './BaseRepository';
import { User } from '../models/User';
import { db } from '../config/database';
import { logger } from '../config/logger';
import bcrypt from 'bcrypt';

export class UserRepository extends BaseRepository<User> {
  protected tableName = 'users';
  protected primaryKey = 'id';

  /**
   * Find by email
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.findOne({ email: email.toLowerCase() });
  }

  /**
   * Find by business with role filter
   */
  async findByBusiness(
    businessId: string,
    role?: string,
    options?: { limit?: number; offset?: number }
  ): Promise<User[]> {
    const conditions: any = { business_id: businessId };
    if (role) {
      conditions.role = role;
    }
    return this.find(conditions, {
      orderBy: 'created_at',
      orderDir: 'DESC',
      ...options,
    });
  }

  /**
   * Find admins for business
   */
  async findAdmins(businessId: string): Promise<User[]> {
    const query = `
      SELECT * FROM users
      WHERE business_id = $1
        AND role IN ('admin', 'owner')
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
    return this.executeQuery<User>(query, [businessId]);
  }

  /**
   * Search users
   */
  async search(
    query: string,
    businessId?: string,
    limit: number = 20
  ): Promise<User[]> {
    let sql = `
      SELECT * FROM users
      WHERE (
        email ILIKE $1
        OR first_name ILIKE $1
        OR last_name ILIKE $1
        OR phone ILIKE $1
      )
    `;
    const params: any[] = [`%${query}%`];

    if (businessId) {
      sql += ` AND business_id = $2`;
      params.push(businessId);
    }

    sql += ` AND deleted_at IS NULL
             ORDER BY 
               CASE 
                 WHEN email ILIKE $1 THEN 1
                 WHEN first_name ILIKE $1 THEN 2
                 WHEN last_name ILIKE $1 THEN 3
                 ELSE 4
               END,
               created_at DESC
             LIMIT $${params.length + 1}`;
    
    params.push(limit);

    return this.executeQuery<User>(sql, params);
  }

  /**
   * Get active users count
   */
  async getActiveCount(businessId?: string): Promise<number> {
    const conditions: any = { deleted_at: null };
    if (businessId) {
      conditions.business_id = businessId;
    }
    return this.count(conditions);
  }

  /**
   * Get users by last login
   */
  async findByLastLogin(
    days: number = 30,
    businessId?: string
  ): Promise<User[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    let sql = `
      SELECT * FROM users
      WHERE last_login_at >= $1
        AND deleted_at IS NULL
    `;
    const params: any[] = [cutoff];

    if (businessId) {
      sql += ` AND business_id = $2`;
      params.push(businessId);
    }

    sql += ` ORDER BY last_login_at DESC`;

    return this.executeQuery<User>(sql, params);
  }

  /**
   * Get locked users
   */
  async getLockedUsers(businessId?: string): Promise<User[]> {
    const conditions: any = {
      locked_until: { $gt: new Date() },
    };
    if (businessId) {
      conditions.business_id = businessId;
    }
    return this.find(conditions);
  }

  /**
   * Update last login
   */
  async updateLastLogin(userId: string, ip?: string): Promise<void> {
    await this.update(userId, {
      last_login_at: new Date(),
      last_login_ip: ip,
      login_attempts: 0,
      locked_until: null,
    });
  }

  /**
   * Increment login attempts
   */
  async incrementLoginAttempts(userId: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) return;

    const attempts = (user.login_attempts || 0) + 1;
    const updates: any = { login_attempts: attempts };

    // Lock after 5 attempts
    if (attempts >= 5) {
      updates.locked_until = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    }

    await this.update(userId, updates);
  }

  /**
   * Reset login attempts
   */
  async resetLoginAttempts(userId: string): Promise<void> {
    await this.update(userId, {
      login_attempts: 0,
      locked_until: null,
    });
  }

  /**
   * Update password
   */
  async updatePassword(
    userId: string,
    newPassword: string
  ): Promise<void> {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(newPassword, saltRounds);

    await this.update(userId, {
      password_hash,
      password_changed_at: new Date(),
    });
  }

  /**
   * Add to password history
   */
  async addToPasswordHistory(
    userId: string,
    passwordHash: string
  ): Promise<void> {
    const user = await this.findById(userId);
    if (!user) return;

    const history = [...(user.password_history || []), passwordHash].slice(-10);

    await this.update(userId, {
      password_history: history,
    });
  }

  /**
   * Check if password was used before
   */
  async isPasswordReused(
    userId: string,
    newPassword: string
  ): Promise<boolean> {
    const user = await this.findById(userId);
    if (!user || !user.password_history) return false;

    for (const oldHash of user.password_history) {
      const isMatch = await bcrypt.compare(newPassword, oldHash);
      if (isMatch) return true;
    }

    return false;
  }

  /**
   * Update MFA settings
   */
  async updateMFA(
    userId: string,
    secret: string,
    backupCodes: string[]
  ): Promise<void> {
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    await this.update(userId, {
      mfa_enabled: true,
      mfa_secret: secret,
      mfa_backup_codes: hashedBackupCodes,
    });
  }

  /**
   * Disable MFA
   */
  async disableMFA(userId: string): Promise<void> {
    await this.update(userId, {
      mfa_enabled: false,
      mfa_secret: null,
      mfa_backup_codes: null,
    });
  }

  /**
   * Verify MFA backup code
   */
  async verifyBackupCode(userId: string, code: string): Promise<boolean> {
    const user = await this.findById(userId);
    if (!user || !user.mfa_backup_codes) return false;

    for (let i = 0; i < user.mfa_backup_codes.length; i++) {
      const isValid = await bcrypt.compare(code, user.mfa_backup_codes[i]);
      if (isValid) {
        // Remove used code
        const remainingCodes = [...user.mfa_backup_codes];
        remainingCodes.splice(i, 1);
        await this.update(userId, { mfa_backup_codes: remainingCodes });
        return true;
      }
    }

    return false;
  }

  /**
   * Update notification preferences
   */
  async updateNotificationPreferences(
    userId: string,
    preferences: User['notification_preferences']
  ): Promise<void> {
    await this.update(userId, {
      notification_preferences: preferences,
    });
  }

  /**
   * Get users by permission
   */
  async findByPermission(
    permission: string,
    businessId?: string
  ): Promise<User[]> {
    let sql = `
      SELECT * FROM users
      WHERE (
        permissions @> $1::jsonb
        OR role = 'super_admin'
        OR (role = 'admin' AND $1 = ANY(ARRAY['business:*', 'user:*']))
      )
    `;
    const params: any[] = [JSON.stringify([permission])];

    if (businessId) {
      sql += ` AND business_id = $2`;
      params.push(businessId);
    }

    sql += ` AND deleted_at IS NULL`;

    return this.executeQuery<User>(sql, params);
  }

  /**
   * Get user statistics
   */
  async getUserStatistics(businessId?: string): Promise<any> {
    let sql = `
      SELECT
        role,
        COUNT(*) as count,
        COUNT(CASE WHEN last_login_at >= NOW() - INTERVAL '30 days' THEN 1 END) as active_30d,
        COUNT(CASE WHEN mfa_enabled THEN 1 END) as mfa_enabled,
        AVG(login_attempts) as avg_login_attempts
      FROM users
      WHERE deleted_at IS NULL
    `;
    const params: any[] = [];

    if (businessId) {
      sql += ` AND business_id = $1`;
      params.push(businessId);
    }

    sql += ` GROUP BY role`;

    return this.executeQuery(sql, params);
  }
}

export const userRepository = new UserRepository();
