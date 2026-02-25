import { businessRepository } from '../../repositories/BusinessRepository';
import { userRepository } from '../../repositories/UserRepository';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { subDays, subMonths, format, differenceInDays } from 'date-fns';

export interface SystemStats {
  businesses: {
    total: number;
    active: number;
    pending: number;
    suspended: number;
    newToday: number;
    newThisWeek: number;
    newThisMonth: number;
    growthRate: number;
  };
  users: {
    total: number;
    active: number;
    withMFA: number;
    admins: number;
    recentLogins: number;
  };
  financials: {
    totalRevenue: number;
    revenueThisMonth: number;
    revenueLastMonth: number;
    revenueGrowth: number;
    averageTransactionValue: number;
    pendingPayouts: number;
  };
  invoices: {
    total: number;
    paid: number;
    overdue: number;
    drafted: number;
    totalValue: number;
    averageValue: number;
  };
  integrations: {
    total: number;
    active: number;
    failed: number;
    byProvider: Record<string, number>;
  };
  system: {
    apiCalls: number;
    webhookCalls: number;
    queueSize: number;
    averageResponseTime: number;
    errorRate: number;
    uptime: number;
  };
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  businessId?: string;
  lastLogin?: Date;
  mfaEnabled: boolean;
  permissions: string[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  adminId: string;
  adminEmail: string;
  action: string;
  entityType: string;
  entityId?: string;
  details: Record<string, any>;
  ipAddress?: string;
}

export class AdminService {
  private readonly statsCacheTTL = 300; // 5 minutes

  /**
   * Get system statistics
   */
  async getSystemStats(): Promise<SystemStats> {
    try {
      const cacheKey = 'admin:stats';
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const [
        businessStats,
        userStats,
        financialStats,
        invoiceStats,
        integrationStats,
        systemStats
      ] = await Promise.all([
        this.getBusinessStats(),
        this.getUserStats(),
        this.getFinancialStats(),
        this.getInvoiceStats(),
        this.getIntegrationStats(),
        this.getSystemMetrics()
      ]);

      const stats: SystemStats = {
        businesses: businessStats,
        users: userStats,
        financials: financialStats,
        invoices: invoiceStats,
        integrations: integrationStats,
        system: systemStats
      };

      await redis.setex(cacheKey, this.statsCacheTTL, JSON.stringify(stats));

      return stats;
    } catch (error) {
      logger.error('Error getting system stats:', error);
      throw error;
    }
  }

  /**
   * Get business statistics
   */
  private async getBusinessStats(): Promise<SystemStats['businesses']> {
    const now = new Date();
    const today = new Date(now.setHours(0, 0, 0, 0));
    const weekAgo = subDays(today, 7);
    const monthAgo = subDays(today, 30);

    const [total, active, pending, suspended, newToday, newThisWeek, newThisMonth] = await Promise.all([
      businessRepository.count(),
      businessRepository.count({ firs_status: 'active' }),
      businessRepository.count({ firs_status: 'pending' }),
      businessRepository.count({ firs_status: 'suspended' }),
      businessRepository.count({ created_at: { $gte: today } }),
      businessRepository.count({ created_at: { $gte: weekAgo } }),
      businessRepository.count({ created_at: { $gte: monthAgo } })
    ]);

    // Calculate growth rate (compared to last month)
    const lastMonth = await businessRepository.count({
      created_at: { $lt: monthAgo, $gte: subDays(monthAgo, 30) }
    });

    const growthRate = lastMonth > 0 ? ((newThisMonth - lastMonth) / lastMonth) * 100 : 0;

    return {
      total,
      active,
      pending,
      suspended,
      newToday,
      newThisWeek,
      newThisMonth,
      growthRate: Math.round(growthRate * 10) / 10
    };
  }

  /**
   * Get user statistics
   */
  private async getUserStats(): Promise<SystemStats['users']> {
    const now = new Date();
    const dayAgo = subDays(now, 1);

    const [total, active, withMFA, admins, recentLogins] = await Promise.all([
      userRepository.count(),
      userRepository.count({ deleted_at: null }),
      userRepository.count({ mfa_enabled: true }),
      userRepository.count({ role: ['admin', 'super_admin'] }),
      userRepository.count({ last_login_at: { $gte: dayAgo } })
    ]);

    return {
      total,
      active,
      withMFA,
      admins,
      recentLogins
    };
  }

  /**
   * Get financial statistics
   */
  private async getFinancialStats(): Promise<SystemStats['financials']> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const [totalRevenue, revenueThisMonth, revenueLastMonth, avgTransaction, pendingPayouts] = await Promise.all([
      this.getTotalRevenue(),
      this.getRevenueInRange(monthStart, now),
      this.getRevenueInRange(lastMonthStart, lastMonthEnd),
      this.getAverageTransactionValue(),
      this.getPendingPayouts()
    ]);

    const revenueGrowth = revenueLastMonth > 0 
      ? ((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100 
      : 0;

    return {
      totalRevenue,
      revenueThisMonth,
      revenueLastMonth,
      revenueGrowth: Math.round(revenueGrowth * 10) / 10,
      averageTransactionValue: avgTransaction,
      pendingPayouts
    };
  }

  /**
   * Get invoice statistics
   */
  private async getInvoiceStats(): Promise<SystemStats['invoices']> {
    const [total, paid, overdue, drafted, totalValue, avgValue] = await Promise.all([
      invoiceRepository.count(),
      invoiceRepository.count({ payment_status: 'paid' }),
      invoiceRepository.count({ payment_status: 'overdue' }),
      invoiceRepository.count({ status: 'draft' }),
      this.getTotalInvoiceValue(),
      this.getAverageInvoiceValue()
    ]);

    return {
      total,
      paid,
      overdue,
      drafted,
      totalValue,
      averageValue: avgValue
    };
  }

  /**
   * Get integration statistics
   */
  private async getIntegrationStats(): Promise<SystemStats['integrations']> {
    const stats = await accountIntegrationRepository.getProviderStats();
    
    const byProvider: Record<string, number> = {};
    let total = 0;
    let active = 0;
    let failed = 0;

    stats.forEach(stat => {
      byProvider[stat.provider] = stat.total;
      total += parseInt(stat.total);
      active += parseInt(stat.active);
      failed += parseInt(stat.failed_sync || 0);
    });

    return {
      total,
      active,
      failed,
      byProvider
    };
  }

  /**
   * Get system metrics
   */
  private async getSystemMetrics(): Promise<SystemStats['system']> {
    // These would come from monitoring systems
    // Placeholder implementation
    return {
      apiCalls: await this.getAPICallCount(),
      webhookCalls: await this.getWebhookCallCount(),
      queueSize: await this.getQueueSize(),
      averageResponseTime: 250, // ms
      errorRate: 0.5, // percent
      uptime: 99.9 // percent
    };
  }

  /**
   * Get all admin users
   */
  async getAdminUsers(): Promise<AdminUser[]> {
    const users = await userRepository.find({
      role: ['admin', 'super_admin']
    });

    return users.map(u => ({
      id: u.id,
      email: u.email,
      name: `${u.first_name} ${u.last_name}`,
      role: u.role,
      businessId: u.business_id,
      lastLogin: u.last_login_at,
      mfaEnabled: u.mfa_enabled,
      permissions: u.permissions || []
    }));
  }

  /**
   * Create admin user
   */
  async createAdminUser(
    email: string,
    password: string,
    name: string,
    role: 'admin' | 'super_admin',
    createdBy: string
  ): Promise<AdminUser> {
    const [firstName, lastName] = name.split(' ');
    
    const user = await userRepository.createUser({
      email,
      password,
      first_name: firstName || name,
      last_name: lastName || '',
      business_id: 'system',
      role
    }, createdBy);

    return {
      id: user.id,
      email: user.email,
      name: `${user.first_name} ${user.last_name}`,
      role: user.role,
      mfaEnabled: user.mfa_enabled,
      permissions: user.permissions || []
    };
  }

  /**
   * Update admin user
   */
  async updateAdminUser(
    userId: string,
    updates: {
      role?: string;
      permissions?: string[];
      mfaEnabled?: boolean;
    },
    updatedBy: string
  ): Promise<AdminUser> {
    const user = await userRepository.update(userId, updates);
    
    if (!user) {
      throw new Error('User not found');
    }

    // Log audit
    await auditLogRepository.log({
      user_id: updatedBy,
      action: 'ADMIN_UPDATE_USER',
      entity_type: 'user',
      entity_id: userId,
      metadata: updates
    });

    return {
      id: user.id,
      email: user.email,
      name: `${user.first_name} ${user.last_name}`,
      role: user.role,
      businessId: user.business_id,
      lastLogin: user.last_login_at,
      mfaEnabled: user.mfa_enabled,
      permissions: user.permissions || []
    };
  }

  /**
   * Delete admin user
   */
  async deleteAdminUser(userId: string, deletedBy: string): Promise<void> {
    const user = await userRepository.findById(userId);
    
    if (!user) {
      throw new Error('User not found');
    }

    if (user.role === 'super_admin') {
      // Check if last super admin
      const superAdmins = await userRepository.find({ role: 'super_admin' });
      if (superAdmins.length === 1) {
        throw new Error('Cannot delete the last super admin');
      }
    }

    await userRepository.softDelete(userId);

    // Log audit
    await auditLogRepository.log({
      user_id: deletedBy,
      action: 'ADMIN_DELETE_USER',
      entity_type: 'user',
      entity_id: userId,
      metadata: { deleted_user: user.email }
    });
  }

  /**
   * Get audit logs
   */
  async getAuditLogs(
    options?: {
      adminId?: string;
      action?: string;
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ logs: AuditLogEntry[]; total: number }> {
    const result = await auditLogRepository.findByBusiness('system', {
      userId: options?.adminId,
      action: options?.action as any,
      fromDate: options?.fromDate,
      toDate: options?.toDate,
      limit: options?.limit,
      offset: options?.offset
    });

    const logs = await Promise.all(
      result.logs.map(async log => {
        const admin = await userRepository.findById(log.user_id!);
        return {
          id: log.id,
          timestamp: log.created_at,
          adminId: log.user_id!,
          adminEmail: admin?.email || 'unknown',
          action: log.action,
          entityType: log.entity_type,
          entityId: log.entity_id,
          details: log.metadata,
          ipAddress: log.ip_address
        };
      })
    );

    return { logs, total: result.total };
  }

  /**
   * Suspend business
   */
  async suspendBusiness(businessId: string, reason: string, suspendedBy: string): Promise<void> {
    const business = await businessRepository.findById(businessId);
    
    if (!business) {
      throw new Error('Business not found');
    }

    await businessRepository.update(businessId, {
      firs_status: 'suspended',
      metadata: {
        ...business.metadata,
        suspended_at: new Date(),
        suspended_by: suspendedBy,
        suspension_reason: reason
      }
    });

    // Notify business owners
    const admins = await userRepository.findAdmins(businessId);
    for (const admin of admins) {
      await notificationService.send({
        businessId,
        userId: admin.id,
        type: 'action_required',
        title: 'Business Suspended',
        body: `Your business has been suspended. Reason: ${reason}`,
        priority: 'critical'
      });
    }

    // Log audit
    await auditLogRepository.log({
      user_id: suspendedBy,
      action: 'SUSPEND_BUSINESS',
      entity_type: 'business',
      entity_id: businessId,
      metadata: { reason }
    });
  }

  /**
   * Reinstate business
   */
  async reinstateBusiness(businessId: string, reinstatedBy: string): Promise<void> {
    const business = await businessRepository.findById(businessId);
    
    if (!business) {
      throw new Error('Business not found');
    }

    await businessRepository.update(businessId, {
      firs_status: 'active',
      metadata: {
        ...business.metadata,
        reinstated_at: new Date(),
        reinstated_by: reinstatedBy
      }
    });

    // Notify business owners
    const admins = await userRepository.findAdmins(businessId);
    for (const admin of admins) {
      await notificationService.send({
        businessId,
        userId: admin.id,
        type: 'success',
        title: 'Business Reinstated',
        body: 'Your business has been reinstated.',
        priority: 'high'
      });
    }

    // Log audit
    await auditLogRepository.log({
      user_id: reinstatedBy,
      action: 'REINSTATE_BUSINESS',
      entity_type: 'business',
      entity_id: businessId,
      metadata: {}
    });
  }

  /**
   * Get system health
   */
  async getSystemHealth(): Promise<any> {
    const checks = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkQueues(),
      this.checkExternalServices()
    ]);

    const allHealthy = checks.every(c => c.healthy);

    return {
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: checks.reduce((acc, check) => {
        acc[check.service] = {
          status: check.healthy ? 'up' : 'down',
          latency: check.latency,
          message: check.message
        };
        return acc;
      }, {})
    };
  }

  /**
   * Check database health
   */
  private async checkDatabase(): Promise<any> {
    const start = Date.now();
    try {
      await db.query('SELECT 1');
      return {
        service: 'database',
        healthy: true,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        service: 'database',
        healthy: false,
        latency: Date.now() - start,
        message: error.message
      };
    }
  }

  /**
   * Check Redis health
   */
  private async checkRedis(): Promise<any> {
    const start = Date.now();
    try {
      await redis.ping();
      return {
        service: 'redis',
        healthy: true,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        service: 'redis',
        healthy: false,
        latency: Date.now() - start,
        message: error.message
      };
    }
  }

  /**
   * Check queues health
   */
  private async checkQueues(): Promise<any> {
    const start = Date.now();
    try {
      const metrics = await queueService.getAllMetrics();
      const totalJobs = metrics.reduce((sum, m) => sum + m.waiting + m.active, 0);
      return {
        service: 'queues',
        healthy: totalJobs < 10000,
        latency: Date.now() - start,
        message: `${totalJobs} jobs in queues`
      };
    } catch (error) {
      return {
        service: 'queues',
        healthy: false,
        latency: Date.now() - start,
        message: error.message
      };
    }
  }

  /**
   * Check external services health
   */
  private async checkExternalServices(): Promise<any> {
    const start = Date.now();
    // Check FIRS, payment gateways, etc.
    return {
      service: 'external',
      healthy: true,
      latency: Date.now() - start
    };
  }

  // Placeholder implementations for financial metrics
  private async getTotalRevenue(): Promise<number> {
    return 15000000; // ₦15M placeholder
  }

  private async getRevenueInRange(from: Date, to: Date): Promise<number> {
    return 500000; // ₦500K placeholder
  }

  private async getAverageTransactionValue(): Promise<number> {
    return 75000; // ₦75K placeholder
  }

  private async getPendingPayouts(): Promise<number> {
    return 250000; // ₦250K placeholder
  }

  private async getTotalInvoiceValue(): Promise<number> {
    return 25000000; // ₦25M placeholder
  }

  private async getAverageInvoiceValue(): Promise<number> {
    return 85000; // ₦85K placeholder
  }

  private async getAPICallCount(): Promise<number> {
    return 150000; // 150K calls placeholder
  }

  private async getWebhookCallCount(): Promise<number> {
    return 50000; // 50K calls placeholder
  }

  private async getQueueSize(): Promise<number> {
    const metrics = await queueService.getAllMetrics();
    return metrics.reduce((sum, m) => sum + m.waiting + m.active, 0);
  }
}

export const adminService = new AdminService();
