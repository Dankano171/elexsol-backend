import { Request } from 'express';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import ipaddr from 'ipaddr.js';

export interface SecurityCheck {
  allowed: boolean;
  reason?: string;
}

export interface RateLimitResult {
  limited: boolean;
  current: number;
  limit: number;
  remaining: number;
  resetAt: Date;
}

export class WebhookSecurity {
  private readonly ipWhitelists: Record<string, string[]> = {
    zoho: [
      '136.143.188.0/24',
      '165.225.72.0/24',
      '165.225.74.0/24',
      '165.225.76.0/24',
      '165.225.78.0/24'
    ],
    whatsapp: [
      '3.208.120.0/24',
      '18.208.120.0/24',
      '34.224.0.0/12',
      '52.200.0.0/13',
      '54.144.0.0/12',
      '54.208.0.0/13',
      '54.224.0.0/12'
    ],
    quickbooks: [
      '52.10.120.0/24',
      '54.148.160.0/24',
      '54.186.0.0/16',
      '54.188.0.0/15',
      '54.200.0.0/15',
      '54.202.0.0/16'
    ]
  };

  private readonly rateLimits: Record<string, { window: number; max: number }> = {
    zoho: { window: 60, max: 100 }, // 100 per minute
    whatsapp: { window: 60, max: 1000 }, // 1000 per minute
    quickbooks: { window: 60, max: 500 }, // 500 per minute
    generic: { window: 60, max: 50 } // 50 per minute for generic endpoints
  };

  private readonly userAgents: Record<string, RegExp[]> = {
    zoho: [
      /^ZohoWebhook/i,
      /^ZohoBooks/i
    ],
    whatsapp: [
      /^WhatsApp/i,
      /^Facebook/i
    ],
    quickbooks: [
      /^Intuit/i,
      /^QuickBooks/i
    ]
  };

  /**
   * Check if request is allowed
   */
  async checkRequest(req: Request, provider: string): Promise<SecurityCheck> {
    // Check IP whitelist
    const ipCheck = this.checkIP(req.ip || '', provider);
    if (!ipCheck.allowed) {
      return ipCheck;
    }

    // Check User-Agent
    const uaCheck = this.checkUserAgent(req.headers['user-agent'] || '', provider);
    if (!uaCheck.allowed) {
      return uaCheck;
    }

    // Check for suspicious patterns
    const suspiciousCheck = await this.checkSuspiciousActivity(req, provider);
    if (!suspiciousCheck.allowed) {
      return suspiciousCheck;
    }

    return { allowed: true };
  }

  /**
   * Check IP against whitelist
   */
  private checkIP(ip: string, provider: string): SecurityCheck {
    try {
      // Parse IP
      const addr = ipaddr.parse(ip);
      
      // Convert IPv6 to IPv4 if possible
      const ipString = addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()
        ? addr.toIPv4Address().toString()
        : ip;

      const whitelist = this.ipWhitelists[provider] || [];
      
      // If no whitelist for provider, allow all
      if (whitelist.length === 0) {
        return { allowed: true };
      }

      // Check if IP is in whitelist
      for (const range of whitelist) {
        if (this.isIPInRange(ipString, range)) {
          return { allowed: true };
        }
      }

      logger.warn('IP not in whitelist', { ip, provider });
      return { 
        allowed: false, 
        reason: `IP ${ip} not in whitelist for provider ${provider}` 
      };
    } catch (error) {
      logger.error('Error checking IP', { ip, provider, error });
      return { allowed: false, reason: 'Invalid IP address' };
    }
  }

  /**
   * Check User-Agent
   */
  private checkUserAgent(userAgent: string, provider: string): SecurityCheck {
    const patterns = this.userAgents[provider];
    
    if (!patterns || patterns.length === 0) {
      return { allowed: true };
    }

    const matches = patterns.some(pattern => pattern.test(userAgent));
    
    if (!matches) {
      logger.warn('Invalid User-Agent', { userAgent, provider });
      return { 
        allowed: false, 
        reason: `Invalid User-Agent for provider ${provider}` 
      };
    }

    return { allowed: true };
  }

  /**
   * Check for suspicious activity
   */
  private async checkSuspiciousActivity(
    req: Request,
    provider: string
  ): Promise<SecurityCheck> {
    const key = `webhook:suspicious:${provider}:${req.ip}`;
    const recent = await redis.get(key);

    if (recent) {
      const data = JSON.parse(recent);
      
      // Check for rapid repeated requests
      if (data.count > 10) {
        logger.warn('Suspicious webhook activity detected', {
          ip: req.ip,
          provider,
          count: data.count
        });
        
        return { 
          allowed: false, 
          reason: 'Suspicious activity detected' 
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check rate limit
   */
  async checkRateLimit(req: Request, provider: string): Promise<RateLimitResult> {
    const limit = this.rateLimits[provider] || this.rateLimits.generic;
    const key = `webhook:ratelimit:${provider}:${req.ip}`;

    const current = await redis.incr(key);
    
    if (current === 1) {
      await redis.expire(key, limit.window);
    }

    const resetAt = new Date();
    resetAt.setSeconds(resetAt.getSeconds() + (await redis.ttl(key)));

    return {
      limited: current > limit.max,
      current,
      limit: limit.max,
      remaining: Math.max(0, limit.max - current),
      resetAt
    };
  }

  /**
   * Check if IP is in CIDR range
   */
  private isIPInRange(ip: string, range: string): boolean {
    try {
      const addr = ipaddr.parse(ip);
      const [cidrAddr, bits] = range.split('/');
      const rangeAddr = ipaddr.parse(cidrAddr);
      
      return addr.match(rangeAddr, parseInt(bits));
    } catch {
      return false;
    }
  }

  /**
   * Get allowed IPs for provider
   */
  getAllowedIPs(provider: string): string[] {
    return this.ipWhitelists[provider] || [];
  }

  /**
   * Add IP to whitelist (for testing/custom providers)
   */
  async addToWhitelist(provider: string, ip: string): Promise<void> {
    if (!this.ipWhitelists[provider]) {
      this.ipWhitelists[provider] = [];
    }
    
    if (!this.ipWhitelists[provider].includes(ip)) {
      this.ipWhitelists[provider].push(ip);
      
      logger.info('IP added to whitelist', { provider, ip });
    }
  }

  /**
   * Remove IP from whitelist
   */
  async removeFromWhitelist(provider: string, ip: string): Promise<void> {
    if (this.ipWhitelists[provider]) {
      this.ipWhitelists[provider] = this.ipWhitelists[provider]
        .filter(allowedIp => allowedIp !== ip);
      
      logger.info('IP removed from whitelist', { provider, ip });
    }
  }

  /**
   * Update rate limit for provider
   */
  updateRateLimit(
    provider: string,
    window: number,
    max: number
  ): void {
    this.rateLimits[provider] = { window, max };
    
    logger.info('Rate limit updated', { provider, window, max });
  }

  /**
   * Get security status for provider
   */
  async getSecurityStatus(provider: string): Promise<any> {
    const ips = this.getAllowedIPs(provider);
    const rateLimit = this.rateLimits[provider] || this.rateLimits.generic;
    const patterns = this.userAgents[provider] || [];

    // Get current blocked IPs
    const blockedKey = `webhook:blocked:*`;
    const blockedKeys = await redis.keys(blockedKey);
    const blockedIPs = await Promise.all(
      blockedKeys.map(async key => {
        const data = await redis.get(key);
        return data ? JSON.parse(data) : null;
      })
    );

    return {
      provider,
      ipWhitelist: {
        enabled: ips.length > 0,
        ips
      },
      rateLimit: {
        window: rateLimit.window,
        max: rateLimit.max
      },
      userAgentValidation: {
        enabled: patterns.length > 0,
        patterns: patterns.map(p => p.toString())
      },
      currentlyBlocked: blockedIPs.filter(Boolean).length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Block an IP address
   */
  async blockIP(ip: string, reason: string, duration: number = 3600): Promise<void> {
    const key = `webhook:blocked:${ip}`;
    await redis.setex(key, duration, JSON.stringify({
      ip,
      reason,
      blockedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + duration * 1000).toISOString()
    }));

    logger.warn('IP blocked', { ip, reason, duration });
  }

  /**
   * Unblock an IP address
   */
  async unblockIP(ip: string): Promise<void> {
    const key = `webhook:blocked:${ip}`;
    await redis.del(key);

    logger.info('IP unblocked', { ip });
  }

  /**
   * Check if IP is blocked
   */
  async isIPBlocked(ip: string): Promise<boolean> {
    const key = `webhook:blocked:${ip}`;
    const blocked = await redis.get(key);
    return !!blocked;
  }

  /**
   * Generate security report
   */
  async generateSecurityReport(): Promise<any> {
    const providers = Object.keys(this.rateLimits);
    const report: any = {
      generatedAt: new Date().toISOString(),
      providers: {},
      summary: {
        totalRequests: 0,
        blockedRequests: 0,
        rateLimited: 0
      }
    };

    for (const provider of providers) {
      const status = await this.getSecurityStatus(provider);
      report.providers[provider] = status;

      // Get metrics for today
      const date = new Date().toISOString().split('T')[0];
      const metricsKey = `webhook:metrics:${provider}:${date}`;
      const metrics = await redis.hgetall(metricsKey);
      
      if (metrics.total) {
        report.summary.totalRequests += parseInt(metrics.total);
      }
    }

    // Get blocked count
    const blockedKeys = await redis.keys('webhook:blocked:*');
    report.summary.blockedRequests = blockedKeys.length;

    return report;
  }
}

export const webhookSecurity = new WebhookSecurity();
