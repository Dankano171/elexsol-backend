import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import crypto from 'crypto';

export interface ApiKey extends BaseEntity {
  business_id: string;
  user_id?: string;
  name: string;
  key_hash: string;
  key_preview: string; // First 8 chars of key
  permissions: string[];
  rate_limit: number; // Requests per minute
  allowed_ips?: string[];
  allowed_domains?: string[];
  expires_at?: Date;
  last_used_at?: Date;
  usage_count: number;
  metadata: Record<string, any>;
  created_by?: string;
}

export interface CreateApiKeyDTO {
  business_id: string;
  user_id?: string;
  name: string;
  permissions?: string[];
  rate_limit?: number;
  allowed_ips?: string[];
  allowed_domains?: string[];
  expires_at?: Date;
  metadata?: Record<string, any>;
  created_by?: string;
}

export class ApiKeyModel extends BaseModel<ApiKey> {
  protected tableName = 'api_keys';
  protected primaryKey = 'id';

  /**
   * Create a new API key
   */
  async createKey(data: CreateApiKeyDTO): Promise<{ key: string; apiKey: ApiKey }> {
    // Generate random API key
    const rawKey = `eks_${crypto.randomBytes(32).toString('hex')}`;
    
    // Hash the key for storage
    const keyHash = crypto
      .createHash('sha256')
      .update(rawKey)
      .digest('hex');

    const keyPreview = rawKey.substring(0, 8);

    const apiKey = await this.create({
      business_id: data.business_id,
      user_id: data.user_id,
      name: data.name,
      key_hash: keyHash,
      key_preview: keyPreview,
      permissions: data.permissions || ['read:basic'],
      rate_limit: data.rate_limit || 100,
      allowed_ips: data.allowed_ips,
      allowed_domains: data.allowed_domains,
      expires_at: data.expires_at,
      usage_count: 0,
      metadata: data.metadata || {},
      created_by: data.created_by,
    });

    return {
      key: rawKey, // Return raw key only once
      apiKey,
    };
  }

  /**
   * Validate API key
   */
  async validateKey(key: string, ip?: string, origin?: string): Promise<ApiKey | null> {
    // Hash the provided key
    const keyHash = crypto
      .createHash('sha256')
      .update(key)
      .digest('hex');

    // Find by hash
    const apiKey = await this.findOne({ key_hash: keyHash });

    if (!apiKey) {
      return null;
    }

    // Check if expired
    if (apiKey.expires_at && apiKey.expires_at < new Date()) {
      return null;
    }

    // Check IP whitelist
    if (apiKey.allowed_ips && apiKey.allowed_ips.length > 0) {
      if (!ip || !apiKey.allowed_ips.includes(ip)) {
        logger.warn(`API key ${apiKey.key_preview} rejected from IP ${ip}`);
        return null;
      }
    }

    // Check domain whitelist
    if (apiKey.allowed_domains && apiKey.allowed_domains.length > 0 && origin) {
      const domain = new URL(origin).hostname;
      if (!apiKey.allowed_domains.includes(domain)) {
        logger.warn(`API key ${apiKey.key_preview} rejected from domain ${domain}`);
        return null;
      }
    }

    // Update usage
    await this.update(apiKey.id, {
      last_used_at: new Date(),
      usage_count: apiKey.usage_count + 1,
    });

    return apiKey;
  }

  /**
   * Get keys by business
   */
  async getByBusiness(businessId: string): Promise<ApiKey[]> {
    return this.find({ business_id: businessId }, {
      orderBy: 'created_at',
      orderDir: 'DESC',
    });
  }

  /**
   * Get keys by user
   */
  async getByUser(userId: string): Promise<ApiKey[]> {
    return this.find({ user_id: userId }, {
      orderBy: 'created_at',
      orderDir: 'DESC',
    });
  }

  /**
   * Revoke API key
   */
  async revoke(id: string, businessId: string): Promise<boolean> {
    const key = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!key) {
      return false;
    }

    await this.softDelete(id);
    return true;
  }

  /**
   * Update key permissions
   */
  async updatePermissions(
    id: string,
    businessId: string,
    permissions: string[]
  ): Promise<ApiKey | null> {
    const key = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!key) {
      return null;
    }

    return this.update(id, { permissions });
  }

  /**
   * Update rate limit
   */
  async updateRateLimit(
    id: string,
    businessId: string,
    rateLimit: number
  ): Promise<ApiKey | null> {
    const key = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!key) {
      return null;
    }

    return this.update(id, { rate_limit: rateLimit });
  }

  /**
   * Check key permissions
   */
  async hasPermission(keyId: string, requiredPermission: string): Promise<boolean> {
    const key = await this.findById(keyId);
    
    if (!key) {
      return false;
    }

    // Check for wildcard
    if (key.permissions.includes('*')) {
      return true;
    }

    // Check for exact match
    if (key.permissions.includes(requiredPermission)) {
      return true;
    }

    // Check for wildcard segments
    for (const permission of key.permissions) {
      if (permission.endsWith(':*')) {
        const prefix = permission.replace(':*', '');
        if (requiredPermission.startsWith(prefix)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get key usage statistics
   */
  async getUsageStats(keyId: string): Promise<any> {
    const key = await this.findById(keyId);
    
    if (!key) {
      throw new Error('Key not found');
    }

    const query = `
      SELECT
        COUNT(*) as total_usage,
        MAX(created_at) as last_used,
        MIN(created_at) as first_used,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM api_usage_logs
      WHERE api_key_id = $1
    `;

    const result = await db.query(query, [keyId]);
    return result.rows[0];
  }

  /**
   * Get expiring keys
   */
  async getExpiringKeys(days: number = 7): Promise<ApiKey[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    const query = `
      SELECT * FROM api_keys
      WHERE expires_at <= $1
        AND expires_at > NOW()
        AND deleted_at IS NULL
      ORDER BY expires_at ASC
    `;

    const result = await db.query(query, [cutoff]);
    return result.rows;
  }

  /**
   * Generate new key (replacement)
   */
  async rotateKey(id: string, businessId: string): Promise<{ newKey: string; newApiKey: ApiKey }> {
    const oldKey = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!oldKey) {
      throw new Error('Key not found');
    }

    // Create new key with same settings
    const { key, apiKey } = await this.createKey({
      business_id: oldKey.business_id,
      user_id: oldKey.user_id,
      name: `${oldKey.name} (Rotated)`,
      permissions: oldKey.permissions,
      rate_limit: oldKey.rate_limit,
      allowed_ips: oldKey.allowed_ips,
      allowed_domains: oldKey.allowed_domains,
      metadata: {
        ...oldKey.metadata,
        rotated_from: oldKey.key_preview,
        rotated_at: new Date(),
      },
    });

    // Revoke old key
    await this.revoke(id, businessId);

    return {
      newKey: key,
      newApiKey: apiKey,
    };
  }

  /**
   * Log API usage
   */
  async logUsage(
    keyId: string,
    endpoint: string,
    method: string,
    status: number,
    responseTimeMs: number,
    ip?: string
  ): Promise<void> {
    await db.query(
      `INSERT INTO api_usage_logs (
        id, api_key_id, endpoint, method, status, response_time_ms, ip, created_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW()
      )`,
      [keyId, endpoint, method, status, responseTimeMs, ip]
    );
  }
}

export const apiKeyModel = new ApiKeyModel();
