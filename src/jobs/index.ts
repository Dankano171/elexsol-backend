import { syncScheduler } from './sync-scheduler';
import { digestScheduler } from './digest-scheduler';
import { tokenRefresher } from './token-refresher';
import { analyticsAggregator } from './analytics-aggregator';
import { cleanupJobs } from './cleanup-jobs';
import { logger } from '../config/logger';

/**
 * Start all background jobs
 */
export const startAllJobs = (): void => {
  logger.info('Starting all background jobs...');

  syncScheduler.start();
  digestScheduler.start();
  tokenRefresher.start();
  analyticsAggregator.start();
  cleanupJobs.start();

  logger.info('All background jobs started');
};

/**
 * Stop all background jobs
 */
export const stopAllJobs = (): void => {
  logger.info('Stopping all background jobs...');

  syncScheduler.stop();
  digestScheduler.stop();
  tokenRefresher.stop();
  analyticsAggregator.stop();
  cleanupJobs.stop();

  logger.info('All background jobs stopped');
};

/**
 * Get status of all jobs
 */
export const getAllJobsStatus = (): any => {
  return {
    syncScheduler: syncScheduler.getStatus(),
    digestScheduler: digestScheduler.getStatus(),
    tokenRefresher: tokenRefresher.getStatus(),
    analyticsAggregator: analyticsAggregator.getStatus(),
    cleanupJobs: cleanupJobs.getStatus()
  };
};

/**
 * Initialize jobs (called on app startup)
 */
export const initializeJobs = async (): Promise<void> => {
  try {
    // Run initial cleanup
    await cleanupJobs.runManualCleanup('daily');
    
    // Start all jobs
    startAllJobs();

    logger.info('Jobs initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize jobs:', error);
    throw error;
  }
};

// Export individual job instances
export {
  syncScheduler,
  digestScheduler,
  tokenRefresher,
  analyticsAggregator,
  cleanupJobs
};
