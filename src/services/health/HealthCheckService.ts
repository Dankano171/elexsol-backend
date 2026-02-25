import { db } from '../../config/database';
import { redis } from '../../config/redis';
import { queueService } from '../queue/QueueService';
import { logger } from '../../config/logger';
import os from 'os';
import axios from 'axios';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  environment: string;
  services: {
    database: ServiceHealth;
    redis: ServiceHealth;
    queues: ServiceHealth;
    disk: ServiceHealth;
    memory: ServiceHealth;
    cpu: ServiceHealth;
    external: Record<string, ServiceHealth>;
  };
  metrics: HealthMetrics;
  checks: HealthCheck[];
}

export interface ServiceHealth {
  status: 'up' | 'down' | 'degraded';
  latency: number;
  message?: string;
  lastChecked: string;
}

export interface HealthMetrics {
  uptime: number;
  totalMemory: number;
  freeMemory: number;
  usedMemory: number;
  memoryUsage: number;
  cpuLoad: number[];
  connections: number;
  requestRate: number;
  errorRate: number;
}

export interface HealthCheck {
  name: string;
  status: 'passed' | 'failed' | 'warning';
  message?: string;
  duration: number;
  timestamp: string;
}

export class HealthCheckService {
  private readonly version = process.env.npm_package_version || '1.0.0';
  private readonly environment = process.env.NODE_ENV || 'development';
  private readonly startupTime = Date.now();

  /**
   * Run comprehensive health check
   */
  async runHealthCheck(deep: boolean = false): Promise<HealthStatus> {
    const checks: HealthCheck[] = [];
    const startTime = Date.now();

    try {
      // Run all checks in parallel
      const [
        databaseHealth,
        redisHealth,
        queuesHealth,
        diskHealth,
        memoryHealth,
        cpuHealth,
        externalHealth
      ] = await Promise.all([
        this.checkDatabase(checks),
        this.checkRedis(checks),
        this.checkQueues(checks),
        this.checkDisk(checks),
        this.checkMemory(checks),
        this.checkCPU(checks),
        deep ? this.checkExternalServices(checks) : Promise.resolve({})
      ]);

      // Calculate overall status
      const services = {
        database: databaseHealth,
        redis: redisHealth,
        queues: queuesHealth,
        disk: diskHealth,
        memory: memoryHealth,
        cpu: cpuHealth,
        external: externalHealth
      };

      const status = this.determineOverallStatus(services);

      // Get metrics
      const metrics = await this.getHealthMetrics();

      const duration = Date.now() - startTime;

      return {
        status,
        timestamp: new Date().toISOString(),
        version: this.version,
        environment: this.environment,
        services,
        metrics,
        checks
      };
    } catch (error) {
      logger.error('Health check failed:', error);
      throw error;
    }
  }

  /**
   * Check database health
   */
  private async checkDatabase(checks: HealthCheck[]): Promise<ServiceHealth> {
    const checkName = 'database';
    const start = Date.now();

    try {
      const result = await db.query('SELECT 1 as health');
      const latency = Date.now() - start;

      const health: ServiceHealth = {
        status: 'up',
        latency,
        lastChecked: new Date().toISOString()
      };

      checks.push({
        name: checkName,
        status: 'passed',
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return health;
    } catch (error) {
      const latency = Date.now() - start;

      checks.push({
        name: checkName,
        status: 'failed',
        message: error.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'down',
        latency,
        message: error.message,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check Redis health
   */
  private async checkRedis(checks: HealthCheck[]): Promise<ServiceHealth> {
    const checkName = 'redis';
    const start = Date.now();

    try {
      const result = await redis.ping();
      const latency = Date.now() - start;

      const health: ServiceHealth = {
        status: result === 'PONG' ? 'up' : 'down',
        latency,
        lastChecked: new Date().toISOString()
      };

      checks.push({
        name: checkName,
        status: health.status === 'up' ? 'passed' : 'failed',
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return health;
    } catch (error) {
      const latency = Date.now() - start;

      checks.push({
        name: checkName,
        status: 'failed',
        message: error.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'down',
        latency,
        message: error.message,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check queues health
   */
  private async checkQueues(checks: HealthCheck[]): Promise<ServiceHealth> {
    const checkName = 'queues';
    const start = Date.now();

    try {
      const metrics = await queueService.getAllMetrics();
      const latency = Date.now() - start;

      // Check for stuck jobs
      const totalJobs = metrics.reduce((sum, m) => sum + m.waiting + m.active, 0);
      const status = totalJobs < 10000 ? 'up' : 'degraded';

      const health: ServiceHealth = {
        status,
        latency,
        message: `${totalJobs} jobs in queues`,
        lastChecked: new Date().toISOString()
      };

      checks.push({
        name: checkName,
        status: status === 'up' ? 'passed' : 'warning',
        message: health.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return health;
    } catch (error) {
      const latency = Date.now() - start;

      checks.push({
        name: checkName,
        status: 'failed',
        message: error.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'down',
        latency,
        message: error.message,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check disk health
   */
  private async checkDisk(checks: HealthCheck[]): Promise<ServiceHealth> {
    const checkName = 'disk';
    const start = Date.now();

    try {
      // In production, use 'diskusage' package
      // Placeholder implementation
      const usedPercentage = 45; // Mock value
      const latency = Date.now() - start;

      const status = usedPercentage < 90 ? 'up' : usedPercentage < 95 ? 'degraded' : 'down';

      const health: ServiceHealth = {
        status,
        latency,
        message: `Disk usage: ${usedPercentage}%`,
        lastChecked: new Date().toISOString()
      };

      checks.push({
        name: checkName,
        status: status === 'up' ? 'passed' : status === 'degraded' ? 'warning' : 'failed',
        message: health.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return health;
    } catch (error) {
      const latency = Date.now() - start;

      checks.push({
        name: checkName,
        status: 'failed',
        message: error.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'down',
        latency,
        message: error.message,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check memory health
   */
  private async checkMemory(checks: HealthCheck[]): Promise<ServiceHealth> {
    const checkName = 'memory';
    const start = Date.now();

    try {
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      const usedPercentage = (usedMemory / totalMemory) * 100;

      const latency = Date.now() - start;

      const status = usedPercentage < 90 ? 'up' : usedPercentage < 95 ? 'degraded' : 'down';

      const health: ServiceHealth = {
        status,
        latency,
        message: `Memory usage: ${Math.round(usedPercentage)}%`,
        lastChecked: new Date().toISOString()
      };

      checks.push({
        name: checkName,
        status: status === 'up' ? 'passed' : status === 'degraded' ? 'warning' : 'failed',
        message: health.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return health;
    } catch (error) {
      const latency = Date.now() - start;

      checks.push({
        name: checkName,
        status: 'failed',
        message: error.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'down',
        latency,
        message: error.message,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check CPU health
   */
  private async checkCPU(checks: HealthCheck[]): Promise<ServiceHealth> {
    const checkName = 'cpu';
    const start = Date.now();

    try {
      const loadAvg = os.loadavg();
      const cpus = os.cpus();
      const latency = Date.now() - start;

      // Calculate CPU usage (simplified)
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

      const status = usage < 80 ? 'up' : usage < 90 ? 'degraded' : 'down';

      const health: ServiceHealth = {
        status,
        latency,
        message: `CPU usage: ${Math.round(usage)}%, Load: ${loadAvg.map(l => l.toFixed(2)).join(', ')}`,
        lastChecked: new Date().toISOString()
      };

      checks.push({
        name: checkName,
        status: status === 'up' ? 'passed' : status === 'degraded' ? 'warning' : 'failed',
        message: health.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return health;
    } catch (error) {
      const latency = Date.now() - start;

      checks.push({
        name: checkName,
        status: 'failed',
        message: error.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'down',
        latency,
        message: error.message,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Check external services health
   */
  private async checkExternalServices(checks: HealthCheck[]): Promise<Record<string, ServiceHealth>> {
    const services: Record<string, ServiceHealth> = {};
    
    // Check FIRS API
    services.firs = await this.checkExternalAPI(
      'FIRS API',
      process.env.FIRS_API_URL || 'https://taxpayers.ng/firs/api',
      checks
    );

    // Check payment gateway
    services.payment = await this.checkExternalAPI(
      'Payment Gateway',
      process.env.PAYMENT_API_URL || 'https://api.payment.com/health',
      checks
    );

    // Check email service
    services.email = await this.checkExternalAPI(
      'Email Service',
      process.env.EMAIL_API_URL || 'https://api.email.com/health',
      checks
    );

    return services;
  }

  /**
   * Check external API health
   */
  private async checkExternalAPI(
    name: string,
    url: string,
    checks: HealthCheck[]
  ): Promise<ServiceHealth> {
    const start = Date.now();

    try {
      const response = await axios.get(url, {
        timeout: 5000,
        validateStatus: (status) => status < 500
      });

      const latency = Date.now() - start;
      const status = response.status < 400 ? 'up' : 'degraded';

      checks.push({
        name,
        status: status === 'up' ? 'passed' : 'warning',
        message: `HTTP ${response.status}`,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return {
        status,
        latency,
        message: `HTTP ${response.status}`,
        lastChecked: new Date().toISOString()
      };
    } catch (error) {
      const latency = Date.now() - start;

      checks.push({
        name,
        status: 'failed',
        message: error.message,
        duration: latency,
        timestamp: new Date().toISOString()
      });

      return {
        status: 'down',
        latency,
        message: error.message,
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Get health metrics
   */
  private async getHealthMetrics(): Promise<HealthMetrics> {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const memoryUsage = (usedMemory / totalMemory) * 100;

    return {
      uptime: Math.floor((Date.now() - this.startupTime) / 1000),
      totalMemory,
      freeMemory,
      usedMemory,
      memoryUsage: Math.round(memoryUsage * 100) / 100,
      cpuLoad: os.loadavg(),
      connections: await this.getActiveConnections(),
      requestRate: await this.getRequestRate(),
      errorRate: await this.getErrorRate()
    };
  }

  /**
   * Determine overall health status
   */
  private determineOverallStatus(services: any): 'healthy' | 'degraded' | 'unhealthy' {
    let hasDown = false;
    let hasDegraded = false;

    for (const [_, service] of Object.entries(services)) {
      if (typeof service === 'object' && service !== null) {
        if ('status' in service) {
          if (service.status === 'down') hasDown = true;
          if (service.status === 'degraded') hasDegraded = true;
        } else {
          // Handle external services object
          for (const [__, extService] of Object.entries(service)) {
            if (extService && typeof extService === 'object' && 'status' in extService) {
              if (extService.status === 'down') hasDown = true;
              if (extService.status === 'degraded') hasDegraded = true;
            }
          }
        }
      }
    }

    if (hasDown) return 'unhealthy';
    if (hasDegraded) return 'degraded';
    return 'healthy';
  }

  /**
   * Get active connections (placeholder)
   */
  private async getActiveConnections(): Promise<number> {
    // In production, get from connection pools
    return 100;
  }

  /**
   * Get request rate (placeholder)
   */
  private async getRequestRate(): Promise<number> {
    // In production, calculate from metrics
    return 50;
  }

  /**
   * Get error rate (placeholder)
   */
  private async getErrorRate(): Promise<number> {
    // In production, calculate from metrics
    return 0.5;
  }

  /**
   * Get uptime
   */
  getUptime(): number {
    return Math.floor((Date.now() - this.startupTime) / 1000);
  }

  /**
   * Get basic health (for load balancers)
   */
  async getBasicHealth(): Promise<{ status: string; timestamp: string }> {
    try {
      await db.query('SELECT 1');
      await redis.ping();
      
      return {
        status: 'healthy',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString()
      };
    }
  }
}

export const healthCheckService = new HealthCheckService();
