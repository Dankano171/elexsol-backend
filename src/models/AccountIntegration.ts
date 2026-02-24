import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { encrypt, decrypt } from '../config/encryption';
import { INTEGRATION_PROVIDERS, IntegrationProvider } from '../config/constants/business-rules';

export interface AccountIntegration extends BaseEntity {
  business_id: string;
  provider: IntegrationProvider;
  account_email: string;
  account_id?: string;
  encrypted_access_token: Buffer;
  encrypted_refresh_token?: Buffer;
  token_expires_at?: Date;
  scopes: string[];
  webhook_secret?: string;
  webhook_url?: string;
  settings: Record<string, any>;
  status: 'active' | 'expired' | 'revoked' | 'pending';
  last_sync_at?: Date;
  sync_status: 'idle' | 'syncing' | 'failed';
  sync_error?: string;
  metadata: Record<string, any>;
  created_by?: string;
  updated_by?: string;
}

export interface CreateIntegrationDTO {
  business_id: string;
  provider: IntegrationProvider;
  account_email: string;
  account_id?: string;
  access_token: string;
  refresh_token?: string;
  token_expires_at?: Date;
  scopes: string[];
  webhook_secret?: string;
  webhook_url?: string;
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
}

export class AccountIntegrationModel extends BaseModel<AccountIntegration> {
  protected tableName = 'account_integrations';
  protected primaryKey = 'id';

  /**
   * Create a new integration with encrypted tokens
   */
  async createIntegration(data: CreateIntegrationDTO, createdBy?: string): Promise<AccountIntegration> {
    const client = await this.beginTransaction();
    
    try {
      // Check for existing active integration
      const existing = await this.findOne({
        business_id: data.business_id,
        provider: data.provider,
        account_email: data.account_email,
        status: ['active', 'pending'],
      });

      if (existing) {
        throw new Error(`Integration with ${data.provider} already exists for this account`);
      }

      // Encrypt tokens
      const encrypted_access_token = encrypt(data.access_token);
      const encrypted_refresh_token = data.refresh_token ? encrypt(data.refresh_token) : undefined;

      const integration = await this.create({
        business_id: data.business_id,
        provider: data.provider,
        account_email: data.account_email,
        account_id: data.account_id,
        encrypted_access_token,
        encrypted_refresh_token,
        token_expires_at: data.token_expires_at,
        scopes: data.scopes,
        webhook_secret: data.webhook_secret,
        webhook_url: data.webhook_url,
        settings: data.settings || {},
        status: 'active',
        sync_status: 'idle',
        metadata: data.metadata || {},
        created_by: createdBy,
        updated_by: createdBy,
      }, client);

      await this.commitTransaction(client);
      
      // Remove sensitive data
      delete (integration as any).encrypted_access_token;
      delete (integration as any).encrypted_refresh_token;
      
      return integration;
    } catch (error) {
      await this.rollbackTransaction(client);
      logger.error('Error in AccountIntegrationModel.createIntegration:', error);
      throw error;
    }
  }

  /**
   * Get access token (decrypted)
   */
  async getAccessToken(id: string, businessId: string): Promise<string | null> {
    const integration = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!integration || integration.status !== 'active') {
      return null;
    }

    // Check if token is expired
    if (integration.token_expires_at && integration.token_expires_at < new Date()) {
      await this.update(id, { status: 'expired' });
      return null;
    }

    return decrypt(integration.encrypted_access_token).toString();
  }

  /**
   * Get refresh token (decrypted)
   */
  async getRefreshToken(id: string, businessId: string): Promise<string | null> {
    const integration = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!integration || !integration.encrypted_refresh_token) {
      return null;
    }

    return decrypt(integration.encrypted_refresh_token).toString();
  }

  /**
   * Update tokens
   */
  async updateTokens(
    id: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: Date
  ): Promise<AccountIntegration | null> {
    const updates: Partial<AccountIntegration> = {
      encrypted_access_token: encrypt(accessToken),
      status: 'active',
    };

    if (refreshToken) {
      updates.encrypted_refresh_token = encrypt(refreshToken);
    }

    if (expiresAt) {
      updates.token_expires_at = expiresAt;
    }

    const integration = await this.update(id, updates);
    
    if (integration) {
      delete (integration as any).encrypted_access_token;
      delete (integration as any).encrypted_refresh_token;
    }
    
    return integration;
  }

  /**
   * Get integrations by business
   */
  async getByBusiness(businessId: string, provider?: IntegrationProvider): Promise<AccountIntegration[]> {
    const where: any = { business_id: businessId };
    if (provider) {
      where.provider = provider;
    }
    return this.find(where);
  }

  /**
   * Get active integrations
   */
  async getActive(businessId?: string): Promise<AccountIntegration[]> {
    const where: any = { status: 'active' };
    if (businessId) {
      where.business_id = businessId;
    }
    return this.find(where);
  }

  /**
   * Get expired tokens that need refresh
   */
  async getExpiredTokens(): Promise<AccountIntegration[]> {
    const query = `
      SELECT * FROM account_integrations
      WHERE status = 'active'
        AND token_expires_at IS NOT NULL
        AND token_expires_at <= NOW() + INTERVAL '1 day'
        AND encrypted_refresh_token IS NOT NULL
        AND deleted_at IS NULL
    `;

    const result = await db.query(query);
    return result.rows;
  }

  /**
   * Update sync status
   */
  async updateSyncStatus(
    id: string,
    status: AccountIntegration['sync_status'],
    error?: string
  ): Promise<void> {
    const updates: Partial<AccountIntegration> = {
      sync_status: status,
    };

    if (status === 'idle') {
      updates.last_sync_at = new Date();
      updates.sync_error = null;
    } else if (status === 'failed' && error) {
      updates.sync_error = error;
    }

    await this.update(id, updates);
  }

  /**
   * Get webhook by secret
   */
  async getByWebhookSecret(secret: string): Promise<AccountIntegration | null> {
    return this.findOne({ webhook_secret: secret });
  }

  /**
   * Verify webhook ownership
   */
  async verifyWebhook(integrationId: string, secret: string): Promise<boolean> {
    const integration = await this.findById(integrationId);
    
    if (!integration || !integration.webhook_secret) {
      return false;
    }

    return integration.webhook_secret === secret;
  }

  /**
   * Get provider statistics
   */
  async getProviderStats(businessId?: string): Promise<any> {
    const where = businessId ? 'WHERE business_id = $1' : '';
    const params = businessId ? [businessId] : [];

    const query = `
      SELECT
        provider,
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired,
        COUNT(CASE WHEN status = 'revoked' THEN 1 END) as revoked,
        COUNT(CASE WHEN sync_status = 'syncing' THEN 1 END) as syncing,
        COUNT(CASE WHEN sync_status = 'failed' THEN 1 END) as failed_sync
      FROM account_integrations
      ${where}
      GROUP BY provider
    `;

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Get integrations needing attention
   */
  async getNeedingAttention(businessId?: string): Promise<AccountIntegration[]> {
    const where: any = {
      status: ['expired', 'pending'],
      sync_status: 'failed',
    };

    if (businessId) {
      where.business_id = businessId;
    }

    return this.find(where);
  }

  /**
   * Bulk update sync status
   */
  async bulkUpdateSyncStatus(
    ids: string[],
    status: AccountIntegration['sync_status']
  ): Promise<number> {
    return this.bulkUpdate(ids, { sync_status: status });
  }

  /**
   * Disconnect integration (soft delete)
   */
  async disconnect(id: string, businessId: string): Promise<boolean> {
    const integration = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!integration) {
      return false;
    }

    await this.softDelete(id);
    return true;
  }

  /**
   * Get integration health status
   */
  async getHealthStatus(id: string): Promise<{
    healthy: boolean;
    issues: string[];
  }> {
    const integration = await this.findById(id);
    
    if (!integration) {
      return { healthy: false, issues: ['Integration not found'] };
    }

    const issues: string[] = [];

    if (integration.status !== 'active') {
      issues.push(`Status: ${integration.status}`);
    }

    if (integration.sync_status === 'failed') {
      issues.push(`Last sync failed: ${integration.sync_error}`);
    }

    if (integration.token_expires_at && integration.token_expires_at < new Date()) {
      issues.push('Token expired');
    } else if (integration.token_expires_at) {
      const daysUntilExpiry = Math.ceil(
        (integration.token_expires_at.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      if (daysUntilExpiry < 7) {
        issues.push(`Token expires in ${daysUntilExpiry} days`);
      }
    }

    if (integration.last_sync_at) {
      const daysSinceSync = Math.ceil(
        (Date.now() - integration.last_sync_at.getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysSinceSync > 7) {
        issues.push(`No sync for ${daysSinceSync} days`);
      }
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }

  /**
   * Get integration by provider account
   */
  async getByProviderAccount(
    provider: IntegrationProvider,
    accountId: string
  ): Promise<AccountIntegration | null> {
    return this.findOne({
      provider,
      account_id: accountId,
      status: 'active',
    });
  }
}

export const accountIntegrationModel = new AccountIntegrationModel();
