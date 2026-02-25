import { Queue, Worker, QueueScheduler, Job, WorkerOptions } from 'bullmq';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { EventEmitter } from 'events';

export interface QueueConfig {
  name: string;
  concurrency?: number;
  maxRetries?: number;
  backoff?: {
    type: 'fixed' | 'exponential';
    delay: number;
  };
  timeout?: number;
}

export interface QueueJob<T = any> {
  id: string;
  name: string;
  data: T;
  attempts: number;
  timestamp: Date;
  processedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  error?: string;
  result?: any;
}

export interface QueueMetrics {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
  averageProcessingTime: number;
  throughput: number;
}

export class QueueService extends EventEmitter {
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private schedulers: Map<string, QueueScheduler> = new Map();
  private readonly defaultConfig: QueueConfig = {
    name: 'default',
    concurrency: 5,
    maxRetries: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    timeout: 30000
  };

  /**
   * Create or get queue
   */
  createQueue(config: QueueConfig): Queue {
    const queueConfig = { ...this.defaultConfig, ...config };
    
    if (this.queues.has(queueConfig.name)) {
      return this.queues.get(queueConfig.name)!;
    }

    const queue = new Queue(queueConfig.name, {
      connection: redis,
      defaultJobOptions: {
        attempts: queueConfig.maxRetries,
        backoff: queueConfig.backoff,
        timeout: queueConfig.timeout,
        removeOnComplete: {
          age: 86400, // 24 hours
          count: 1000
        },
        removeOnFail: {
          age: 604800 // 7 days
        }
      }
    });

    this.queues.set(queueConfig.name, queue);
    
    // Create scheduler for delayed jobs
    const scheduler = new QueueScheduler(queueConfig.name, {
      connection: redis
    });
    this.schedulers.set(queueConfig.name, scheduler);

    logger.info(`Queue created: ${queueConfig.name}`);

    return queue;
  }

  /**
   * Create worker for queue
   */
  createWorker<T = any>(
    queueName: string,
    processor: (job: Job<T>) => Promise<any>,
    options?: Partial<WorkerOptions>
  ): Worker {
    if (this.workers.has(queueName)) {
      return this.workers.get(queueName)!;
    }

    const worker = new Worker(
      queueName,
      async (job) => {
        const startTime = Date.now();
        
        try {
          logger.debug(`Processing job ${job.id} in queue ${queueName}`, {
            jobId: job.id,
            queueName,
            attempts: job.attemptsMade
          });

          const result = await processor(job);

          const duration = Date.now() - startTime;
          
          this.emit('job:completed', {
            jobId: job.id,
            queueName,
            duration,
            result
          });

          logger.info(`Job ${job.id} completed in ${duration}ms`, {
            jobId: job.id,
            queueName
          });

          return result;
        } catch (error) {
          const duration = Date.now() - startTime;
          
          this.emit('job:failed', {
            jobId: job.id,
            queueName,
            duration,
            error: error.message
          });

          logger.error(`Job ${job.id} failed after ${duration}ms`, {
            jobId: job.id,
            queueName,
            error: error.message
          });

          throw error;
        }
      },
      {
        connection: redis,
        concurrency: options?.concurrency || 5,
        ...options
      }
    );

    worker.on('completed', (job) => {
      this.emit('job:completed', {
        jobId: job.id,
        queueName,
        timestamp: new Date()
      });
    });

    worker.on('failed', (job, error) => {
      this.emit('job:failed', {
        jobId: job?.id,
        queueName,
        error: error.message,
        timestamp: new Date()
      });
    });

    worker.on('error', (error) => {
      logger.error(`Worker error in queue ${queueName}:`, error);
      this.emit('worker:error', { queueName, error: error.message });
    });

    this.workers.set(queueName, worker);

    logger.info(`Worker created for queue: ${queueName}`, {
      concurrency: options?.concurrency || 5
    });

    return worker;
  }

  /**
   * Add job to queue
   */
  async addJob<T = any>(
    queueName: string,
    jobName: string,
    data: T,
    options?: {
      delay?: number;
      priority?: number;
      jobId?: string;
      attempts?: number;
    }
  ): Promise<Job<T>> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const job = await queue.add(jobName, data, {
      delay: options?.delay,
      priority: options?.priority,
      jobId: options?.jobId,
      attempts: options?.attempts
    });

    logger.info(`Job added to queue ${queueName}`, {
      jobId: job.id,
      jobName,
      queueName
    });

    return job as Job<T>;
  }

  /**
   * Add bulk jobs
   */
  async addBulk(
    queueName: string,
    jobs: Array<{
      name: string;
      data: any;
      options?: any;
    }>
  ): Promise<Job[]> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const added = await queue.addBulk(
      jobs.map(job => ({
        name: job.name,
        data: job.data,
        opts: job.options
      }))
    );

    logger.info(`Bulk jobs added to queue ${queueName}`, {
      count: jobs.length,
      queueName
    });

    return added;
  }

  /**
   * Get job by ID
   */
  async getJob(queueName: string, jobId: string): Promise<Job | null> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    return queue.getJob(jobId);
  }

  /**
   * Get jobs by status
   */
  async getJobs(
    queueName: string,
    statuses: ('waiting' | 'active' | 'completed' | 'failed' | 'delayed')[]
  ): Promise<Job[]> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const jobs = await queue.getJobs(statuses);
    return jobs;
  }

  /**
   * Get queue metrics
   */
  async getMetrics(queueName: string): Promise<QueueMetrics> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const [
      waiting,
      active,
      completed,
      failed,
      delayed,
      isPaused
    ] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
      queue.isPaused()
    ]);

    // Get recent jobs for average processing time
    const recentJobs = await queue.getJobs(['completed'], 0, 100);
    const processingTimes = recentJobs
      .map(job => {
        const processedAt = job.processedOn;
        const finishedAt = job.finishedOn;
        if (processedAt && finishedAt) {
          return finishedAt - processedAt;
        }
        return 0;
      })
      .filter(time => time > 0);

    const averageProcessingTime = processingTimes.length > 0
      ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
      : 0;

    // Calculate throughput (jobs per minute in last hour)
    const oneHourAgo = Date.now() - 3600000;
    const recentCompleted = recentJobs.filter(job => 
      job.finishedOn && job.finishedOn > oneHourAgo
    ).length;
    const throughput = recentCompleted / 60; // per minute

    return {
      name: queueName,
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused: isPaused,
      averageProcessingTime,
      throughput
    };
  }

  /**
   * Get all queue metrics
   */
  async getAllMetrics(): Promise<QueueMetrics[]> {
    const metrics = await Promise.all(
      Array.from(this.queues.keys()).map(name => this.getMetrics(name))
    );
    return metrics;
  }

  /**
   * Pause queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    await queue.pause();
    logger.info(`Queue paused: ${queueName}`);
  }

  /**
   * Resume queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    await queue.resume();
    logger.info(`Queue resumed: ${queueName}`);
  }

  /**
   * Remove job
   */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const job = await queue.getJob(jobId);
    if (job) {
      await job.remove();
      logger.info(`Job removed: ${jobId} from queue ${queueName}`);
    }
  }

  /**
   * Clean queue
   */
  async cleanQueue(
    queueName: string,
    grace: number = 86400, // 24 hours
    limit: number = 100
  ): Promise<void> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    await queue.clean(grace, limit, 'completed');
    await queue.clean(grace, limit, 'failed');
    
    logger.info(`Queue cleaned: ${queueName}`, { grace, limit });
  }

  /**
   * Retry failed jobs
   */
  async retryFailed(queueName: string, limit: number = 100): Promise<number> {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const failed = await queue.getJobs(['failed'], 0, limit);
    let retried = 0;

    for (const job of failed) {
      try {
        await job.retry();
        retried++;
      } catch (error) {
        logger.error(`Failed to retry job ${job.id}:`, error);
      }
    }

    logger.info(`Retried ${retried} failed jobs in queue ${queueName}`);
    return retried;
  }

  /**
   * Close queue
   */
  async closeQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    const worker = this.workers.get(queueName);
    const scheduler = this.schedulers.get(queueName);

    if (worker) {
      await worker.close();
      this.workers.delete(queueName);
    }

    if (scheduler) {
      await scheduler.close();
      this.schedulers.delete(queueName);
    }

    if (queue) {
      await queue.close();
      this.queues.delete(queueName);
    }

    logger.info(`Queue closed: ${queueName}`);
  }

  /**
   * Close all queues
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.queues.keys()).map(name => 
      this.closeQueue(name)
    );

    await Promise.all(closePromises);
    logger.info('All queues closed');
  }

  /**
   * Get queue status
   */
  async getQueueStatus(queueName: string): Promise<any> {
    const metrics = await this.getMetrics(queueName);
    
    // Get worker status
    const worker = this.workers.get(queueName);
    const workerStatus = worker ? 'active' : 'inactive';

    // Get recent errors
    const failedJobs = await this.getJobs(queueName, ['failed']);
    const recentErrors = failedJobs.slice(0, 10).map(job => ({
      jobId: job.id,
      name: job.name,
      failedAt: job.failedReason,
      error: job.failedReason
    }));

    return {
      ...metrics,
      worker: workerStatus,
      recentErrors,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Create default queues
   */
  async createDefaultQueues(): Promise<void> {
    const queues = [
      { name: 'email', concurrency: 5 },
      { name: 'sms', concurrency: 3 },
      { name: 'push', concurrency: 10 },
      { name: 'webhook', concurrency: 20 },
      { name: 'invoice-processing', concurrency: 5 },
      { name: 'firs-submission', concurrency: 2 },
      { name: 'integration-sync', concurrency: 3 },
      { name: 'report-generation', concurrency: 2 },
      { name: 'notification-digest', concurrency: 1 },
      { name: 'audit-log', concurrency: 5 }
    ];

    for (const config of queues) {
      this.createQueue(config);
    }

    logger.info('Default queues created', { count: queues.length });
  }
}

export const queueService = new QueueService();
