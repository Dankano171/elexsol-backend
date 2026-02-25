import { CronJob } from 'cron';
import { auditLogRepository } from '../repositories/AuditLogRepository';
import { webhookEventRepository } from '../repositories/WebhookEventRepository';
import { sessionService } from '../services/auth/SessionService';
import { pushChannel } from '../services/notification/channels/PushChannel';
import { redis } from '../config/redis';
import { logger } from '../config/logger';

export class CleanupJobs {
  private hourlyJob: CronJob;
  private dailyJob: CronJob;
  private weeklyJob: CronJob;

  constructor() {
    // Hourly cleanup (every hour at minute 0)
    this.hourlyJob = new CronJob(
      '0 * * * *',
      this.cleanupHourly.bind(this),
      null,
      false,
      'Africa/Lagos'
    );

    // Daily cleanup at 2:00 AM
    this.dailyJob = new CronJob(
      '0 2 * * *',
      this.cleanupDaily.bind(this),
      null,
      false,
      'Africa/Lagos'
    );

    // Weekly cleanup on Sunday at 3:00 AM
    this.weeklyJob = new CronJob(
      '0 3 * * 0',
      this.cleanupWeekly.bind(this),
      null,
      false,
      'Africa/Lagos'
    );
  }

  /**
   * Start all cleanup jobs
   */
  start(): void {
    this.hourlyJob.start();
    this.dailyJob.start();
    this.weeklyJob.start();
    logger.info('Cleanup jobs started');
  }

  /**
   * Stop all cleanup jobs
   */
  stop(): void {
    this.hourlyJob.stop();
    this.dailyJob.stop();
    this.weeklyJob.stop();
    logger.info('Cleanup jobs stopped');
  }

  /**
   * Hourly cleanup tasks
   */
  private async cleanupHourly(): Promise<void> {
    try {
      logger.info('Starting hourly cleanup');

      // Clean up expired sessions
      const expiredSessions = await sessionService.cleanupExpiredSessions();
      
      // Clean up expired Redis keys
      const redisKeys = await this.cleanupRedisKeys();

      logger.info('Hourly cleanup completed', {
        expiredSessions,
        redisKeys
      });
    } catch (error) {
      logger.error('Hourly cleanup failed:', error);
    }
  }

  /**
   * Daily cleanup tasks
   */
  private async cleanupDaily(): Promise<void> {
    try {
      logger.info('Starting daily cleanup');

      // Clean up old webhook events (keep 30 days)
      const webhookEvents = await webhookEventRepository.cleanupOldEvents(30);
      
      // Clean up old push tokens
      const pushTokens = await pushChannel.cleanupTokens();

      // Clean up old temporary files
      const tempFiles = await this.cleanupTempFiles();

      logger.info('Daily cleanup completed', {
        webhookEvents,
        pushTokens,
        tempFiles
      });
    } catch (error) {
      logger.error('Daily cleanup failed:', error);
    }
  }

  /**
   * Weekly cleanup tasks
   */
  private async cleanupWeekly(): Promise<void> {
    try {
      logger.info('Starting weekly cleanup');

      // Clean up old audit logs (keep 1 year)
      const auditLogs = await auditLogRepository.cleanupOldLogs(365);
      
      // Clean up old regulatory logs (keep 90 days)
      // This would be implemented in RegulatoryLogRepository
      
      // Clean up old exports
      const exports = await this.cleanupOldExports();

      logger.info('Weekly cleanup completed', {
        auditLogs,
        exports
      });
    } catch (error) {
      logger.error('Weekly cleanup failed:', error);
    }
  }

  /**
   * Clean up expired Redis keys
   */
  private async cleanupRedisKeys(): Promise<number> {
    try {
      // Find keys with no TTL
      const keys = await redis.keys('*');
      let cleaned = 0;

      for (const key of keys) {
        const ttl = await redis.ttl(key);
        if (ttl === -1) { // No expiry set
          // Set expiry for keys that should have one
          if (key.startsWith('session:')) {
            await redis.expire(key, 86400); // 24 hours
          } else if (key.startsWith('rate_limit:')) {
            await redis.expire(key, 3600); // 1 hour
          } else if (key.startsWith('temp:')) {
            await redis.del(key);
            cleaned++;
          }
        }
      }

      return cleaned;
    } catch (error) {
      logger.error('Failed to cleanup Redis keys:', error);
      return 0;
    }
  }

  /**
   * Clean up temporary files
   */
  private async cleanupTempFiles(): Promise<number> {
    // In production, would delete old files from temp directory
    // This is a placeholder
    return 0;
  }

  /**
   * Clean up old exports
   */
  private async cleanupOldExports(): Promise<number> {
    // In production, would delete old exported files from storage
    // This is a placeholder
    return 0;
  }

  /**
   * Run manual cleanup
   */
  async runManualCleanup(type: 'hourly' | 'daily' | 'weekly'): Promise<any> {
    logger.info('Running manual cleanup', { type });

    switch (type) {
      case 'hourly':
        await this.cleanupHourly();
        break;
      case 'daily':
        await this.cleanupDaily();
        break;
      case 'weekly':
        await this.cleanupWeekly();
        break;
    }

    return { success: true, type };
  }

  /**
   * Get cleanup status
   */
  getStatus(): any {
    return {
      hourly: {
        running: this.hourlyJob.running,
        nextRun: this.hourlyJob.nextDate().toJSDate()
      },
      daily: {
        running: this.dailyJob.running,
        nextRun: this.dailyJob.nextDate().toJSDate()
      },
      weekly: {
        running: this.weeklyJob.running,
        nextRun: this.weeklyJob.nextDate().toJSDate()
      }
    };
  }
}

export const cleanupJobs = new CleanupJobs();
