// src/services/integrations/webhook/webhook.service.ts
import { Request, Response } from 'express';
import crypto from 'crypto';
import { Queue } from 'bullmq';
import { AccountIntegrationModel } from '../../../models/AccountIntegration';
import { WebhookEventModel } from '../../../models/WebhookEvent';
import { redisConnection } from '../../../config/redis';
import { logger } from '../../../config/logger';
import { validateZohoPayload } from './validators/zoho.validator';
import { validateWhatsAppPayload } from './validators/whatsapp.validator';
import { validateQuickBooksPayload } from './validators/quickbooks.validator';
import { decrypt } from '../../../lib/encryption/vault.service';

// Initialize queues for parallel processing
const webhookQueue = new Queue('webhook-processing', { connection: redisConnection });
const syncQueue = new Queue('integration-sync', { connection: redisConnection });

export class WebhookService {
  
  /**
   * Handle incoming webhooks from various providers
   */
  static async handleWebhook(
    provider: string,
    req: Request,
    res: Response
  ): Promise<void> {
    const startTime = Date.now();
    const webhookId = crypto.randomUUID();
    
    try {
      // Step 1: Verify webhook signature
      const isValid = await this.verifyWebhookSignature(provider, req);
      if (!isValid) {
        logger.warn(`Invalid webhook signature for ${provider}`, { webhookId });
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      // Step 2: Find the integration
      const integration = await this.findIntegrationFromWebhook(provider, req);
      if (!integration) {
        logger.warn(`No integration found for ${provider}`, { webhookId });
        res.status(200).json({ received: true }); // Always return 200 to webhook providers
        return;
      }

      // Step 3: Log webhook event for audit
      await WebhookEventModel.create({
        webhook_id: webhookId,
        integration_id: integration.id,
        provider,
        payload: req.body,
        headers: req.headers,
        ip: req.ip,
        status: 'processing'
      });

      // Step 4: Validate payload based on provider
      let validatedPayload;
      switch (provider) {
        case 'zoho':
          validatedPayload = validateZohoPayload(req.body);
          break;
        case 'whatsapp':
          validatedPayload = validateWhatsAppPayload(req.body);
          break;
        case 'quickbooks':
          validatedPayload = validateQuickBooksPayload(req.body);
          break;
        default:
          validatedPayload = req.body;
      }

      // Step 5: Queue for parallel processing based on event type
      await this.queueForProcessing(provider, integration, validatedPayload, webhookId);

      // Step 6: Always acknowledge receipt immediately
      res.status(200).json({ 
        received: true, 
        webhook_id: webhookId,
        processing: 'queued' 
      });

      // Step 7: Update sync status
      await AccountIntegrationModel.updateSyncStatus(integration.id, 'syncing');

      logger.info(`Webhook processed successfully`, {
        webhookId,
        provider,
        integrationId: integration.id,
        duration: Date.now() - startTime
      });

    } catch (error) {
      logger.error(`Webhook processing failed`, {
        webhookId,
        provider,
        error: error.message,
        duration: Date.now() - startTime
      });

      // Update webhook event with error
      await WebhookEventModel.updateStatus(webhookId, 'failed', error.message);
      
      // Always return 200 to webhook providers
      res.status(200).json({ received: true });
    }
  }

  /**
   * Verify webhook signature
   */
  private static async verifyWebhookSignature(
    provider: string,
    req: Request
  ): Promise<boolean> {
    try {
      switch (provider) {
        case 'zoho': {
          const signature = req.headers['x-zoho-signature'] as string;
          const timestamp = req.headers['x-zoho-timestamp'] as string;
          const payload = JSON.stringify(req.body);
          
          // Zoho uses HMAC-SHA256
          const expectedSignature = crypto
            .createHmac('sha256', process.env.ZOHO_WEBHOOK_SECRET!)
            .update(`${timestamp}.${payload}`)
            .digest('hex');
          
          return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
          );
        }

        case 'whatsapp': {
          const signature = req.headers['x-hub-signature-256'] as string;
          const payload = JSON.stringify(req.body);
          
          // WhatsApp uses HMAC-SHA256 with 'sha256=' prefix
          const hmac = crypto
            .createHmac('sha256', process.env.WHATSAPP_APP_SECRET!)
            .update(payload)
            .digest('hex');
          
          return signature === `sha256=${hmac}`;
        }

        case 'quickbooks': {
          const signature = req.headers['intuit-signature'] as string;
          const payload = JSON.stringify(req.body);
          
          // QuickBooks uses HMAC-SHA256
          const expectedSignature = crypto
            .createHmac('sha256', process.env.QUICKBOOKS_WEBHOOK_TOKEN!)
            .update(payload)
            .digest('base64');
          
          return signature === expectedSignature;
        }

        default:
          return true; // No verification for unknown providers
      }
    } catch (error) {
      logger.error(`Signature verification failed for ${provider}:`, error);
      return false;
    }
  }

  /**
   * Find integration from webhook data
   */
  private static async findIntegrationFromWebhook(
    provider: string,
    req: Request
  ): Promise<any> {
    let accountEmail: string | undefined;

    switch (provider) {
      case 'zoho':
        accountEmail = req.body?.configuration?.email || req.body?.email;
        break;
      case 'whatsapp':
        // WhatsApp webhooks are linked to phone number ID
        const phoneNumberId = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
        if (phoneNumberId) {
          const result = await db.query(
            `SELECT * FROM account_integrations 
             WHERE provider = 'whatsapp' 
             AND metadata->>'phone_number_id' = $1 
             AND status = 'active'`,
            [phoneNumberId]
          );
          return result.rows[0];
        }
        break;
      case 'quickbooks':
        // QuickBooks webhooks include realmId (company ID)
        const realmId = req.headers['intuit-realmid'];
        if (realmId) {
          const result = await db.query(
            `SELECT * FROM account_integrations 
             WHERE provider = 'quickbooks' 
             AND account_id = $1 
             AND status = 'active'`,
            [realmId]
          );
          return result.rows[0];
        }
        break;
    }

    if (accountEmail) {
      const integrations = await AccountIntegrationModel.findByBusiness('all');
      return integrations.find(i => 
        i.provider === provider && 
        i.account_email === accountEmail &&
        i.status === 'active'
      );
    }

    return null;
  }

  /**
   * Queue webhook for parallel processing
   */
  private static async queueForProcessing(
    provider: string,
    integration: any,
    payload: any,
    webhookId: string
  ): Promise<void> {
    // Determine processing priority based on event type
    let priority = 0; // Default priority
    let queue = webhookQueue;

    // High priority events (invoices, payments)
    if (this.isHighPriorityEvent(provider, payload)) {
      priority = 1;
    }

    // Very high priority (account disconnection, errors)
    if (this.isCriticalEvent(provider, payload)) {
      priority = 2;
      // Send immediate notification for critical events
      await this.sendCriticalNotification(integration, payload);
    }

    // Add to queue for processing
    await queue.add('process-webhook', {
      webhookId,
      provider,
      integrationId: integration.id,
      businessId: integration.business_id,
      payload,
      timestamp: new Date().toISOString()
    }, {
      priority,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000
      }
    });

    // Also trigger sync for invoice/payment events
    if (this.isSyncTriggerEvent(provider, payload)) {
      await syncQueue.add('trigger-sync', {
        integrationId: integration.id,
        businessId: integration.business_id,
        eventType: payload.event_type || 'update',
        timestamp: new Date().toISOString()
      });
    }
  }

  private static isHighPriorityEvent(provider: string, payload: any): boolean {
    switch (provider) {
      case 'zoho':
        return ['invoice.created', 'invoice.paid', 'payment.received'].includes(payload.event);
      case 'quickbooks':
        return payload.eventNotifications?.some((n: any) => 
          n.dataChangeEvent?.entities?.some((e: any) => 
            ['Invoice', 'Payment'].includes(e.name)
          )
        );
      case 'whatsapp':
        return payload.entry?.[0]?.changes?.[0]?.field === 'messages';
      default:
        return false;
    }
  }

  private static isCriticalEvent(provider: string, payload: any): boolean {
    switch (provider) {
      case 'zoho':
        return ['connection.revoked', 'token.expired'].includes(payload.event);
      case 'quickbooks':
        return payload.eventNotifications?.some((n: any) => 
          n.dataChangeEvent?.entities?.some((e: any) => 
            e.name === 'Disconnect'
          )
        );
      default:
        return false;
    }
  }

  private static isSyncTriggerEvent(provider: string, payload: any): boolean {
    return this.isHighPriorityEvent(provider, payload);
  }

  private static async sendCriticalNotification(integration: any, payload: any): Promise<void> {
    // Queue notification for immediate sending
    const notificationQueue = new Queue('notifications', { connection: redisConnection });
    
    await notificationQueue.add('send-immediate', {
      type: 'integration_alert',
      businessId: integration.business_id,
      integrationId: integration.id,
      provider: integration.provider,
      alertType: 'action_required',
      message: `Integration with ${integration.provider} requires attention`,
      payload
    }, {
      priority: 1,
      attempts: 5
    });
  }
}
