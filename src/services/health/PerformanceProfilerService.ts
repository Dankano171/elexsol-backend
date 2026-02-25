import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';

export interface ProfileData {
  name: string;
  duration: number;
  memory: number;
  cpu?: number;
  timestamp: Date;
  tags: Record<string, string>;
  metadata?: Record<string, any>;
}

export interface ProfileSummary {
  name: string;
  count: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  p95Duration: number;
  p99Duration: number;
  averageMemory: number;
  totalMemory: number;
  lastExecuted: Date;
  executionsPerMinute: number;
}

export interface PerformanceAlert {
  id: string;
  profileName: string;
  threshold: number;
  actual: number;
  timestamp: Date;
  severity: 'warning' | 'critical';
  metadata?: Record<string, any>;
}

export class PerformanceProfilerService extends EventEmitter {
  private readonly profilePrefix = 'profile:';
  private readonly summaryPrefix = 'profile:summary:';
  private readonly alertPrefix = 'profile:alert:';
  private readonly retentionDays = 7;
  private readonly alertThresholds = new Map<string, { warning: number; critical: number }>();

  /**
   * Start profiling a function
   */
  async profile<T>(
    name: string,
    fn: () => Promise<T>,
    tags: Record<string, string> = {}
  ): Promise<T> {
    const startTime = performance.now();
    const startMemory = process.memoryUsage().heapUsed;

    try {
      const result = await fn();
      
      const duration = performance.now() - startTime;
      const memory = process.memoryUsage().heapUsed - startMemory;

      await this.recordProfile({
        name,
        duration,
        memory,
        timestamp: new Date(),
        tags,
        metadata: { success: true }
      });

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      const memory = process.memoryUsage().heapUsed - startMemory;

      await this.recordProfile({
        name,
        duration,
        memory,
        timestamp: new Date(),
        tags,
        metadata: { success: false, error: error.message }
      });

      throw error;
    }
  }

  /**
   * Record profile data
   */
  private async recordProfile(data: ProfileData): Promise<void> {
    const date = data.timestamp.toISOString().split('T')[0];
    const key = `${this.profilePrefix}${data.name}:${date}`;

    // Store profile data
    await redis.zadd(
      key,
      data.timestamp.getTime(),
      JSON.stringify(data)
    );
    await redis.expire(key, this.retentionDays * 86400);

    // Update summary
    await this.updateSummary(data);

    // Check thresholds
    await this.checkThresholds(data);

    // Emit event
    this.emit('profile', data);
  }

  /**
   * Update profile summary
   */
  private async updateSummary(data: ProfileData): Promise<void> {
    const key = `${this.summaryPrefix}${data.name}`;
    const summary = await this.getSummary(data.name);

    const newSummary: ProfileSummary = {
      name: data.name,
      count: (summary?.count || 0) + 1,
      averageDuration: summary 
        ? (summary.averageDuration * summary.count + data.duration) / (summary.count + 1)
        : data.duration,
      minDuration: summary ? Math.min(summary.minDuration, data.duration) : data.duration,
      maxDuration: summary ? Math.max(summary.maxDuration, data.duration) : data.duration,
      p95Duration: 0, // Calculated separately
      p99Duration: 0, // Calculated separately
      averageMemory: summary
        ? (summary.averageMemory * summary.count + data.memory) / (summary.count + 1)
        : data.memory,
      totalMemory: (summary?.totalMemory || 0) + data.memory,
      lastExecuted: data.timestamp,
      executionsPerMinute: 0 // Calculated separately
    };

    await redis.setex(key, this.retentionDays * 86400, JSON.stringify(newSummary));
  }

  /**
   * Get profile summary
   */
  async getSummary(name: string): Promise<ProfileSummary | null> {
    const key = `${this.summaryPrefix}${name}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Get all profile summaries
   */
  async getAllSummaries(): Promise<ProfileSummary[]> {
    const pattern = `${this.summaryPrefix}*`;
    const keys = await redis.keys(pattern);
    const summaries: ProfileSummary[] = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        summaries.push(JSON.parse(data));
      }
    }

    // Calculate percentiles for each summary
    for (const summary of summaries) {
      await this.calculatePercentiles(summary);
    }

    return summaries.sort((a, b) => b.count - a.count);
  }

  /**
   * Calculate percentiles for a profile
   */
  private async calculatePercentiles(summary: ProfileSummary): Promise<void> {
    const date = new Date().toISOString().split('T')[0];
    const key = `${this.profilePrefix}${summary.name}:${date}`;
    
    const profiles = await redis.zrange(key, 0, -1);
    const durations = profiles
      .map(p => JSON.parse(p).duration)
      .sort((a, b) => a - b);

    if (durations.length > 0) {
      const p95Index = Math.floor(durations.length * 0.95);
      const p99Index = Math.floor(durations.length * 0.99);
      
      summary.p95Duration = durations[p95Index];
      summary.p99Duration = durations[p99Index];
    }

    // Calculate executions per minute
    const oneHourAgo = Date.now() - 3600000;
    const recentProfiles = await redis.zrangebyscore(key, oneHourAgo, '+inf');
    summary.executionsPerMinute = Math.round(recentProfiles.length / 60);
  }

  /**
   * Get profile history
   */
  async getHistory(
    name: string,
    from: Date,
    to: Date,
    limit: number = 1000
  ): Promise<ProfileData[]> {
    const fromDate = from.toISOString().split('T')[0];
    const toDate = to.toISOString().split('T')[0];
    
    const profiles: ProfileData[] = [];
    
    // Iterate through days
    let current = new Date(from);
    while (current <= to) {
      const date = current.toISOString().split('T')[0];
      const key = `${this.profilePrefix}${name}:${date}`;
      
      const fromTime = Math.max(from.getTime(), current.setHours(0, 0, 0, 0));
      const toTime = Math.min(to.getTime(), current.setHours(23, 59, 59, 999));
      
      const dayProfiles = await redis.zrangebyscore(key, fromTime, toTime);
      
      for (const profile of dayProfiles) {
        profiles.push(JSON.parse(profile));
      }
      
      current.setDate(current.getDate() + 1);
    }

    return profiles
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Set alert thresholds
   */
  setThreshold(
    profileName: string,
    thresholds: { warning: number; critical: number }
  ): void {
    this.alertThresholds.set(profileName, thresholds);
    logger.info(`Alert thresholds set for ${profileName}`, thresholds);
  }

  /**
   * Check thresholds for profile
   */
  private async checkThresholds(data: ProfileData): Promise<void> {
    const thresholds = this.alertThresholds.get(data.name);
    if (!thresholds) return;

    if (data.duration > thresholds.critical) {
      await this.createAlert({
        profileName: data.name,
        threshold: thresholds.critical,
        actual: data.duration,
        severity: 'critical',
        metadata: data
      });
    } else if (data.duration > thresholds.warning) {
      await this.createAlert({
        profileName: data.name,
        threshold: thresholds.warning,
        actual: data.duration,
        severity: 'warning',
        metadata: data
      });
    }
  }

  /**
   * Create performance alert
   */
  private async createAlert(alert: Omit<PerformanceAlert, 'id' | 'timestamp'>): Promise<void> {
    const fullAlert: PerformanceAlert = {
      id: `${alert.profileName}-${Date.now()}`,
      ...alert,
      timestamp: new Date()
    };

    const key = `${this.alertPrefix}${fullAlert.id}`;
    await redis.setex(key, 86400, JSON.stringify(fullAlert));

    this.emit('alert', fullAlert);
    logger.warn('Performance alert triggered', fullAlert);
  }

  /**
   * Get active alerts
   */
  async getActiveAlerts(severity?: 'warning' | 'critical'): Promise<PerformanceAlert[]> {
    const pattern = `${this.alertPrefix}*`;
    const keys = await redis.keys(pattern);
    const alerts: PerformanceAlert[] = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const alert = JSON.parse(data);
        if (!severity || alert.severity === severity) {
          alerts.push(alert);
        }
      }
    }

    return alerts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Clear old profiles
   */
  async cleanup(): Promise<number> {
    const pattern = `${this.profilePrefix}*`;
    const keys = await redis.keys(pattern);
    let deleted = 0;

    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl < 0) {
        await redis.del(key);
        deleted++;
      }
    }

    logger.info(`Cleaned up ${deleted} old profiles`);
    return deleted;
  }

  /**
   * Generate performance report
   */
  async generateReport(): Promise<any> {
    const summaries = await this.getAllSummaries();
    const alerts = await this.getActiveAlerts();

    // Find slowest profiles
    const slowest = [...summaries]
      .sort((a, b) => b.p95Duration - a.p95Duration)
      .slice(0, 5);

    // Find most executed
    const mostExecuted = [...summaries]
      .sort((a, b) => b.executionsPerMinute - a.executionsPerMinute)
      .slice(0, 5);

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalProfiles: summaries.length,
        totalExecutions: summaries.reduce((sum, s) => sum + s.count, 0),
        activeAlerts: alerts.length
      },
      slowest,
      mostExecuted,
      alerts: alerts.slice(0, 10)
    };
  }
}

export const performanceProfiler = new PerformanceProfilerService();
