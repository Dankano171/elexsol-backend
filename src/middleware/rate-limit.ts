import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { logger } from '../config/logger';

export interface RateLimitOptions {
  window: number; // Time window in seconds
  max: number;    // Max requests per window
  message?: string;
  statusCode?: number;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

const defaultKeyGenerator = (req: Request): string => {
  return `${req.ip}:${req.path}`;
};

const defaultSkip = (req: Request): boolean => {
  // Skip rate limiting for health checks
  return req.path === '/health' || req.path === '/metrics';
};

export const rateLimit = (options: RateLimitOptions) => {
  const {
    window,
    max,
    message = 'Too many requests, please try again later.',
    statusCode = 429,
    keyGenerator = defaultKeyGenerator,
    skip = defaultSkip
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (skip(req)) {
        return next();
      }

      const key = `rate_limit:${keyGenerator(req)}`;
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, window);
      }

      const ttl = await redis.ttl(key);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));
      res.setHeader('X-RateLimit-Reset', Math.ceil(Date.now() / 1000 + ttl));

      if (current > max) {
        logger.warn('Rate limit exceeded', {
          ip: req.ip,
          path: req.path,
          key: keyGenerator(req)
        });

        return res.status(statusCode).json({
          success: false,
          error: message,
          retryAfter: ttl
        });
      }

      next();
    } catch (error) {
      logger.error('Rate limit error:', error);
      // If rate limiting fails, allow the request
      next();
    }
  };
};

/**
 * Per-user rate limiting
 */
export const userRateLimit = (options: RateLimitOptions) => {
  const keyGenerator = (req: Request): string => {
    const userId = req.user?.id || 'anonymous';
    return `user:${userId}:${req.path}`;
  };

  return rateLimit({
    ...options,
    keyGenerator
  });
};

/**
 * Per-API key rate limiting
 */
export const apiKeyRateLimit = (options: RateLimitOptions) => {
  const keyGenerator = (req: Request): string => {
    const apiKey = req.headers['x-api-key'] as string || 'no-api-key';
    return `apikey:${apiKey}:${req.path}`;
  };

  return rateLimit({
    ...options,
    keyGenerator
  });
};

/**
 * Sliding window rate limit
 */
export const slidingWindowRateLimit = (options: RateLimitOptions) => {
  const { window, max } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = `sliding:${defaultKeyGenerator(req)}`;
      const now = Date.now();
      const windowMs = window * 1000;

      // Remove old entries
      await redis.zremrangebyscore(key, 0, now - windowMs);

      // Count current entries
      const count = await redis.zcard(key);

      // Add current request
      await redis.zadd(key, now, `${now}-${Math.random()}`);
      await redis.expire(key, window);

      if (count >= max) {
        return res.status(429).json({
          success: false,
          error: 'Too many requests, please try again later.'
        });
      }

      next();
    } catch (error) {
      logger.error('Sliding window rate limit error:', error);
      next();
    }
  };
};

/**
 * Concurrent request limiter
 */
export const concurrentLimit = (maxConcurrent: number) => {
  const activeRequests = new Map<string, number>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}:${req.path}`;
    const current = activeRequests.get(key) || 0;

    if (current >= maxConcurrent) {
      return res.status(429).json({
        success: false,
        error: 'Too many concurrent requests'
      });
    }

    activeRequests.set(key, current + 1);

    res.on('finish', () => {
      const remaining = activeRequests.get(key) || 1;
      if (remaining <= 1) {
        activeRequests.delete(key);
      } else {
        activeRequests.set(key, remaining - 1);
      }
    });

    next();
  };
};
