import axios, { AxiosError } from 'axios';
import { webhookEventRepository } from '../../repositories/WebhookEventRepository';
import { webhookService } from './WebhookService';
import { logger } from '../../config/logger';
import { redis } from '../../config/redis';
import crypto from 'crypto';

export interface WebhookJob {
  eventId: string;
  webhookId: string;
  integrationId: string;
  businessId: string;
  provider: string;
  payload: any;
  headers: Record<string, string>;
  url: string;
  secret: string;
  retryCount?: number;
}

export interface WebhookResult {
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  duration: number;
}

export class WebhookProcessor {
  private readonly maxRetries = 3;
  private readonly retryDelays = [1000, 5000, 30000]; // 1s, 5s, 30s
  private readonly timeout = 10000; // 10 seconds

  /**
   * Process webhook job
   */
  async process(job: WebhookJob): Promise<WebhookResult> {
    const startTime = Date.now();

    try {
      // Check if webhook is paused
      const isPaused = await this.isWebhookPaused(job.webhookId);
      if (isPaused) {
        logger.info('Webhook is paused, skipping', { webhookId: job.webhookId });
        await webhookEventRepository.markFailed(job.eventId, 'Webhook is paused');
        return {
          success: false,
          error: 'Webhook is paused',
          duration: Date.now() - startTime
        };
      }

      // Prepare request
      const config = {
        url: job.url,
        method: 'POST',
        headers: job.headers,
        data: job.payload,
        timeout: this.timeout,
        validateStatus: (status: number) => status < 300 // Only accept 2xx
      };

      // Send webhook
      const response = await axios(config);

      const duration = Date.now() - startTime;

      // Log success
      await webhookEventRepository.markCompleted(
        job.eventId,
        response.status,
        JSON.stringify(response.data)
      );

      // Reset failure count on success
      await this.resetFailureCount(job.webhookId);

      logger.info('Webhook delivered successfully', {
        eventId: job.eventId,
        webhookId: job.webhookId,
        statusCode: response.status,
        duration
      });

      return {
        success: true,
        statusCode: response.status,
        responseBody: JSON.stringify(response.data),
        duration
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return this.handleWebhookError(job, error, duration);
    }
  }

  /**
   * Handle webhook error
   */
  private async handleWebhookError(
    job: WebhookJob,
    error: any,
    duration: number
  ): Promise<WebhookResult> {
    const axiosError = error as AxiosError;
    const statusCode = axiosError.response?.status;
    const errorMessage = this.getErrorMessage(error);
    const retryCount = (job.retryCount || 0) + 1;

    logger.warn('Webhook delivery failed', {
      eventId: job.eventId,
      webhookId: job.webhookId,
      statusCode,
      error: errorMessage,
      retryCount,
      duration
    });

    // Increment failure count
    await this.incrementFailureCount(job.webhookId);

    // Check if we should retry
    if (retryCount <= this.maxRetries && this.shouldRetry(statusCode)) {
      const delay = this.retryDelays[retryCount - 1];
      
      logger.info('Scheduling webhook retry', {
        eventId: job.eventId,
        retryCount,
        delay
      });

      // Schedule retry
      await this.scheduleRetry(job, retryCount, delay);
      
      return {
        success: false,
        statusCode,
        error: errorMessage,
        duration
      };
    }

    // Max retries exceeded or non-retryable error
    await webhookEventRepository.markFailed(
      job.eventId,
      errorMessage,
      retryCount,
      statusCode
    );

    // Check if webhook should be paused
    await this.checkAndPauseWebhook(job.webhookId);

    return {
      success: false,
      statusCode,
      error: errorMessage,
      duration
    };
  }

  /**
   * Schedule retry
   */
  private async scheduleRetry(
    job: WebhookJob,
    retryCount: number,
    delay: number
  ): Promise<void> {
    const key = `webhook_retry:${job.eventId}`;
    
    await redis.setex(
      key,
      Math.ceil(delay / 1000),
      JSON.stringify({
        ...job,
        retryCount
      })
    );

    // Update event status
    await webhookEventRepository.update(job.eventId, {
      status: 'pending',
      attempts: retryCount,
      next_retry_at: new Date(Date.now() + delay)
    });
  }

  /**
   * Check if webhook is paused
   */
  private async isWebhookPaused(webhookId: string): Promise<boolean> {
    const key = `webhook:${webhookId}`;
    const data = await redis.get(key);
    
    if (!data) return false;
    
    const registration = JSON.parse(data);
    return registration.status === 'paused';
  }

  /**
   * Increment failure count
   */
  private async incrementFailureCount(webhookId: string): Promise<void> {
    const key = `webhook:${webhookId}`;
    const data = await redis.get(key);
    
    if (data) {
      const registration = JSON.parse(data);
      registration.failureCount = (registration.failureCount || 0) + 1;
      await redis.setex(key, 86400 * 30, JSON.stringify(registration));
    }
  }

  /**
   * Reset failure count
   */
  private async resetFailureCount(webhookId: string): Promise<void> {
    const key = `webhook:${webhookId}`;
    const data = await redis.get(key);
    
    if (data) {
      const registration = JSON.parse(data);
      registration.failureCount = 0;
      await redis.setex(key, 86400 * 30, JSON.stringify(registration));
    }
  }

  /**
   * Check and pause webhook if too many failures
   */
  private async checkAndPauseWebhook(webhookId: string): Promise<void> {
    const key = `webhook:${webhookId}`;
    const data = await redis.get(key);
    
    if (data) {
      const registration = JSON.parse(data);
      
      if (registration.failureCount >= 10) {
        await webhookService.pauseWebhook(webhookId);
        
        logger.warn('Webhook paused due to high failure rate', {
          webhookId,
          failureCount: registration.failureCount
        });
      }
    }
  }

  /**
   * Determine if we should retry based on status code
   */
  private shouldRetry(statusCode?: number): boolean {
    if (!statusCode) return true; // Network errors
    
    // Retry on server errors and rate limits
    return statusCode >= 500 || statusCode === 429;
  }

  /**
   * Get error message from error object
   */
  private getErrorMessage(error: any): string {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        return `HTTP ${error.response.status}: ${error.response.statusText}`;
      } else if (error.request) {
        return 'No response received from server';
      } else {
        return error.message;
      }
    }
    return error.message || 'Unknown error';
  }

  /**
   * Process retry queue
   */
  async processRetryQueue(): Promise<void> {
    const pattern = 'webhook_retry:*';
    const keys = await redis.keys(pattern);

    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;

      const job = JSON.parse(data);
      
      // Check if it's time to retry
      const ttl = await redis.ttl(key);
      if (ttl > 0) continue;

      // Remove from retry queue
      await redis.del(key);

      // Process webhook
      await this.process(job);
    }
  }

  /**
   * Verify webhook signature
   */
  verifySignature(
    payload: string,
    signature: string,
    secret: string,
    timestamp?: string
  ): boolean {
    if (timestamp) {
      // Check timestamp freshness (5 minutes)
      const now = Math.floor(Date.now() / 1000);
      const ts = parseInt(timestamp);
      if (Math.abs(now - ts) > 300) {
        return false; // Timestamp too old
      }
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}

export const webhookProcessor = new WebhookProcessor();
