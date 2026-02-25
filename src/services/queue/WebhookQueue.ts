import { Job } from 'bullmq';
import { queueService } from './QueueService';
import { webhookProcessor } from '../webhook/WebhookProcessor';
import { logger } from '../../config/logger';

export interface WebhookJobData {
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

export class WebhookQueue {
  private readonly queueName = 'webhook';
  private initialized = false;

  /**
   * Initialize webhook queue
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create queue
    queueService.createQueue({
      name: this.queueName,
      concurrency: 20,
      maxRetries: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      },
      timeout: 30000
    });

    // Create worker
    queueService.createWorker<WebhookJobData>(
      this.queueName,
      this.processWebhook.bind(this),
      {
        concurrency: 20
      }
    );

    this.initialized = true;
    logger.info('Webhook queue initialized');
  }

  /**
   * Process webhook job
   */
  private async processWebhook(job: Job<WebhookJobData>): Promise<any> {
    const { data } = job;

    logger.debug('Processing webhook job', {
      jobId: job.id,
      eventId: data.eventId,
      webhookId: data.webhookId,
      attempt: job.attemptsMade
    });

    // Process webhook
    const result = await webhookProcessor.process({
      ...data,
      retryCount: job.attemptsMade
    });

    if (!result.success) {
      throw new Error(result.error || 'Webhook delivery failed');
    }

    return result;
  }

  /**
   * Add webhook to queue
   */
  async addToQueue(data: WebhookJobData, delay?: number): Promise<Job<WebhookJobData>> {
    await this.ensureInitialized();

    return queueService.addJob<WebhookJobData>(
      this.queueName,
      'webhook-delivery',
      data,
      {
        jobId: `webhook-${data.eventId}`,
        delay,
        attempts: 3
      }
    );
  }

  /**
   * Add bulk webhooks
   */
  async addBulk(jobs: WebhookJobData[]): Promise<Job[]> {
    await this.ensureInitialized();

    return queueService.addBulk(
      this.queueName,
      jobs.map(job => ({
        name: 'webhook-delivery',
        data: job,
        options: {
          jobId: `webhook-${job.eventId}`,
          attempts: 3
        }
      }))
    );
  }

  /**
   * Get webhook job status
   */
  async getJobStatus(eventId: string): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed';
    attempts?: number;
    error?: string;
    result?: any;
  } | null> {
    await this.ensureInitialized();

    const jobId = `webhook-${eventId}`;
    const job = await queueService.getJob(this.queueName, jobId);

    if (!job) return null;

    const state = await job.getState();

    return {
      status: state as any,
      attempts: job.attemptsMade,
      error: job.failedReason,
      result: job.returnvalue
    };
  }

  /**
   * Get queue metrics
   */
  async getMetrics(): Promise<any> {
    await this.ensureInitialized();
    return queueService.getMetrics(this.queueName);
  }

  /**
   * Retry failed webhooks
   */
  async retryFailed(limit: number = 100): Promise<number> {
    await this.ensureInitialized();
    return queueService.retryFailed(this.queueName, limit);
  }

  /**
   * Clean old webhook jobs
   */
  async clean(grace: number = 86400): Promise<void> {
    await this.ensureInitialized();
    await queueService.cleanQueue(this.queueName, grace);
  }

  /**
   * Pause webhook processing
   */
  async pause(): Promise<void> {
    await this.ensureInitialized();
    await queueService.pauseQueue(this.queueName);
  }

  /**
   * Resume webhook processing
   */
  async resume(): Promise<void> {
    await this.ensureInitialized();
    await queueService.resumeQueue(this.queueName);
  }

  /**
   * Get queue status
   */
  async getStatus(): Promise<any> {
    await this.ensureInitialized();
    return queueService.getQueueStatus(this.queueName);
  }

  /**
   * Ensure queue is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

export const webhookQueue = new WebhookQueue();
