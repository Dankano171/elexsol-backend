import Redis from 'ioredis';
import { logger } from './logger';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
  retryStrategy: (times: number) => number | null;
  maxRetriesPerRequest: number;
  enableReadyCheck: boolean;
  lazyConnect: boolean;
}

class RedisManager {
  private static instance: RedisManager;
  private client: Redis.Redis;
  private subscriber: Redis.Redis;
  private config: RedisConfig;

  private constructor() {
    this.config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
      keyPrefix: 'elexsol:',
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        if (times > 10) {
          logger.error('Redis max retries reached');
          return null;
        }
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    };

    const redisOptions = {
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      db: this.config.db,
      keyPrefix: this.config.keyPrefix,
      retryStrategy: this.config.retryStrategy,
      maxRetriesPerRequest: this.config.maxRetriesPerRequest,
      enableReadyCheck: this.config.enableReadyCheck,
      lazyConnect: this.config.lazyConnect,
    };

    this.client = new Redis(redisOptions);
    this.subscriber = new Redis(redisOptions);

    this.setupEventHandlers();
  }

  public static getInstance(): RedisManager {
    if (!RedisManager.instance) {
      RedisManager.instance = new RedisManager();
    }
    return RedisManager.instance;
  }

  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.debug('Redis client connecting...');
    });

    this.client.on('ready', () => {
      logger.info('✅ Redis client ready');
    });

    this.client.on('error', (error) => {
      logger.error('Redis client error:', error);
    });

    this.client.on('close', () => {
      logger.warn('Redis connection closed');
    });

    this.subscriber.on('ready', () => {
      logger.debug('Redis subscriber ready');
    });

    this.subscriber.on('error', (error) => {
      logger.error('Redis subscriber error:', error);
    });
  }

  public getClient(): Redis.Redis {
    return this.client;
  }

  public getSubscriber(): Redis.Redis {
    return this.subscriber;
  }

  public async set(
    key: string,
    value: any,
    ttlSeconds?: number
  ): Promise<'OK'> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds) {
      return await this.client.setex(key, ttlSeconds, serialized);
    }
    return await this.client.set(key, serialized);
  }

  public async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  }

  public async del(key: string): Promise<number> {
    return await this.client.del(key);
  }

  public async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  public async expire(key: string, seconds: number): Promise<boolean> {
    const result = await this.client.expire(key, seconds);
    return result === 1;
  }

  public async ttl(key: string): Promise<number> {
    return await this.client.ttl(key);
  }

  public async incr(key: string): Promise<number> {
    return await this.client.incr(key);
  }

  public async decr(key: string): Promise<number> {
    return await this.client.decr(key);
  }

  public async hset(key: string, field: string, value: any): Promise<number> {
    const serialized = JSON.stringify(value);
    return await this.client.hset(key, field, serialized);
  }

  public async hget<T>(key: string, field: string): Promise<T | null> {
    const value = await this.client.hget(key, field);
    if (!value) return null;
    return JSON.parse(value) as T;
  }

  public async hgetall(key: string): Promise<Record<string, any>> {
    const result = await this.client.hgetall(key);
    const parsed: Record<string, any> = {};
    for (const [field, value] of Object.entries(result)) {
      try {
        parsed[field] = JSON.parse(value);
      } catch {
        parsed[field] = value;
      }
    }
    return parsed;
  }

  public async publish(channel: string, message: any): Promise<number> {
    const serialized = JSON.stringify(message);
    return await this.client.publish(channel, serialized);
  }

  public async subscribe(
    channel: string,
    callback: (message: any) => void
  ): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch, message) => {
      if (ch === channel) {
        try {
          const parsed = JSON.parse(message);
          callback(parsed);
        } catch (error) {
          logger.error('Redis message parse error:', error);
        }
      }
    });
  }

  public async unsubscribe(channel: string): Promise<void> {
    await this.subscriber.unsubscribe(channel);
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis health check failed:', error);
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.client.quit();
    await this.subscriber.quit();
    logger.info('Redis connections closed');
  }

  public async flushAll(): Promise<void> {
    await this.client.flushall();
  }

  public async keys(pattern: string): Promise<string[]> {
    return await this.client.keys(pattern);
  }

  // Rate limiting utilities
  public async rateLimit(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{
    allowed: boolean;
    current: number;
    remaining: number;
    resetAt: Date;
  }> {
    const now = Date.now() / 1000;
    const windowKey = `${key}:${Math.floor(now / windowSeconds)}`;
    
    const current = await this.client.incr(windowKey);
    if (current === 1) {
      await this.client.expire(windowKey, windowSeconds);
    }
    
    const resetAt = new Date((Math.floor(now / windowSeconds) + 1) * windowSeconds * 1000);
    
    return {
      allowed: current <= limit,
      current,
      remaining: Math.max(0, limit - current),
      resetAt,
    };
  }

  // Distributed lock
  public async acquireLock(
    lockKey: string,
    ttlSeconds: number = 10
  ): Promise<string | null> {
    const lockValue = Math.random().toString(36).substring(2);
    const result = await this.client.set(
      `lock:${lockKey}`,
      lockValue,
      'NX',
      'EX',
      ttlSeconds
    );
    return result === 'OK' ? lockValue : null;
  }

  public async releaseLock(lockKey: string, lockValue: string): Promise<boolean> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.client.eval(script, 1, `lock:${lockKey}`, lockValue);
    return result === 1;
  }
}

export const redis = RedisManager.getInstance();
export const initializeRedis = async (): Promise<void> => {
  await redis.healthCheck();
  logger.info('✅ Redis initialized successfully');
};
