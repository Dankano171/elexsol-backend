import { accountIntegrationRepository } from '../../repositories/AccountIntegrationRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { encrypt, decrypt } from '../../config/encryption';
import { IntegrationProvider } from '../../config/constants/business-rules';
import { zohoProvider } from './providers/ZohoProvider';
import { whatsappProvider } from './providers/WhatsAppProvider';
import { quickbooksProvider } from './providers/QuickBooksProvider';
import { webhookService } from '../webhook/WebhookService';
import { v4 as uuidv4 } from 'uuid';

export interface IntegrationConfig {
  provider: IntegrationProvider;
  businessId: string;
  accountEmail: string;
  accountId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface SyncResult {
  success: boolean;
  recordsSynced: number;
  errors?: string[];
  warnings?: string[];
  completedAt: Date;
}

export class IntegrationService {
  private readonly providers = {
    zoho: zohoProvider,
    whatsapp: whatsappProvider,
    quickbooks: quickbooksProvider,
  };

  /**
   * Connect new integration
   */
  async connect(config: IntegrationConfig, userId: string): Promise<any> {
    try {
      // Check if integration already exists
      const existing = await accountIntegrationRepository.findByEmail(
        config.provider,
        config.accountEmail,
        config.businessId
      );

      if (existing) {
        throw new Error(`Integration with ${config.provider} already exists for this account`);
      }

      // Test connection
      const provider = this.providers[config.provider];
      const testResult = await provider.testConnection(config.accessToken);
      
      if (!testResult.success) {
        throw new Error(`Connection test failed: ${testResult.error}`);
      }

      // Create integration
      const integration = await accountIntegrationRepository.createIntegration({
        business_id: config.businessId,
        provider: config.provider,
        account_email: config.accountEmail,
        account_id: config.accountId || testResult.accountId,
        access_token: config.accessToken,
        refresh_token: config.refreshToken,
        token_expires_at: config.expiresAt,
        scopes: config.scopes,
        settings: config.settings || {},
        metadata: {
          ...config.metadata,
          connected_at: new Date().toISOString(),
          connected_by: userId,
        },
      }, userId);

      // Create webhook if needed
      if (provider.supportsWebhooks) {
        await this.setupWebhook(integration.id, config.businessId);
      }

      // Trigger initial sync
      await this.queueSync(integration.id, config.businessId);

      // Log audit
      await auditLogRepository.log({
        user_id: userId,
        business_id: config.businessId,
        action: 'INTEGRATION_CONNECT',
        entity_type: 'integration',
        entity_id: integration.id,
        metadata: {
          provider: config.provider,
          account: config.accountEmail,
        },
      });

      return integration;
    } catch (error) {
      logger.error('Integration connection error:', error);
      throw error;
    }
  }

  /**
   * Disconnect integration
   */
  async disconnect(integrationId: string, businessId: string, userId: string): Promise<void> {
    const integration = await accountIntegrationRepository.findOne({
      id: integrationId,
      business_id: businessId,
    });

    if (!integration) {
      throw new Error('Integration not found');
    }

    // Remove webhook
    if (integration.webhook_url) {
      await this.removeWebhook(integrationId, businessId);
    }

    // Disconnect
    await accountIntegrationRepository.disconnect(integrationId, businessId);

    // Log audit
    await auditLogRepository.log({
      user_id: userId,
      business_id: businessId,
      action: 'INTEGRATION_DISCONNECT',
      entity_type: 'integration',
      entity_id: integrationId,
      metadata: {
        provider: integration.provider,
        account: integration.account_email,
      },
    });
  }

  /**
   * Sync integration
   */
  async sync(integrationId: string, businessId: string): Promise<SyncResult> {
    const integration = await accountIntegrationRepository.findOne({
      id: integrationId,
      business_id: businessId,
    });

    if (!integration) {
      throw new Error('Integration not found');
    }

    if (integration.status !== 'active') {
      throw new Error(`Integration is ${integration.status}`);
    }

    // Update sync status
    await accountIntegrationRepository.updateSyncStatus(integrationId, 'syncing');

    try {
      // Get access token
      const accessToken = await accountIntegrationRepository.getAccessToken(
        integrationId,
        businessId
      );

      if (!accessToken) {
        throw new Error('Unable to get access token');
      }

      // Perform sync
      const provider = this.providers[integration.provider];
      const result = await provider.sync(accessToken, integration.settings);

      // Update last sync
      await accountIntegrationRepository.updateSyncStatus(integrationId, 'idle');

      // Store sync results
      await redis.setex(
        `sync:${integrationId}:last`,
        3600,
        JSON.stringify(result)
      );

      return result;
    } catch (error) {
      logger.error('Integration sync error:', error);
      
      await accountIntegrationRepository.updateSyncStatus(
        integrationId,
        'failed',
        error.message
      );

      throw error;
    }
  }

  /**
   * Queue sync for later processing
   */
  async queueSync(integrationId: string, businessId: string): Promise<void> {
    const queueKey = `sync:queue:${businessId}`;
    await redis.sadd(queueKey, integrationId);
    
    // Publish event for worker
    await redis.publish('sync:queued', JSON.stringify({
      integrationId,
      businessId,
      queuedAt: new Date(),
    }));
  }

  /**
   * Process sync queue
   */
  async processSyncQueue(businessId: string, limit: number = 5): Promise<void> {
    const queueKey = `sync:queue:${businessId}`;
    
    // Get pending syncs
    const pending = await redis.smembers(queueKey);
    const toProcess = pending.slice(0, limit);

    for (const integrationId of toProcess) {
      try {
        await this.sync(integrationId, businessId);
        await redis.srem(queueKey, integrationId);
      } catch (error) {
        logger.error('Queue sync error:', error);
      }
    }
  }

  /**
   * Setup webhook for integration
   */
  async setupWebhook(integrationId: string, businessId: string): Promise<void> {
    const integration = await accountIntegrationRepository.findOne({
      id: integrationId,
      business_id: businessId,
    });

    if (!integration) {
      throw new Error('Integration not found');
    }

    const provider = this.providers[integration.provider];
    
    // Generate webhook secret
    const webhookSecret = uuidv4();
    const webhookUrl = `${process.env.API_URL}/webhook/${integration.provider}/${webhookSecret}`;

    // Register webhook with provider
    const accessToken = await accountIntegrationRepository.getAccessToken(
      integrationId,
      businessId
    );

    if (!accessToken) {
      throw new Error('Unable to get access token');
    }

    const result = await provider.registerWebhook(accessToken, webhookUrl);

    // Update integration with webhook details
    await accountIntegrationRepository.update(integrationId, {
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
      settings: {
        ...integration.settings,
        webhook_id: result.webhookId,
        webhook_topics: result.topics,
      },
    });
  }

  /**
   * Remove webhook
   */
  async removeWebhook(integrationId: string, businessId: string): Promise<void> {
    const integration = await accountIntegrationRepository.findOne({
      id: integrationId,
      business_id: businessId,
    });

    if (!integration || !integration.webhook_url) {
      return;
    }

    const provider = this.providers[integration.provider];
    
    // Unregister webhook
    const accessToken = await accountIntegrationRepository.getAccessToken(
      integrationId,
      businessId
    );

    if (accessToken && integration.settings?.webhook_id) {
      await provider.unregisterWebhook(accessToken, integration.settings.webhook_id);
    }
  }

  /**
   * Refresh token
   */
  async refreshToken(integrationId: string, businessId: string): Promise<void> {
    const integration = await accountIntegrationRepository.findOne({
      id: integrationId,
      business_id: businessId,
    });

    if (!integration) {
      throw new Error('Integration not found');
    }

    const provider = this.providers[integration.provider];
    
    // Get refresh token
    const refreshToken = await accountIntegrationRepository.getRefreshToken(
      integrationId,
      businessId
    );

    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    // Refresh token
    const result = await provider.refreshToken(refreshToken);

    // Update tokens
    await accountIntegrationRepository.updateTokens(
      integrationId,
      result.accessToken,
      result.refreshToken,
      result.expiresAt
    );

    logger.info(`Token refreshed for integration ${integrationId}`);
  }

  /**
   * Get integration status
   */
  async getStatus(integrationId: string, businessId: string): Promise<any> {
    const integration = await accountIntegrationRepository.findOne({
      id: integrationId,
      business_id: businessId,
    });

    if (!integration) {
      throw new Error('Integration not found');
    }

    const health = await accountIntegrationRepository.getHealthStatus(integrationId);
    
    // Get last sync
    const lastSync = await redis.get(`sync:${integrationId}:last`);
    const lastSyncData = lastSync ? JSON.parse(lastSync) : null;

    return {
      id: integration.id,
      provider: integration.provider,
      status: integration.status,
      syncStatus: integration.sync_status,
      lastSync: integration.last_sync_at,
      lastSyncResult: lastSyncData,
      health,
      tokenExpiresAt: integration.token_expires_at,
      accountEmail: integration.account_email,
      accountId: integration.account_id,
      createdAt: integration.created_at,
    };
  }

  /**
   * Get all integrations for business
   */
  async getBusinessIntegrations(
    businessId: string,
    provider?: IntegrationProvider
  ): Promise<any[]> {
    const integrations = await accountIntegrationRepository.findByBusiness(
      businessId,
      provider
    );

    const result = [];

    for (const integration of integrations) {
      const health = await accountIntegrationRepository.getHealthStatus(integration.id);
      const lastSync = await redis.get(`sync:${integration.id}:last`);
      
      result.push({
        id: integration.id,
        provider: integration.provider,
        status: integration.status,
        syncStatus: integration.sync_status,
        lastSync: integration.last_sync_at,
        lastSyncResult: lastSync ? JSON.parse(lastSync) : null,
        health,
        accountEmail: integration.account_email,
        accountId: integration.account_id,
        createdAt: integration.created_at,
      });
    }

    return result;
  }

  /**
   * Update integration settings
   */
  async updateSettings(
    integrationId: string,
    businessId: string,
    settings: Record<string, any>,
    userId: string
  ): Promise<any> {
    const integration = await accountIntegrationRepository.findOne({
      id: integrationId,
      business_id: businessId,
    });

    if (!integration) {
      throw new Error('Integration not found');
    }

    const updated = await accountIntegrationRepository.update(integrationId, {
      settings: {
        ...integration.settings,
        ...settings,
      },
    });

    // Log audit
    await auditLogRepository.log({
      user_id: userId,
      business_id: businessId,
      action: 'INTEGRATION_UPDATE',
      entity_type: 'integration',
      entity_id: integrationId,
      metadata: {
        provider: integration.provider,
        changes: settings,
      },
    });

    return updated;
  }

  /**
   * Handle webhook event
   */
  async handleWebhook(
    provider: IntegrationProvider,
    payload: any,
    headers: any
  ): Promise<void> {
    const providerImpl = this.providers[provider];
    
    // Validate webhook signature
    const isValid = await providerImpl.validateWebhook(payload, headers);
    
    if (!isValid) {
      throw new Error('Invalid webhook signature');
    }

    // Extract integration identifier
    const identifier = providerImpl.extractIdentifier(payload);
    
    // Find integration
    const integration = await accountIntegrationRepository.findByProviderAccount(
      provider,
      identifier
    );

    if (!integration) {
      logger.warn(`No integration found for webhook: ${provider} - ${identifier}`);
      return;
    }

    // Process webhook
    await webhookService.processWebhook(integration.id, integration.business_id, {
      provider,
      event: providerImpl.extractEventType(payload),
      payload,
      headers,
    });
  }

  /**
   * Get provider instance
   */
  getProvider(provider: IntegrationProvider) {
    return this.providers[provider];
  }

  /**
   * Check if integration exists
   */
  async exists(
    businessId: string,
    provider: IntegrationProvider,
    accountEmail: string
  ): Promise<boolean> {
    const integration = await accountIntegrationRepository.findByEmail(
      provider,
      accountEmail,
      businessId
    );
    return !!integration;
  }
}

export const integrationService = new IntegrationService();
