import { webhookEventRepository } from '../../repositories/WebhookEventRepository';
import { accountIntegrationRepository } from '../../repositories/AccountIntegrationRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { webhookProcessor } from './WebhookProcessor';
import { webhookValidator } from './WebhookValidator';
import { webhookQueue } from '../queue/WebhookQueue';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export interface WebhookPayload {
  id: string;
  event: string;
  timestamp: string;
  data: any;
  previous_data?: any;
}

export interface WebhookHeader {
  signature?: string;
  timestamp?: string;
  nonce?: string;
  [key: string]: string | undefined;
}

export interface WebhookRegistration {
  id: string;
  businessId: string;
  integrationId: string;
  url: string;
  secret: string;
  events: string[];
  status: 'active' | 'paused' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
  lastTriggeredAt?: Date;
  failureCount: number;
  metadata?: Record<string, any>;
}

export class WebhookService {
  private readonly signatureHeader = 'x-webhook-signature';
  private readonly timestampHeader = 'x-webhook-timestamp';
  private readonly nonceHeader = 'x-webhook-nonce';
  private readonly maxFailures = 10;
  private readonly webhookTimeout = 10000; // 10 seconds

  /**
   * Register webhook
   */
  async registerWebhook(
    businessId: string,
    integrationId: string,
    url: string,
    events: string[],
    metadata?: Record<string, any>
  ): Promise<WebhookRegistration> {
    try {
      // Validate URL
      if (!this.isValidUrl(url)) {
        throw new Error('Invalid webhook URL');
      }

      // Generate webhook secret
      const secret = this.generateWebhookSecret();

      const registration: WebhookRegistration = {
        id: uuidv4(),
        businessId,
        integrationId,
        url,
        secret,
        events,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        failureCount: 0,
        metadata
      };

      // Store in Redis for quick access
      await this.storeWebhookRegistration(registration);

      // Store in database
      await accountIntegrationRepository.update(integrationId, {
        webhook_url: url,
        webhook_secret: secret,
        settings: {
          ...(await accountIntegrationRepository.findById(integrationId))?.settings,
          webhook_events: events,
          webhook_metadata: metadata
        }
      });

      logger.info('Webhook registered', {
        webhookId: registration.id,
        businessId,
        integrationId
      });

      return registration;
    } catch (error) {
      logger.error('Error registering webhook:', error);
      throw error;
    }
  }

  /**
   * Unregister webhook
   */
  async unregisterWebhook(webhookId: string): Promise<void> {
    try {
      const key = `webhook:${webhookId}`;
      await redis.del(key);

      logger.info('Webhook unregistered', { webhookId });
    } catch (error) {
      logger.error('Error unregistering webhook:', error);
      throw error;
    }
  }

  /**
   * Process incoming webhook
   */
  async processIncomingWebhook(
    provider: string,
    headers: WebhookHeader,
    body: any,
    ip?: string
  ): Promise<{ received: boolean; webhookId: string }> {
    const webhookId = uuidv4();

    try {
      // Find webhook registration by secret
      const secret = this.extractSecretFromHeaders(headers, provider);
      const registration = await this.findWebhookBySecret(secret);

      if (!registration) {
        logger.warn('Webhook received with invalid secret', { provider, webhookId });
        return { received: true, webhookId }; // Always return 200 to webhook providers
      }

      // Validate webhook signature
      const isValid = await webhookValidator.validateSignature(
        provider,
        headers,
        body,
        registration.secret
      );

      if (!isValid) {
        logger.warn('Invalid webhook signature', { webhookId, provider });
        await this.logWebhookEvent(webhookId, registration, 'failed', {
          error: 'Invalid signature'
        });
        return { received: true, webhookId };
      }

      // Create webhook event
      const event = await webhookEventRepository.createEvent({
        webhook_id: webhookId,
        integration_id: registration.integrationId,
        business_id: registration.businessId,
        provider,
        event_type: this.extractEventType(provider, body),
        payload: body,
        headers,
        ip,
        metadata: {
          webhook_id: registration.id,
          url: registration.url
        }
      });

      // Queue for processing
      await webhookQueue.addToQueue({
        eventId: event.id,
        webhookId: registration.id,
        integrationId: registration.integrationId,
        businessId: registration.businessId,
        provider,
        payload: body,
        headers,
        url: registration.url,
        secret: registration.secret
      });

      logger.info('Webhook queued for processing', { webhookId, provider });

      return { received: true, webhookId };
    } catch (error) {
      logger.error('Error processing webhook:', error);
      return { received: true, webhookId }; // Always return 200
    }
  }

  /**
   * Trigger outgoing webhook
   */
  async triggerWebhook(
    businessId: string,
    integrationId: string,
    event: string,
    data: any,
    previousData?: any
  ): Promise<void> {
    try {
      // Get webhook registration
      const integration = await accountIntegrationRepository.findById(integrationId);
      
      if (!integration || !integration.webhook_url || !integration.webhook_secret) {
        logger.debug('No webhook configured for integration', { integrationId });
        return;
      }

      // Check if event is subscribed
      const subscribedEvents = integration.settings?.webhook_events || ['*'];
      if (!subscribedEvents.includes('*') && !subscribedEvents.includes(event)) {
        return;
      }

      const payload: WebhookPayload = {
        id: uuidv4(),
        event,
        timestamp: new Date().toISOString(),
        data,
        previous_data: previousData
      };

      // Queue webhook for delivery
      await webhookQueue.addToQueue({
        eventId: payload.id,
        webhookId: integration.id,
        integrationId,
        businessId,
        provider: integration.provider,
        payload,
        url: integration.webhook_url,
        secret: integration.webhook_secret,
        headers: this.buildWebhookHeaders(integration.webhook_secret, payload)
      });

      logger.info('Webhook triggered', {
        eventId: payload.id,
        integrationId,
        event
      });
    } catch (error) {
      logger.error('Error triggering webhook:', error);
      throw error;
    }
  }

  /**
   * Get webhook status
   */
  async getWebhookStatus(webhookId: string): Promise<any> {
    try {
      const key = `webhook:${webhookId}`;
      const registration = await redis.get(key);
      
      if (!registration) {
        return null;
      }

      const parsed = JSON.parse(registration);

      // Get recent events
      const events = await webhookEventRepository.findByIntegration(
        parsed.integrationId,
        { limit: 10 }
      );

      // Calculate success rate
      const total = events.events.length;
      const successful = events.events.filter(e => e.status === 'completed').length;
      const successRate = total > 0 ? (successful / total) * 100 : 100;

      return {
        ...parsed,
        recentEvents: events.events,
        stats: {
          total,
          successful,
          failed: total - successful,
          successRate: Math.round(successRate * 10) / 10,
          averageResponseTime: this.calculateAverageResponseTime(events.events)
        }
      };
    } catch (error) {
      logger.error('Error getting webhook status:', error);
      throw error;
    }
  }

  /**
   * Pause webhook
   */
  async pauseWebhook(webhookId: string): Promise<void> {
    try {
      const key = `webhook:${webhookId}`;
      const data = await redis.get(key);
      
      if (data) {
        const registration = JSON.parse(data);
        registration.status = 'paused';
        await redis.setex(key, 86400 * 30, JSON.stringify(registration));
      }

      logger.info('Webhook paused', { webhookId });
    } catch (error) {
      logger.error('Error pausing webhook:', error);
      throw error;
    }
  }

  /**
   * Resume webhook
   */
  async resumeWebhook(webhookId: string): Promise<void> {
    try {
      const key = `webhook:${webhookId}`;
      const data = await redis.get(key);
      
      if (data) {
        const registration = JSON.parse(data);
        registration.status = 'active';
        registration.failureCount = 0;
        await redis.setex(key, 86400 * 30, JSON.stringify(registration));
      }

      logger.info('Webhook resumed', { webhookId });
    } catch (error) {
      logger.error('Error resuming webhook:', error);
      throw error;
    }
  }

  /**
   * Update webhook events
   */
  async updateWebhookEvents(
    webhookId: string,
    events: string[]
  ): Promise<void> {
    try {
      const key = `webhook:${webhookId}`;
      const data = await redis.get(key);
      
      if (data) {
        const registration = JSON.parse(data);
        registration.events = events;
        registration.updatedAt = new Date();
        await redis.setex(key, 86400 * 30, JSON.stringify(registration));
      }

      // Update in database
      await accountIntegrationRepository.update(
        (await this.getWebhookIntegrationId(webhookId))!,
        {
          settings: {
            webhook_events: events
          }
        }
      );

      logger.info('Webhook events updated', { webhookId, events });
    } catch (error) {
      logger.error('Error updating webhook events:', error);
      throw error;
    }
  }

  /**
   * Retry failed webhook
   */
  async retryWebhook(eventId: string): Promise<void> {
    try {
      const event = await webhookEventRepository.findById(eventId);
      
      if (!event) {
        throw new Error('Webhook event not found');
      }

      if (event.status !== 'failed') {
        throw new Error('Only failed webhooks can be retried');
      }

      // Reset attempt count
      await webhookEventRepository.update(eventId, {
        attempts: 0,
        status: 'pending',
        next_retry_at: new Date()
      });

      // Requeue
      const integration = await accountIntegrationRepository.findById(event.integration_id!);
      
      if (integration?.webhook_url && integration?.webhook_secret) {
        await webhookQueue.addToQueue({
          eventId: event.id,
          webhookId: integration.id,
          integrationId: integration.id,
          businessId: event.business_id!,
          provider: event.provider,
          payload: event.payload,
          headers: event.headers,
          url: integration.webhook_url,
          secret: integration.webhook_secret
        });
      }

      logger.info('Webhook queued for retry', { eventId });
    } catch (error) {
      logger.error('Error retrying webhook:', error);
      throw error;
    }
  }

  /**
   * Store webhook registration
   */
  private async storeWebhookRegistration(registration: WebhookRegistration): Promise<void> {
    const key = `webhook:${registration.id}`;
    const secretKey = `webhook_secret:${registration.secret}`;

    await redis.setex(key, 86400 * 30, JSON.stringify(registration));
    await redis.setex(secretKey, 86400 * 30, registration.id);
  }

  /**
   * Find webhook by secret
   */
  private async findWebhookBySecret(secret: string): Promise<WebhookRegistration | null> {
    if (!secret) return null;

    const secretKey = `webhook_secret:${secret}`;
    const webhookId = await redis.get(secretKey);

    if (!webhookId) return null;

    const key = `webhook:${webhookId}`;
    const data = await redis.get(key);

    return data ? JSON.parse(data) : null;
  }

  /**
   * Extract secret from headers based on provider
   */
  private extractSecretFromHeaders(headers: WebhookHeader, provider: string): string {
    switch (provider) {
      case 'zoho':
        return headers['x-zoho-signature'] || '';
      case 'whatsapp':
        return headers['x-hub-signature-256'] || '';
      case 'quickbooks':
        return headers['intuit-signature'] || '';
      default:
        return headers[this.signatureHeader] || '';
    }
  }

  /**
   * Extract event type from payload
   */
  private extractEventType(provider: string, payload: any): string {
    switch (provider) {
      case 'zoho':
        return payload?.event || 'unknown';
      case 'whatsapp':
        return payload?.entry?.[0]?.changes?.[0]?.field || 'message';
      case 'quickbooks':
        return payload?.eventNotifications?.[0]?.dataChangeEvent?.entities?.[0]?.name || 'unknown';
      default:
        return payload?.event || 'unknown';
    }
  }

  /**
   * Build webhook headers
   */
  private buildWebhookHeaders(secret: string, payload: WebhookPayload): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = uuidv4();
    const signature = this.generateSignature(secret, payload, timestamp, nonce);

    return {
      [this.signatureHeader]: signature,
      [this.timestampHeader]: timestamp,
      [this.nonceHeader]: nonce,
      'Content-Type': 'application/json',
      'User-Agent': 'Elexsol-Webhook/1.0'
    };
  }

  /**
   * Generate webhook signature
   */
  private generateSignature(
    secret: string,
    payload: WebhookPayload,
    timestamp: string,
    nonce: string
  ): string {
    const data = `${timestamp}.${nonce}.${JSON.stringify(payload)}`;
    return crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('hex');
  }

  /**
   * Generate webhook secret
   */
  private generateWebhookSecret(): string {
    return `whsec_${crypto.randomBytes(32).toString('hex')}`;
  }

  /**
   * Validate URL
   */
  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return url.startsWith('https://');
    } catch {
      return false;
    }
  }

  /**
   * Log webhook event
   */
  private async logWebhookEvent(
    webhookId: string,
    registration: WebhookRegistration,
    status: string,
    metadata: any = {}
  ): Promise<void> {
    await auditLogRepository.log({
      business_id: registration.businessId,
      action: 'WEBHOOK_RECEIVED',
      entity_type: 'webhook',
      entity_id: webhookId,
      metadata: {
        webhook_id: registration.id,
        integration_id: registration.integrationId,
        status,
        ...metadata
      }
    });
  }

  /**
   * Get webhook integration ID
   */
  private async getWebhookIntegrationId(webhookId: string): Promise<string | null> {
    const key = `webhook:${webhookId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data).integrationId : null;
  }

  /**
   * Calculate average response time
   */
  private calculateAverageResponseTime(events: any[]): number {
    const times = events
      .filter(e => e.completed_at && e.created_at)
      .map(e => new Date(e.completed_at).getTime() - new Date(e.created_at).getTime());

    if (times.length === 0) return 0;

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return Math.round(avg);
  }
}

export const webhookService = new WebhookService();
