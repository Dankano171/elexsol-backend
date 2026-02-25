import { Job } from 'bullmq';
import { queueService } from './QueueService';
import { notificationService } from '../notification/NotificationService';
import { emailChannel } from '../notification/channels/EmailChannel';
import { smsChannel } from '../notification/channels/SMSChannel';
import { pushChannel } from '../notification/channels/PushChannel';
import { whatsappChannel } from '../notification/channels/WhatsAppChannel';
import { logger } from '../../config/logger';

export interface NotificationJobData {
  notificationId: string;
  businessId: string;
  userId?: string;
  type: string;
  title: string;
  body: string;
  channels: string[];
  data?: Record<string, any>;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface DigestJobData {
  businessId: string;
  userId?: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  scheduledTime: Date;
}

export class NotificationQueue {
  private readonly queueName = 'notification';
  private initialized = false;

  /**
   * Initialize notification queue
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create queue
    queueService.createQueue({
      name: this.queueName,
      concurrency: 10,
      maxRetries: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      },
      timeout: 30000
    });

    // Create worker
    queueService.createWorker<NotificationJobData>(
      this.queueName,
      this.processNotification.bind(this),
      {
        concurrency: 10
      }
    );

    this.initialized = true;
    logger.info('Notification queue initialized');
  }

  /**
   * Process notification job
   */
  private async processNotification(job: Job<NotificationJobData>): Promise<any> {
    const { data } = job;

    logger.debug('Processing notification job', {
      jobId: job.id,
      notificationId: data.notificationId,
      channels: data.channels,
      attempt: job.attemptsMade
    });

    const results: Record<string, any> = {};

    // Send through each channel
    for (const channel of data.channels) {
      try {
        let result;
        
        switch (channel) {
          case 'email':
            result = await this.sendEmail(data);
            break;
          case 'sms':
            result = await this.sendSMS(data);
            break;
          case 'push':
            result = await this.sendPush(data);
            break;
          case 'whatsapp':
            result = await this.sendWhatsApp(data);
            break;
          case 'inapp':
            result = await this.sendInApp(data);
            break;
        }

        results[channel] = { success: true, result };
      } catch (error) {
        logger.error(`Error sending via ${channel}:`, error);
        results[channel] = { success: false, error: error.message };
      }
    }

    return results;
  }

  /**
   * Send email notification
   */
  private async sendEmail(data: NotificationJobData): Promise<any> {
    return emailChannel.sendNotification({
      userId: data.userId,
      businessId: data.businessId,
      title: data.title,
      body: data.body,
      data: data.data,
      preferences: {} // Would get from user preferences
    });
  }

  /**
   * Send SMS notification
   */
  private async sendSMS(data: NotificationJobData): Promise<any> {
    return smsChannel.sendNotification({
      userId: data.userId,
      businessId: data.businessId,
      title: data.title,
      body: data.body,
      data: data.data,
      preferences: {} // Would get from user preferences
    });
  }

  /**
   * Send push notification
   */
  private async sendPush(data: NotificationJobData): Promise<any> {
    return pushChannel.sendNotification({
      userId: data.userId,
      businessId: data.businessId,
      title: data.title,
      body: data.body,
      data: data.data,
      preferences: {} // Would get from user preferences
    });
  }

  /**
   * Send WhatsApp notification
   */
  private async sendWhatsApp(data: NotificationJobData): Promise<any> {
    return whatsappChannel.sendNotification({
      userId: data.userId,
      businessId: data.businessId,
      title: data.title,
      body: data.body,
      data: data.data,
      preferences: {} // Would get from user preferences
    });
  }

  /**
   * Send in-app notification
   */
  private async sendInApp(data: NotificationJobData): Promise<any> {
    // In-app notifications are handled by the InAppChannel
    // This would be implemented similarly
    return { success: true };
  }

  /**
   * Add notification to queue
   */
  async addToQueue(data: NotificationJobData, delay?: number): Promise<Job<NotificationJobData>> {
    await this.ensureInitialized();

    return queueService.addJob<NotificationJobData>(
      this.queueName,
      `notification-${data.type}`,
      data,
      {
        jobId: `notification-${data.notificationId}`,
        delay,
        attempts: 3,
        priority: this.getPriorityValue(data.priority)
      }
    );
  }

  /**
   * Add bulk notifications
   */
  async addBulk(jobs: NotificationJobData[]): Promise<Job[]> {
    await this.ensureInitialized();

    return queueService.addBulk(
      this.queueName,
      jobs.map(job => ({
        name: `notification-${job.type}`,
        data: job,
        options: {
          jobId: `notification-${job.notificationId}`,
          attempts: 3,
          priority: this.getPriorityValue(job.priority)
        }
      }))
    );
  }

  /**
   * Schedule digest
   */
  async scheduleDigest(data: DigestJobData): Promise<Job<DigestJobData>> {
    await this.ensureInitialized();

    const delay = data.scheduledTime.getTime() - Date.now();

    return queueService.addJob<DigestJobData>(
      this.queueName,
      `digest-${data.frequency}`,
      data,
      {
        jobId: `digest-${data.businessId}-${data.frequency}-${Date.now()}`,
        delay: Math.max(0, delay),
        attempts: 2
      }
    );
  }

  /**
   * Process digest
   */
  async processDigest(job: Job<DigestJobData>): Promise<any> {
    const { data } = job;

    logger.info('Processing digest', {
      businessId: data.businessId,
      frequency: data.frequency
    });

    // Get pending notifications for business
    // This would aggregate notifications from the database
    // Placeholder implementation

    return { processed: true };
  }

  /**
   * Get priority value for BullMQ
   */
  private getPriorityValue(priority: string): number {
    switch (priority) {
      case 'critical':
        return 1;
      case 'high':
        return 2;
      case 'medium':
        return 3;
      case 'low':
        return 4;
      default:
        return 3;
    }
  }

  /**
   * Get queue metrics
   */
  async getMetrics(): Promise<any> {
    await this.ensureInitialized();
    return queueService.getMetrics(this.queueName);
  }

  /**
   * Get job status
   */
  async getJobStatus(notificationId: string): Promise<any> {
    await this.ensureInitialized();

    const jobId = `notification-${notificationId}`;
    const job = await queueService.getJob(this.queueName, jobId);

    if (!job) return null;

    const state = await job.getState();

    return {
      jobId: job.id,
      status: state,
      attempts: job.attemptsMade,
      error: job.failedReason,
      result: job.returnvalue
    };
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

export const notificationQueue = new NotificationQueue();
