import { BaseRepository } from './BaseRepository';
import { AccountIntegration } from '../models/AccountIntegration';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { decrypt, encrypt } from '../config/encryption';
import { IntegrationProvider } from '../config/constants/business-rules';

export class AccountIntegrationRepository extends BaseRepository<AccountIntegration> {
  protected tableName = 'account_integrations';
  protected primaryKey = 'id';

  /**
   * Find by business
   */
  async findByBusiness(
    businessId: string,
    provider?: IntegrationProvider
  ): Promise<AccountIntegration[]> {
    const conditions: any = { business_id: businessId };
    if (provider) {
      conditions.provider = provider;
    }
    return this.find(conditions, {
      orderBy: 'created_at',
      orderDir: 'DESC',
    });
  }

  /**
   * Find active by business
   */
  async findActiveByBusiness(
    businessId: string,
    provider?: IntegrationProvider
  ): Promise<AccountIntegration[]> {
    const conditions: any = {
      business_id: businessId,
      status: 'active',
    };
    if (provider) {
      conditions.provider = provider;
    }
    return this.find(conditions);
  }

  /**
   * Find by provider account
   */
  async findByProviderAccount(
    provider: IntegrationProvider,
    accountId: string
  ): Promise<AccountIntegration | null> {
    return this.findOne({
      provider,
      account_id: accountId,
      status: 'active',
    });
  }

  /**
   * Find by email
   */
  async findByEmail(
    provider: IntegrationProvider,
    email: string,
    businessId?: string
  ): Promise<AccountIntegration | null> {
    const conditions: any = {
      provider,
      account_email: email.toLowerCase(),
    };
    if (businessId) {
      conditions.business_id = businessId;
    }
    return this.findOne(conditions);
  }

  /**
   * Find by webhook secret
   */
  async findByWebhookSecret(secret: string): Promise<AccountIntegration | null> {
    return this.findOne({ webhook_secret: secret });
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

    return this.update(id, updates);
  }

  /**
   * Find expired tokens needing refresh
   */
  async findExpiredTokens(): Promise<AccountIntegration[]> {
    const query = `
      SELECT * FROM account_integrations
      WHERE status = 'active'
        AND token_expires_at IS NOT NULL
        AND token_expires_at <= NOW() + INTERVAL '1 day'
        AND encrypted_refresh_token IS NOT NULL
        AND deleted_at IS NULL
    `;

    return this.executeQuery<AccountIntegration>(query);
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
   * Get integrations needing attention
   */
  async findNeedingAttention(businessId?: string): Promise<AccountIntegration[]> {
    const conditions: any = {
      status: ['expired', 'pending'],
      sync_status: 'failed',
    };

    if (businessId) {
      conditions.business_id = businessId;
    }

    return this.find(conditions);
  }

  /**
   * Get provider statistics
   */
  async getProviderStats(businessId?: string): Promise<any[]> {
    let sql = `
      SELECT
        provider,
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN status = 'expired' THEN 1 END) as expired,
        COUNT(CASE WHEN status = 'revoked' THEN 1 END) as revoked,
        COUNT(CASE WHEN sync_status = 'syncing' THEN 1 END) as syncing,
        COUNT(CASE WHEN sync_status = 'failed' THEN 1 END) as failed_sync,
        AVG(CASE WHEN last_sync_at IS NOT NULL 
            THEN EXTRACT(EPOCH FROM (NOW() - last_sync_at))/3600 
            ELSE NULL END) as avg_hours_since_sync
      FROM account_integrations
      WHERE deleted_at IS NULL
    `;

    const params: any[] = [];

    if (businessId) {
      sql += ` AND business_id = $1`;
      params.push(businessId);
    }

    sql += ` GROUP BY provider`;

    return this.executeQuery(sql, params);
  }

  /**
   * Get integration health
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

    if (integration.token_expires_at) {
      if (integration.token_expires_at < new Date()) {
        issues.push('Token expired');
      } else {
        const daysUntilExpiry = Math.ceil(
          (integration.token_expires_at.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        if (daysUntilExpiry < 7) {
          issues.push(`Token expires in ${daysUntilExpiry} days`);
        }
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
   * Bulk update sync status
   */
  async bulkUpdateSyncStatus(
    ids: string[],
    status: AccountIntegration['sync_status']
  ): Promise<number> {
    return this.bulkUpdate(ids, { sync_status: status });
  }

  /**
   * Disconnect integration
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
   * Verify webhook
   */
  async verifyWebhook(integrationId: string, secret: string): Promise<boolean> {
    const integration = await this.findById(integrationId);
    
    if (!integration || !integration.webhook_secret) {
      return false;
    }

    return integration.webhook_secret === secret;
  }

  /**
   * Get integration by type
   */
  async getByType(
    type: 'oauth' | 'apikey' | 'webhook',
    businessId?: string
  ): Promise<AccountIntegration[]> {
    // This is a simplified example - in reality, you'd have a column for integration_type
    // or derive from metadata
    const integrations = await this.find(
      businessId ? { business_id: businessId } : {}
    );

    return integrations.filter(i => {
      if (type === 'oauth') return !!i.encrypted_refresh_token;
      if (type === 'apikey') return !i.encrypted_refresh_token && !i.webhook_url;
      if (type === 'webhook') return !!i.webhook_url;
      return false;
    });
  }

  /**
   * Get webhook endpoints
   */
  async getWebhookEndpoints(businessId: string): Promise<
    Array<{
      id: string;
      provider: string;
      url: string;
      events: string[];
      secret: string;
    }>
  > {
    const integrations = await this.find({
      business_id: businessId,
      webhook_url: { $ne: null },
    });

    return integrations.map(i => ({
      id: i.id,
      provider: i.provider,
      url: i.webhook_url!,
      events: i.settings?.webhook_events || [],
      secret: i.webhook_secret || '',
    }));
  }

  /**
   * Get OAuth configurations
   */
  async getOAuthConfigs(businessId: string): Promise<
    Array<{
      provider: string;
      hasRefreshToken: boolean;
      expiresAt: Date | null;
      scopes: string[];
    }>
  > {
    const integrations = await this.find({
      business_id: businessId,
      encrypted_refresh_token: { $ne: null },
    });

    return integrations.map(i => ({
      provider: i.provider,
      hasRefreshToken: !!i.encrypted_refresh_token,
      expiresAt: i.token_expires_at,
      scopes: i.scopes,
    }));
  }

  /**
   * Get integration metrics
   */
  async getMetrics(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any> {
    const query = `
      SELECT
        provider,
        COUNT(*) as total_calls,
        SUM(CASE WHEN response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN response_status >= 400 THEN 1 ELSE 0 END) as failed,
        AVG(response_time_ms) as avg_response_time,
        MAX(response_time_ms) as max_response_time
      FROM integration_logs
      WHERE business_id = $1
        AND created_at BETWEEN $2 AND $3
      GROUP BY provider
    `;

    return this.executeQuery(query, [businessId, fromDate, toDate]);
  }
}

export const accountIntegrationRepository = new AccountIntegrationRepository();
