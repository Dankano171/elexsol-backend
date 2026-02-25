import { db } from '../../config/database';
import { redis } from '../../config/redis';
import { queueService } from '../queue/QueueService';
import { businessRepository } from '../../repositories/BusinessRepository';
import { userRepository } from '../../repositories/UserRepository';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { logger } from '../../config/logger';
import os from 'os';
import { performanceProfiler } from './PerformanceProfilerService';

export interface DiagnosticReport {
  id: string;
  timestamp: Date;
  summary: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    issues: number;
    warnings: number;
    duration: number;
  };
  system: SystemDiagnostic;
  database: DatabaseDiagnostic;
  redis: RedisDiagnostic;
  queues: QueueDiagnostic[];
  integrations: IntegrationDiagnostic[];
  performance: PerformanceDiagnostic;
  recommendations: DiagnosticRecommendation[];
}

export interface SystemDiagnostic {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  memory: {
    total: number;
    free: number;
    used: number;
    usage: number;
  };
  loadAvg: number[];
  uptime: number;
  nodeVersion: string;
  processId: number;
}

export interface DatabaseDiagnostic {
  connected: boolean;
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  waitingClients: number;
  queryPerformance: {
    avgQueryTime: number;
    slowQueries: number;
    deadlocks: number;
  };
  tables: Array<{
    name: string;
    rowCount: number;
    size: string;
    indexes: number;
  }>;
}

export interface RedisDiagnostic {
  connected: boolean;
  memory: {
    used: number;
    peak: number;
    fragmentation: number;
  };
  stats: {
    hits: number;
    misses: number;
    hitRate: number;
    keys: number;
    expiredKeys: number;
    evictedKeys: number;
  };
  slowLog: Array<{
    id: number;
    duration: number;
    command: string;
    timestamp: Date;
  }>;
}

export interface QueueDiagnostic {
  name: string;
  size: number;
  active: number;
  failed: number;
  delayed: number;
  stalled: number;
  oldestJob?: Date;
  newestJob?: Date;
  errorRate: number;
}

export interface IntegrationDiagnostic {
  name: string;
  connected: boolean;
  latency: number;
  errorCount: number;
  lastCheck: Date;
  message?: string;
}

export interface PerformanceDiagnostic {
  requestRate: number;
  errorRate: number;
  averageResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  slowEndpoints: Array<{
    path: string;
    method: string;
    count: number;
    avgTime: number;
  }>;
}

export interface DiagnosticRecommendation {
  severity: 'high' | 'medium' | 'low';
  category: string;
  message: string;
  impact: string;
  action: string;
  automation?: string;
}

export class DiagnosticService {
  /**
   * Run full diagnostic
   */
  async runDiagnostic(deep: boolean = false): Promise<DiagnosticReport> {
    const startTime = Date.now();
    const reportId = `diag-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      const [
        system,
        database,
        redis,
        queues,
        integrations,
        performance
      ] = await Promise.all([
        this.diagnoseSystem(),
        this.diagnoseDatabase(deep),
        this.diagnoseRedis(deep),
        this.diagnoseQueues(),
        this.diagnoseIntegrations(),
        this.diagnosePerformance()
      ]);

      const issues = this.countIssues(database, redis, queues, integrations);
      const warnings = this.countWarnings(database, redis, queues, integrations);
      
      const status = issues > 0 ? 'unhealthy' : warnings > 0 ? 'degraded' : 'healthy';

      const recommendations = await this.generateRecommendations(
        system,
        database,
        redis,
        queues,
        integrations,
        performance
      );

      const duration = Date.now() - startTime;

      const report: DiagnosticReport = {
        id: reportId,
        timestamp: new Date(),
        summary: {
          status,
          issues,
          warnings,
          duration
        },
        system,
        database,
        redis,
        queues,
        integrations,
        performance,
        recommendations
      };

      // Store report
      await this.storeReport(report);

      return report;
    } catch (error) {
      logger.error('Diagnostic failed:', error);
      throw error;
    }
  }

  /**
   * Diagnose system
   */
  private async diagnoseSystem(): Promise<SystemDiagnostic> {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: {
        total: totalMemory,
        free: freeMemory,
        used: usedMemory,
        usage: (usedMemory / totalMemory) * 100
      },
      loadAvg: os.loadavg(),
      uptime: os.uptime(),
      nodeVersion: process.version,
      processId: process.pid
    };
  }

  /**
   * Diagnose database
   */
  private async diagnoseDatabase(deep: boolean): Promise<DatabaseDiagnostic> {
    try {
      // Basic connection test
      const connected = await this.testDatabaseConnection();

      if (!connected) {
        return {
          connected: false,
          poolSize: 0,
          activeConnections: 0,
          idleConnections: 0,
          waitingClients: 0,
          queryPerformance: {
            avgQueryTime: 0,
            slowQueries: 0,
            deadlocks: 0
          },
          tables: []
        };
      }

      // Get pool stats
      const poolStats = await this.getDatabasePoolStats();

      // Get table stats (if deep)
      const tables = deep ? await this.getDatabaseTableStats() : [];

      // Get query performance
      const queryPerf = await this.getQueryPerformance();

      return {
        connected: true,
        ...poolStats,
        queryPerformance: queryPerf,
        tables
      };
    } catch (error) {
      logger.error('Database diagnostic failed:', error);
      return {
        connected: false,
        poolSize: 0,
        activeConnections: 0,
        idleConnections: 0,
        waitingClients: 0,
        queryPerformance: {
          avgQueryTime: 0,
          slowQueries: 0,
          deadlocks: 0
        },
        tables: []
      };
    }
  }

  /**
   * Diagnose Redis
   */
  private async diagnoseRedis(deep: boolean): Promise<RedisDiagnostic> {
    try {
      const connected = await this.testRedisConnection();

      if (!connected) {
        return {
          connected: false,
          memory: { used: 0, peak: 0, fragmentation: 0 },
          stats: { hits: 0, misses: 0, hitRate: 0, keys: 0, expiredKeys: 0, evictedKeys: 0 },
          slowLog: []
        };
      }

      const info = await redis.info();
      const stats = this.parseRedisInfo(info);

      // Get slow log (if deep)
      const slowLog = deep ? await this.getRedisSlowLog() : [];

      return {
        connected: true,
        memory: {
          used: stats.used_memory || 0,
          peak: stats.used_memory_peak || 0,
          fragmentation: stats.mem_fragmentation_ratio || 0
        },
        stats: {
          hits: stats.keyspace_hits || 0,
          misses: stats.keyspace_misses || 0,
          hitRate: stats.keyspace_hits + stats.keyspace_misses > 0
            ? (stats.keyspace_hits / (stats.keyspace_hits + stats.keyspace_misses)) * 100
            : 0,
          keys: stats.total_keys || 0,
          expiredKeys: stats.expired_keys || 0,
          evictedKeys: stats.evicted_keys || 0
        },
        slowLog
      };
    } catch (error) {
      logger.error('Redis diagnostic failed:', error);
      return {
        connected: false,
        memory: { used: 0, peak: 0, fragmentation: 0 },
        stats: { hits: 0, misses: 0, hitRate: 0, keys: 0, expiredKeys: 0, evictedKeys: 0 },
        slowLog: []
      };
    }
  }

  /**
   * Diagnose queues
   */
  private async diagnoseQueues(): Promise<QueueDiagnostic[]> {
    try {
      const metrics = await queueService.getAllMetrics();
      
      return metrics.map(m => ({
        name: m.name,
        size: m.waiting + m.active,
        active: m.active,
        failed: m.failed,
        delayed: m.delayed,
        stalled: 0, // Would need additional monitoring
        errorRate: m.failed > 0 ? (m.failed / (m.completed + m.failed)) * 100 : 0
      }));
    } catch (error) {
      logger.error('Queue diagnostic failed:', error);
      return [];
    }
  }

  /**
   * Diagnose integrations
   */
  private async diagnoseIntegrations(): Promise<IntegrationDiagnostic[]> {
    const integrations = [
      { name: 'FIRS API', url: process.env.FIRS_API_URL },
      { name: 'Payment Gateway', url: process.env.PAYMENT_API_URL },
      { name: 'Email Service', url: process.env.EMAIL_API_URL },
      { name: 'SMS Service', url: process.env.SMS_API_URL },
      { name: 'Storage Service', url: process.env.STORAGE_API_URL }
    ];

    const results = await Promise.all(
      integrations.map(async integration => {
        if (!integration.url) {
          return {
            name: integration.name,
            connected: false,
            latency: 0,
            errorCount: 0,
            lastCheck: new Date(),
            message: 'Not configured'
          };
        }

        return this.checkIntegration(integration.name, integration.url);
      })
    );

    return results;
  }

  /**
   * Check individual integration
   */
  private async checkIntegration(name: string, url: string): Promise<IntegrationDiagnostic> {
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        timeout: 5000
      });

      const latency = Date.now() - start;

      return {
        name,
        connected: response.ok,
        latency,
        errorCount: 0,
        lastCheck: new Date(),
        message: response.ok ? 'Healthy' : `HTTP ${response.status}`
      };
    } catch (error) {
      return {
        name,
        connected: false,
        latency: Date.now() - start,
        errorCount: 1,
        lastCheck: new Date(),
        message: error.message
      };
    }
  }

  /**
   * Diagnose performance
   */
  private async diagnosePerformance(): Promise<PerformanceDiagnostic> {
    // Get performance profiles
    const profiles = await performanceProfiler.getAllSummaries();

    // Calculate aggregates
    const totalRequests = profiles.reduce((sum, p) => sum + p.count, 0);
    const totalErrors = 0; // Would need error tracking

    // Find slow endpoints
    const slowEndpoints = profiles
      .map(p => ({
        path: p.name,
        method: 'GET', // Would need actual method
        count: p.count,
        avgTime: p.averageDuration
      }))
      .filter(p => p.avgTime > 1000) // > 1 second
      .sort((a, b) => b.avgTime - a.avgTime)
      .slice(0, 10);

    return {
      requestRate: totalRequests / 60, // per minute
      errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
      averageResponseTime: profiles.reduce((sum, p) => sum + p.averageDuration, 0) / profiles.length,
      p95ResponseTime: Math.max(...profiles.map(p => p.p95Duration)),
      p99ResponseTime: Math.max(...profiles.map(p => p.p99Duration)),
      slowEndpoints
    };
  }

  /**
   * Generate recommendations
   */
  private async generateRecommendations(
    system: SystemDiagnostic,
    database: DatabaseDiagnostic,
    redis: RedisDiagnostic,
    queues: QueueDiagnostic[],
    integrations: IntegrationDiagnostic[],
    performance: PerformanceDiagnostic
  ): Promise<DiagnosticRecommendation[]> {
    const recommendations: DiagnosticRecommendation[] = [];

    // Memory recommendations
    if (system.memory.usage > 90) {
      recommendations.push({
        severity: 'high',
        category: 'system',
        message: 'High memory usage detected',
        impact: 'May cause performance degradation or crashes',
        action: 'Increase memory allocation or optimize memory usage',
        automation: 'Consider auto-scaling'
      });
    }

    // Database recommendations
    if (database.connected && database.queryPerformance.slowQueries > 10) {
      recommendations.push({
        severity: 'medium',
        category: 'database',
        message: 'High number of slow queries detected',
        impact: 'Degrades API response times',
        action: 'Review and optimize slow queries, add indexes',
        automation: 'Enable query analysis tools'
      });
    }

    // Redis recommendations
    if (redis.connected && redis.stats.hitRate < 80) {
      recommendations.push({
        severity: 'medium',
        category: 'cache',
        message: 'Low cache hit rate',
        impact: 'Increased database load',
        action: 'Review caching strategy, increase cache TTL',
        automation: 'Implement cache warming'
      });
    }

    // Queue recommendations
    const largeQueues = queues.filter(q => q.size > 1000);
    if (largeQueues.length > 0) {
      recommendations.push({
        severity: 'high',
        category: 'queues',
        message: `Large queues detected: ${largeQueues.map(q => q.name).join(', ')}`,
        impact: 'Delayed job processing',
        action: 'Scale queue workers or optimize job processing',
        automation: 'Auto-scale workers based on queue size'
      });
    }

    // Integration recommendations
    const failedIntegrations = integrations.filter(i => !i.connected);
    if (failedIntegrations.length > 0) {
      recommendations.push({
        severity: 'high',
        category: 'integrations',
        message: `Failed integrations: ${failedIntegrations.map(i => i.name).join(', ')}`,
        impact: 'Core features may be unavailable',
        action: 'Check integration credentials and endpoints',
        automation: 'Implement automatic retry with backoff'
      });
    }

    // Performance recommendations
    if (performance.slowEndpoints.length > 0) {
      recommendations.push({
        severity: 'medium',
        category: 'performance',
        message: `${performance.slowEndpoints.length} slow endpoints detected`,
        impact: 'Poor user experience',
        action: 'Optimize slow endpoints, implement caching',
        automation: 'Add CDN or response caching'
      });
    }

    return recommendations;
  }

  /**
   * Test database connection
   */
  private async testDatabaseConnection(): Promise<boolean> {
    try {
      await db.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get database pool statistics
   */
  private async getDatabasePoolStats(): Promise<Partial<DatabaseDiagnostic>> {
    // In production, get from connection pool
    return {
      poolSize: 20,
      activeConnections: 5,
      idleConnections: 15,
      waitingClients: 0
    };
  }

  /**
   * Get database table statistics
   */
  private async getDatabaseTableStats(): Promise<DatabaseDiagnostic['tables']> {
    const tables = [
      'businesses',
      'users',
      'invoices',
      'transactions',
      'integrations'
    ];

    const stats = [];

    for (const table of tables) {
      try {
        const count = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
        const size = await db.query(`
          SELECT pg_size_pretty(pg_total_relation_size('${table}')) as size
        `);

        stats.push({
          name: table,
          rowCount: parseInt(count.rows[0].count),
          size: size.rows[0].size,
          indexes: 3 // Would need actual index count
        });
      } catch (error) {
        logger.error(`Error getting stats for table ${table}:`, error);
      }
    }

    return stats;
  }

  /**
   * Get query performance metrics
   */
  private async getQueryPerformance(): Promise<DatabaseDiagnostic['queryPerformance']> {
    // In production, query from pg_stat_statements
    return {
      avgQueryTime: 50,
      slowQueries: 5,
      deadlocks: 0
    };
  }

  /**
   * Test Redis connection
   */
  private async testRedisConnection(): Promise<boolean> {
    try {
      await redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse Redis INFO command output
   */
  private parseRedisInfo(info: string): Record<string, any> {
    const lines = info.split('\n');
    const stats: Record<string, any> = {};

    for (const line of lines) {
      if (line && !line.startsWith('#')) {
        const [key, value] = line.split(':');
        if (key && value) {
          stats[key] = isNaN(Number(value)) ? value : Number(value);
        }
      }
    }

    return stats;
  }

  /**
   * Get Redis slow log
   */
  private async getRedisSlowLog(): Promise<RedisDiagnostic['slowLog']> {
    // In production, get from Redis SLOWLOG
    return [];
  }

  /**
   * Count issues
   */
  private countIssues(...diagnostics: any[]): number {
    let issues = 0;

    for (const diag of diagnostics) {
      if (Array.isArray(diag)) {
        issues += diag.filter(d => d.errorCount > 5).length;
      } else if (diag && typeof diag === 'object') {
        if ('connected' in diag && !diag.connected) issues++;
      }
    }

    return issues;
  }

  /**
   * Count warnings
   */
  private countWarnings(...diagnostics: any[]): number {
    let warnings = 0;

    for (const diag of diagnostics) {
      if (Array.isArray(diag)) {
        warnings += diag.filter(d => d.errorCount > 0 && d.errorCount <= 5).length;
      }
    }

    return warnings;
  }

  /**
   * Store diagnostic report
   */
  private async storeReport(report: DiagnosticReport): Promise<void> {
    const key = `diagnostic:${report.id}`;
    await redis.setex(key, 86400 * 7, JSON.stringify(report)); // Keep for 7 days
  }

  /**
   * Get diagnostic history
   */
  async getHistory(limit: number = 10): Promise<DiagnosticReport[]> {
    const pattern = 'diagnostic:*';
    const keys = await redis.keys(pattern);
    const reports: DiagnosticReport[] = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        reports.push(JSON.parse(data));
      }
    }

    return reports
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /**
   * Get specific diagnostic report
   */
  async getReport(reportId: string): Promise<DiagnosticReport | null> {
    const key = `diagnostic:${reportId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }
}

export const diagnosticService = new DiagnosticService();
