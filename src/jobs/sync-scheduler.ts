import { CronJob } from 'cron';
import { integrationService } from '../services/integrations/IntegrationService';
import { accountIntegrationRepository } from '../repositories/AccountIntegrationRepository';
import { logger } from '../config/logger';
import { redis } from '../config/redis';

export class SyncScheduler {
  private job: CronJob;
  private readonly syncInterval = '*/15 * * * *'; // Every 15 minutes

  constructor() {
    this.job = new CronJob(
      this.syncInterval,
      this.execute.bind(this),
      null,
      false, // Don't start automatically
      'Africa/Lagos'
    );
  }

  /**
   * Start the scheduler
   */
  start(): void {
    this.job.start();
    logger.info('Sync scheduler started');
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    this.job.stop();
    logger.info('Sync scheduler stopped');
  }

  /**
   * Execute sync for all due integrations
   */
  private async execute(): Promise<void> {
    try {
      logger.info('Starting scheduled sync');

      // Get all active integrations
      const integrations = await accountIntegrationRepository.find({
        status: 'active',
        sync_status: 'idle'
      });

      let synced = 0;
      let failed = 0;

      for (const integration of integrations) {
        try {
          // Check if sync is due based on interval setting
          if (!this.isSyncDue(integration)) {
            continue;
          }

          // Queue sync
          await integrationService.queueSync(integration.id, integration.business_id);
          synced++;

          logger.debug('Queued integration sync', {
            integrationId: integration.id,
            provider: integration.provider
          });
        } catch (error) {
          failed++;
          logger.error('Failed to queue integration sync', {
            integrationId: integration.id,
            error: error.message
          });
        }
      }

      logger.info('Scheduled sync completed', {
        total: integrations.length,
        synced,
        failed
      });
    } catch (error) {
      logger.error('Sync scheduler execution failed:', error);
    }
  }

  /**
   * Check if sync is due based on integration settings
   */
  private isSyncDue(integration: any): boolean {
    // If never synced, sync now
    if (!integration.last_sync_at) {
      return true;
    }

    const syncInterval = integration.settings?.syncInterval || 60; // Default 60 minutes
    const nextSync = new Date(integration.last_sync_at);
    nextSync.setMinutes(nextSync.getMinutes() + syncInterval);

    return new Date() >= nextSync;
  }

  /**
   * Get scheduler status
   */
  getStatus(): any {
    return {
      running: this.job.running,
      nextRun: this.job.nextDate().toJSDate(),
      lastRun: this.job.lastDate(),
      interval: this.syncInterval
    };
  }

  /**
   * Force sync for a specific integration
   */
  async forceSync(integrationId: string): Promise<void> {
    const integration = await accountIntegrationRepository.findById(integrationId);
    
    if (!integration) {
      throw new Error('Integration not found');
    }

    await integrationService.queueSync(integrationId, integration.business_id);
    
    logger.info('Forced sync queued', { integrationId });
  }
}

export const syncScheduler = new SyncScheduler();
