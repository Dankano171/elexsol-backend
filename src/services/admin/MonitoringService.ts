import { businessRepository } from '../../repositories/BusinessRepository';
import { userRepository } from '../../repositories/UserRepository';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { subHours, subDays, format } from 'date-fns';
import os from 'os';

export interface SystemMetrics {
  timestamp: Date;
  cpu: {
    usage: number;
    loadAvg: number[];
    cores: number;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usagePercentage: number;
  };
  disk: {
    total: number;
    free: number;
    used: number;
    usagePercentage: number;
  };
  network: {
    connections: number;
    requestsPerSecond: number;
    bytesIn: number;
    bytesOut: number;
  };
  database: {
    connections: number;
    queryTime: number;
    slowQueries: number;
  };
  redis: {
    connections: number;
    memory: number;
    hitRate: number;
  };
  queues: {
    [key: string]: {
      waiting: number;
      active: number;
      failed: number;
      latency: number;
    };
  };
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: '>' | '<' | '==' | '>=' | '<=';
  threshold: number;
  severity: 'info' | 'warning' | 'critical';
  duration: number; // seconds
  enabled: boolean;
  notificationChannels: ('email' | 'sms' | 'slack')[];
}

export interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  metric: string;
  value: number;
  threshold: number;
  severity: string;
  timestamp: Date;
  acknowledged: boolean;
  resolved: boolean;
  resolvedAt?: Date;
}

export class MonitoringService {
  private alertRules: Map<string, AlertRule> = new Map();
  private alerts: Map<string, Alert> = new Map();
  private readonly metricsHistoryKey = 'monitoring:metrics';

  /**
   * Initialize monitoring
   */
  async initialize(): Promise<void> {
    // Load alert rules from config
    await this.loadAlertRules();

    // Start metric collection
    setInterval(() => this.collectMetrics(), 60000); // Every minute

    // Start alert evaluation
    setInterval(() => this.evaluateAlerts(), 30000); // Every 30 seconds

    logger.info('Monitoring service initialized');
  }

  /**
   * Collect system metrics
   */
  async collectMetrics(): Promise<SystemMetrics> {
    try {
      const metrics = await this.gatherMetrics();

      // Store in Redis time series
      await this.storeMetrics(metrics);

      return metrics;
    } catch (error) {
      logger.error('Error collecting metrics:', error);
      throw error;
    }
  }

  /**
   * Gather all metrics
   */
  private async gatherMetrics(): Promise<SystemMetrics> {
    const [
      cpuMetrics,
      memoryMetrics,
      diskMetrics,
      networkMetrics,
      dbMetrics,
      redisMetrics,
      queueMetrics
    ] = await Promise.all([
      this.getCPUMetrics(),
      this.getMemoryMetrics(),
      this.getDiskMetrics(),
      this.getNetworkMetrics(),
      this.getDatabaseMetrics(),
      this.getRedisMetrics(),
      this.getQueueMetrics()
    ]);

    return {
      timestamp: new Date(),
      cpu: cpuMetrics,
      memory: memoryMetrics,
      disk: diskMetrics,
      network: networkMetrics,
      database: dbMetrics,
      redis: redisMetrics,
      queues: queueMetrics
    };
  }

  /**
   * Get CPU metrics
   */
  private async getCPUMetrics(): Promise<SystemMetrics['cpu']> {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    // Calculate CPU usage
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = ((total - idle) / total) * 100;

    return {
      usage: Math.round(usage * 100) / 100,
      loadAvg,
      cores: cpus.length
    };
  }

  /**
   * Get memory metrics
   */
  private async getMemoryMetrics(): Promise<SystemMetrics['memory']> {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const usagePercentage = (used / total) * 100;

    return {
      total,
      free,
      used,
      usagePercentage: Math.round(usagePercentage * 100) / 100
    };
  }

  /**
   * Get disk metrics
   */
  private async getDiskMetrics(): Promise<SystemMetrics['disk']> {
    // In production, use 'diskusage' or similar
    // Placeholder implementation
    return {
      total: 100 * 1024 * 1024 * 1024, // 100GB
      free: 50 * 1024 * 1024 * 1024,    // 50GB
      used: 50 * 1024 * 1024 * 1024,    // 50GB
      usagePercentage: 50
    };
  }

  /**
   * Get network metrics
   */
  private async getNetworkMetrics(): Promise<SystemMetrics['network']> {
    // In production, track actual network stats
    // Placeholder implementation
    return {
      connections: await this.getActiveConnections(),
      requestsPerSecond: await this.getRequestsPerSecond(),
      bytesIn: 0,
      bytesOut: 0
    };
  }

  /**
   * Get database metrics
   */
  private async getDatabaseMetrics(): Promise<SystemMetrics['database']> {
    // In production, query database stats
    // Placeholder implementation
    return {
      connections: 10,
      queryTime: 50,
      slowQueries: 0
    };
  }

  /**
   * Get Redis metrics
   */
  private async getRedisMetrics(): Promise<SystemMetrics['redis']> {
    const info = await redis.info();
    
    // Parse Redis INFO command output
    const connections = parseInt(info.match(/connected_clients:(\d+)/)?.[1] || '0');
    const memory = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0');
    const hits = parseInt(info.match(/keyspace_hits:(\d+)/)?.[1] || '0');
    const misses = parseInt(info.match(/keyspace_misses:(\d+)/)?.[1] || '0');
    
    const hitRate = hits + misses > 0 ? (hits / (hits + misses)) * 100 : 0;

    return {
      connections,
      memory,
      hitRate: Math.round(hitRate * 100) / 100
    };
  }

  /**
   * Get queue metrics
   */
  private async getQueueMetrics(): Promise<SystemMetrics['queues']> {
    const queueMetrics = await queueService.getAllMetrics();
    
    return queueMetrics.reduce((acc, metric) => {
      acc[metric.name] = {
        waiting: metric.waiting,
        active: metric.active,
        failed: metric.failed,
        latency: metric.averageProcessingTime
      };
      return acc;
    }, {} as SystemMetrics['queues']);
  }

  /**
   * Store metrics in Redis
   */
  private async storeMetrics(metrics: SystemMetrics): Promise<void> {
    const timestamp = metrics.timestamp.getTime();
    const key = `${this.metricsHistoryKey}:${format(metrics.timestamp, 'yyyy-MM-dd')}`;

    await redis.zadd(key, timestamp, JSON.stringify(metrics));
    await redis.expire(key, 86400 * 7); // Keep for 7 days
  }

  /**
   * Get metrics history
   */
  async getMetricsHistory(
    from: Date,
    to: Date,
    interval: 'minute' | 'hour' | 'day' = 'hour'
  ): Promise<SystemMetrics[]> {
    const keys = [];
    let current = from;

    while (current <= to) {
      keys.push(`${this.metricsHistoryKey}:${format(current, 'yyyy-MM-dd')}`);
      current.setDate(current.getDate() + 1);
    }

    const metrics: SystemMetrics[] = [];
    
    for (const key of keys) {
      const fromTime = from.getTime();
      const toTime = to.getTime();
      
      const results = await redis.zrangebyscore(key, fromTime, toTime);
      
      for (const result of results) {
        metrics.push(JSON.parse(result));
      }
    }

    // Aggregate based on interval
    return this.aggregateMetrics(metrics, interval);
  }

  /**
   * Aggregate metrics by interval
   */
  private aggregateMetrics(
    metrics: SystemMetrics[],
    interval: 'minute' | 'hour' | 'day'
  ): SystemMetrics[] {
    // Simplified aggregation - would need proper implementation
    return metrics;
  }

  /**
   * Load alert rules
   */
  private async loadAlertRules(): Promise<void> {
    // In production, load from database
    const rules: AlertRule[] = [
      {
        id: 'cpu-high',
        name: 'High CPU Usage',
        metric: 'cpu.usage',
        condition: '>',
        threshold: 80,
        severity: 'warning',
        duration: 300,
        enabled: true,
        notificationChannels: ['email', 'slack']
      },
      {
        id: 'memory-high',
        name: 'High Memory Usage',
        metric: 'memory.usagePercentage',
        condition: '>',
        threshold: 90,
        severity: 'critical',
        duration: 300,
        enabled: true,
        notificationChannels: ['email', 'sms']
      },
      {
        id: 'queue-size',
        name: 'Large Queue Size',
        metric: 'queues.*.waiting',
        condition: '>',
        threshold: 1000,
        severity: 'warning',
        duration: 600,
        enabled: true,
        notificationChannels: ['email']
      }
    ];

    rules.forEach(rule => this.alertRules.set(rule.id, rule));
  }

  /**
   * Evaluate alerts
   */
  private async evaluateAlerts(): Promise<void> {
    const metrics = await this.collectMetrics();

    for (const rule of this.alertRules.values()) {
      if (!rule.enabled) continue;

      const value = this.getMetricValue(metrics, rule.metric);
      if (value === null) continue;

      const triggered = this.evaluateCondition(value, rule.condition, rule.threshold);

      if (triggered) {
        await this.triggerAlert(rule, value);
      } else {
        await this.resolveAlert(rule.id);
      }
    }
  }

  /**
   * Get metric value by path
   */
  private getMetricValue(metrics: SystemMetrics, path: string): number | null {
    const parts = path.split('.');
    let current: any = metrics;

    for (const part of parts) {
      if (part === '*') {
        // Handle wildcards
        if (typeof current === 'object') {
          const values = Object.values(current);
          return values.length > 0 ? Math.max(...values.map(v => this.getMetricValue({ value: v }, 'value') || 0)) : null;
        }
        return null;
      }

      if (!current || !(part in current)) {
        return null;
      }

      current = current[part];
    }

    return typeof current === 'number' ? current : null;
  }

  /**
   * Evaluate condition
   */
  private evaluateCondition(value: number, condition: string, threshold: number): boolean {
    switch (condition) {
      case '>':
        return value > threshold;
      case '>=':
        return value >= threshold;
      case '<':
        return value < threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      default:
        return false;
    }
  }

  /**
   * Trigger alert
   */
  private async triggerAlert(rule: AlertRule, value: number): Promise<void> {
    const existing = this.alerts.get(rule.id);

    if (existing && !existing.resolved) {
      // Alert already active
      return;
    }

    const alert: Alert = {
      id: `${rule.id}-${Date.now()}`,
      ruleId: rule.id,
      ruleName: rule.name,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      severity: rule.severity,
      timestamp: new Date(),
      acknowledged: false,
      resolved: false
    };

    this.alerts.set(rule.id, alert);

    // Send notifications
    await this.sendAlertNotifications(alert, rule.notificationChannels);

    logger.warn('Alert triggered', { alert });
  }

  /**
   * Resolve alert
   */
  private async resolveAlert(ruleId: string): Promise<void> {
    const alert = this.alerts.get(ruleId);

    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date();

      logger.info('Alert resolved', { ruleId });
    }
  }

  /**
   * Send alert notifications
   */
  private async sendAlertNotifications(
    alert: Alert,
    channels: string[]
  ): Promise<void> {
    for (const channel of channels) {
      try {
        switch (channel) {
          case 'email':
            await this.sendAlertEmail(alert);
            break;
          case 'sms':
            await this.sendAlertSMS(alert);
            break;
          case 'slack':
            await this.sendAlertSlack(alert);
            break;
        }
      } catch (error) {
        logger.error(`Error sending alert via ${channel}:`, error);
      }
    }
  }

  /**
   * Send alert email
   */
  private async sendAlertEmail(alert: Alert): Promise<void> {
    // Implementation would use email service
  }

  /**
   * Send alert SMS
   */
  private async sendAlertSMS(alert: Alert): Promise<void> {
    // Implementation would use SMS service
  }

  /**
   * Send alert to Slack
   */
  private async sendAlertSlack(alert: Alert): Promise<void> {
    // Implementation would use Slack webhook
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): Alert[] {
    return Array.from(this.alerts.values())
      .filter(a => !a.resolved)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Acknowledge alert
   */
  acknowledgeAlert(alertId: string): void {
    const alert = this.alerts.get(alertId);
    if (alert) {
      alert.acknowledged = true;
    }
  }

  // Placeholder implementations
  private async getActiveConnections(): Promise<number> {
    return 100;
  }

  private async getRequestsPerSecond(): Promise<number> {
    return 50;
  }
}

export const monitoringService = new MonitoringService();
