import { Router, Request, Response } from 'express';
import { webhookService } from './WebhookService';
import { webhookValidator } from './WebhookValidator';
import { webhookSecurity } from './WebhookSecurity';
import { logger } from '../../config/logger';
import { redis } from '../../config/redis';
import rateLimit from 'express-rate-limit';

export class WebhookRouter {
  private router: Router;

  constructor() {
    this.router = Router();
    this.setupRoutes();
  }

  /**
   * Setup webhook routes
   */
  private setupRoutes(): void {
    // Provider-specific webhooks
    this.router.post('/zoho', this.createWebhookHandler('zoho'));
    this.router.post('/whatsapp', this.createWebhookHandler('whatsapp'));
    this.router.post('/quickbooks', this.createWebhookHandler('quickbooks'));
    
    // Generic webhook endpoint
    this.router.post('/:provider', this.createWebhookHandler('generic'));
    
    // Webhook verification endpoints
    this.router.get('/whatsapp', this.handleWhatsAppVerification.bind(this));
    
    // Health check
    this.router.get('/health', this.handleHealthCheck.bind(this));
  }

  /**
   * Create webhook handler for specific provider
   */
  private createWebhookHandler(provider: string) {
    return async (req: Request, res: Response) => {
      const startTime = Date.now();
      const requestId = `webhook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      try {
        // Apply security middleware
        const securityCheck = await webhookSecurity.checkRequest(req, provider);
        if (!securityCheck.allowed) {
          logger.warn('Webhook request blocked by security', {
            requestId,
            provider,
            reason: securityCheck.reason,
            ip: req.ip
          });
          return res.status(403).json({ error: 'Access denied' });
        }

        // Apply rate limiting
        const rateLimit = await webhookSecurity.checkRateLimit(req, provider);
        if (rateLimit.limited) {
          logger.warn('Webhook rate limit exceeded', {
            requestId,
            provider,
            ip: req.ip
          });
          return res.status(429).json({ 
            error: 'Rate limit exceeded',
            resetAt: rateLimit.resetAt
          });
        }

        // Validate payload
        const validation = webhookValidator.validatePayload(provider, req.body);
        if (!validation.valid) {
          logger.warn('Invalid webhook payload', {
            requestId,
            provider,
            errors: validation.errors
          });
          
          // Log invalid payload for debugging
          await this.logInvalidPayload(requestId, provider, req, validation);
          
          // Still return 200 to prevent webhook providers from retrying
          return res.status(200).json({ 
            received: true,
            warnings: validation.warnings
          });
        }

        // Process webhook
        const result = await webhookService.processIncomingWebhook(
          provider,
          req.headers as any,
          req.body,
          req.ip
        );

        // Log metrics
        const duration = Date.now() - startTime;
        await this.logWebhookMetrics(requestId, provider, duration, result);

        // Return success (always 200 to webhook providers)
        res.status(200).json(result);
      } catch (error) {
        logger.error('Webhook handler error', {
          requestId,
          provider,
          error: error.message,
          stack: error.stack
        });

        // Always return 200 to webhook providers
        res.status(200).json({ received: true });
      }
    };
  }

  /**
   * Handle WhatsApp verification
   */
  private handleWhatsAppVerification(req: Request, res: Response): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('WhatsApp webhook verified');
      res.status(200).send(challenge);
    } else {
      logger.warn('WhatsApp webhook verification failed', {
        mode,
        token
      });
      res.sendStatus(403);
    }
  }

  /**
   * Handle health check
   */
  private async handleHealthCheck(req: Request, res: Response): Promise<void> {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      metrics: await this.getHealthMetrics()
    };

    res.status(200).json(health);
  }

  /**
   * Log invalid payload
   */
  private async logInvalidPayload(
    requestId: string,
    provider: string,
    req: Request,
    validation: any
  ): Promise<void> {
    const key = `webhook:invalid:${requestId}`;
    await redis.setex(key, 86400, JSON.stringify({
      requestId,
      provider,
      timestamp: new Date().toISOString(),
      headers: req.headers,
      payload: req.body,
      errors: validation.errors,
      warnings: validation.warnings,
      ip: req.ip
    }));

    logger.warn('Invalid webhook payload stored', { requestId, key });
  }

  /**
   * Log webhook metrics
   */
  private async logWebhookMetrics(
    requestId: string,
    provider: string,
    duration: number,
    result: any
  ): Promise<void> {
    const date = new Date().toISOString().split('T')[0];
    const key = `webhook:metrics:${provider}:${date}`;

    await redis.hincrby(key, 'total', 1);
    await redis.hincrby(key, 'duration', duration);
    await redis.expire(key, 86400 * 7); // 7 days

    // Store request details for debugging
    if (process.env.NODE_ENV !== 'production') {
      const detailKey = `webhook:detail:${requestId}`;
      await redis.setex(detailKey, 3600, JSON.stringify({
        provider,
        duration,
        result,
        timestamp: new Date().toISOString()
      }));
    }
  }

  /**
   * Get health metrics
   */
  private async getHealthMetrics(): Promise<any> {
    const metrics: any = {};

    // Get today's metrics for each provider
    const providers = ['zoho', 'whatsapp', 'quickbooks', 'generic'];
    const date = new Date().toISOString().split('T')[0];

    for (const provider of providers) {
      const key = `webhook:metrics:${provider}:${date}`;
      const data = await redis.hgetall(key);
      
      if (Object.keys(data).length > 0) {
        metrics[provider] = {
          total: parseInt(data.total) || 0,
          avgDuration: data.total ? Math.round(parseInt(data.duration) / parseInt(data.total)) : 0
        };
      }
    }

    // Get queue size
    const queueSize = await this.getWebhookQueueSize();

    return {
      ...metrics,
      queueSize,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get webhook queue size
   */
  private async getWebhookQueueSize(): Promise<number> {
    const keys = await redis.keys('webhook_retry:*');
    return keys.length;
  }

  /**
   * Get router instance
   */
  getRouter(): Router {
    return this.router;
  }
}

export const webhookRouter = new WebhookRouter();
