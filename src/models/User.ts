import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

export interface User extends BaseEntity {
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  phone?: string;
  business_id: string;
  role: 'super_admin' | 'admin' | 'owner' | 'manager' | 'staff';
  permissions: string[];
  mfa_enabled: boolean;
  mfa_secret?: string;
  mfa_backup_codes?: string[];
  email_verified: boolean;
  phone_verified: boolean;
  last_login_at?: Date;
  last_login_ip?: string;
  login_attempts: number;
  locked_until?: Date;
  password_changed_at: Date;
  password_history: string[];
  notification_preferences: {
    email: boolean;
    sms: boolean;
    push: boolean;
    digest: 'daily' | 'weekly' | 'monthly' | 'never';
    types: string[];
  };
  settings: Record<string, any>;
  metadata: Record<string, any>;
  created_by?: string;
  updated_by?: string;
}

export interface CreateUserDTO {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  phone?: string;
  business_id: string;
  role?: User['role'];
  permissions?: string[];
}

export interface UpdateUserDTO {
  first_name?: string;
  last_name?: string;
  phone?: string;
  role?: User['role'];
  permissions?: string[];
  notification_preferences?: Partial<User['notification_preferences']>;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
}

export class UserModel extends BaseModel<User> {
  protected tableName = 'users';
  protected primaryKey = 'id';

  /**
   * Create a new user with password hashing
   */
  async createUser(data: CreateUserDTO, createdBy?: string): Promise<User> {
    const client = await this.beginTransaction();
    
    try {
      // Check if email exists
      const existing = await this.findByEmail(data.email);
      if (existing) {
        throw new Error('Email already registered');
      }

      // Hash password
      const saltRounds = 10;
      const password_hash = await bcrypt.hash(data.password, saltRounds);

      // Create user
      const user = await this.create({
        email: data.email.toLowerCase(),
        password_hash,
        first_name: data.first_name,
        last_name: data.last_name,
        phone: data.phone,
        business_id: data.business_id,
        role: data.role || 'staff',
        permissions: data.permissions || [],
        mfa_enabled: false,
        email_verified: false,
        phone_verified: false,
        login_attempts: 0,
        password_changed_at: new Date(),
        password_history: [password_hash],
        notification_preferences: {
          email: true,
          sms: false,
          push: false,
          digest: 'daily',
          types: ['success', 'action_required', 'integration', 'regulatory'],
        },
        settings: {},
        metadata: {},
        created_by: createdBy,
        updated_by: createdBy,
      }, client);

      await this.commitTransaction(client);
      
      // Remove sensitive data
      delete (user as any).password_hash;
      delete (user as any).mfa_secret;
      delete (user as any).mfa_backup_codes;
      delete (user as any).password_history;
      
      return user;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in UserModel.createUser:', error);
      throw error;
    }
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.findOne({ email: email.toLowerCase() });
  }

  /**
   * Find users by business
   */
  async findByBusiness(businessId: string, options?: { role?: string }): Promise<User[]> {
    const where: any = { business_id: businessId };
    if (options?.role) {
      where.role = options.role;
    }
    return this.find(where);
  }

  /**
   * Authenticate user
   */
  async authenticate(email: string, password: string, ip?: string): Promise<User | null> {
    const client = await this.beginTransaction();
    
    try {
      const user = await this.findByEmail(email);
      
      if (!user) {
        return null;
      }

      // Check if account is locked
      if (user.locked_until && user.locked_until > new Date()) {
        throw new Error('Account is locked. Try again later.');
      }

      // Verify password
      const isValid = await bcrypt.compare(password, user.password_hash);
      
      if (!isValid) {
        // Increment login attempts
        const attempts = user.login_attempts + 1;
        const updates: any = { login_attempts: attempts };
        
        // Lock account after 5 failed attempts
        if (attempts >= 5) {
          updates.locked_until = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
        }
        
        await this.update(user.id, updates, client);
        await this.commitTransaction(client);
        
        return null;
      }

      // Successful login - reset attempts and update last login
      await this.update(user.id, {
        login_attempts: 0,
        locked_until: null,
        last_login_at: new Date(),
        last_login_ip: ip,
      }, client);

      await this.commitTransaction(client);
      
      // Remove sensitive data
      delete (user as any).password_hash;
      delete (user as any).mfa_secret;
      delete (user as any).mfa_backup_codes;
      delete (user as any).password_history;
      
      return user;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in UserModel.authenticate:', error);
      throw error;
    }
  }

  /**
   * Change password
   */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const client = await this.beginTransaction();
    
    try {
      const user = await this.findById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }

      // Verify old password
      const isValid = await bcrypt.compare(oldPassword, user.password_hash);
      
      if (!isValid) {
        return false;
      }

      // Check password history (don't reuse last 5 passwords)
      for (const oldHash of user.password_history.slice(-5)) {
        const isReused = await bcrypt.compare(newPassword, oldHash);
        if (isReused) {
          throw new Error('Cannot reuse a recent password');
        }
      }

      // Hash new password
      const saltRounds = 10;
      const newHash = await bcrypt.hash(newPassword, saltRounds);

      // Update password
      const passwordHistory = [...(user.password_history || []), newHash].slice(-10);
      
      await this.update(userId, {
        password_hash: newHash,
        password_history: passwordHistory,
        password_changed_at: new Date(),
      }, client);

      await this.commitTransaction(client);
      
      return true;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in UserModel.changePassword:', error);
      throw error;
    }
  }

  /**
   * Enable MFA
   */
  async enableMFA(userId: string, secret: string, backupCodes: string[]): Promise<User> {
    const user = await this.update(userId, {
      mfa_enabled: true,
      mfa_secret: secret,
      mfa_backup_codes: backupCodes.map(code => bcrypt.hashSync(code, 10)), // Hash backup codes
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Remove sensitive data
    delete (user as any).password_hash;
    delete (user as any).password_history;
    
    return user;
  }

  /**
   * Disable MFA
   */
  async disableMFA(userId: string): Promise<User> {
    const user = await this.update(userId, {
      mfa_enabled: false,
      mfa_secret: null,
      mfa_backup_codes: null,
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Remove sensitive data
    delete (user as any).password_hash;
    delete (user as any).password_history;
    
    return user;
  }

  /**
   * Verify MFA code
   */
  async verifyMFA(userId: string, code: string): Promise<boolean> {
    const user = await this.findById(userId);
    
    if (!user || !user.mfa_enabled || !user.mfa_secret) {
      return false;
    }

    // Check if it's a backup code
    if (user.mfa_backup_codes) {
      for (const hashedCode of user.mfa_backup_codes) {
        const isValid = await bcrypt.compare(code, hashedCode);
        if (isValid) {
          // Remove used backup code
          const remainingCodes = user.mfa_backup_codes.filter(c => c !== hashedCode);
          await this.update(userId, { mfa_backup_codes: remainingCodes });
          return true;
        }
      }
    }

    // Verify TOTP
    const speakeasy = require('speakeasy');
    const verified = speakeasy.totp.verify({
      secret: user.mfa_secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    return verified;
  }

  /**
   * Verify email
   */
  async verifyEmail(userId: string): Promise<User> {
    const user = await this.update(userId, {
      email_verified: true,
    });

    if (!user) {
      throw new Error('User not found');
    }

    return user;
  }

  /**
   * Update notification preferences
   */
  async updateNotificationPreferences(
    userId: string,
    preferences: Partial<User['notification_preferences']>
  ): Promise<User> {
    const user = await this.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    const updated = await this.update(userId, {
      notification_preferences: {
        ...user.notification_preferences,
        ...preferences,
      },
    });

    return updated!;
  }

  /**
   * Get users by role
   */
  async getByRole(role: User['role'], businessId?: string): Promise<User[]> {
    const where: any = { role };
    if (businessId) {
      where.business_id = businessId;
    }
    return this.find(where);
  }

  /**
   * Search users
   */
  async search(query: string, businessId?: string): Promise<User[]> {
    const searchQuery = `
      SELECT * FROM users
      WHERE (email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1 OR phone ILIKE $1)
        ${businessId ? 'AND business_id = $2' : ''}
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 20
    `;

    const params = [`%${query}%`];
    if (businessId) {
      params.push(businessId);
    }

    const result = await db.query(searchQuery, params);
    return result.rows;
  }

  /**
   * Get admins for business
   */
  async getBusinessAdmins(businessId: string): Promise<User[]> {
    return this.find({
      business_id: businessId,
      role: ['admin', 'owner'],
    });
  }

  /**
   * Get user permissions
   */
  async getPermissions(userId: string): Promise<string[]> {
    const user = await this.findById(userId);
    
    if (!user) {
      return [];
    }

    // Base permissions by role
    const rolePermissions: Record<string, string[]> = {
      super_admin: ['*'],
      admin: ['business:*', 'user:*', 'invoice:*', 'integration:*', 'report:*'],
      owner: ['business:read', 'business:write', 'invoice:*', 'integration:*', 'report:*'],
      manager: ['invoice:*', 'integration:read', 'report:read'],
      staff: ['invoice:create', 'invoice:read', 'invoice:update'],
    };

    const basePermissions = rolePermissions[user.role] || [];
    
    // Combine with custom permissions
    return [...new Set([...basePermissions, ...(user.permissions || [])])];
  }

  /**
   * Check if user has permission
   */
  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const permissions = await this.getPermissions(userId);
    
    if (permissions.includes('*')) {
      return true;
    }

    // Check for wildcard matches (e.g., 'invoice:*' matches 'invoice:create')
    for (const p of permissions) {
      if (p.endsWith(':*')) {
        const prefix = p.replace(':*', '');
        if (permission.startsWith(prefix)) {
          return true;
        }
      }
    }

    return permissions.includes(permission);
  }

  /**
   * Get active users count
   */
  async getActiveCount(businessId?: string): Promise<number> {
    const where: any = {
      deleted_at: null,
    };
    
    if (businessId) {
      where.business_id = businessId;
    }

    return this.count(where);
  }

  /**
   * Get users by last login
   */
  async getRecentActive(days: number = 30, businessId?: string): Promise<User[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const query = `
      SELECT * FROM users
      WHERE last_login_at >= $1
        ${businessId ? 'AND business_id = $2' : ''}
        AND deleted_at IS NULL
      ORDER BY last_login_at DESC
    `;

    const params: any[] = [cutoff];
    if (businessId) {
      params.push(businessId);
    }

    const result = await db.query(query, params);
    return result.rows;
  }
}

export const userModel = new UserModel();
