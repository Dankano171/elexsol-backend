import { reportModel } from '../../models/Report';
import { businessRepository } from '../../repositories/BusinessRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { subDays, subMonths, format, differenceInDays } from 'date-fns';

export interface ReportAnalytics {
  summary: {
    totalReports: number;
    scheduledReports: number;
    generatedToday: number;
    averageGenerationTime: number;
    popularFormats: Record<string, number>;
    popularTypes: Record<string, number>;
  };
  usage: {
    byBusiness: Array<{
      businessId: string;
      businessName: string;
      reportCount: number;
      lastGenerated: Date;
    }>;
    byDay: Array<{
      date: string;
      count: number;
    }>;
    byHour: Array<{
      hour: number;
      count: number;
    }>;
  };
  performance: {
    averageTimeByType: Record<string, number>;
    successRate: number;
    failureRate: number;
    topErrors: Array<{
      error: string;
      count: number;
    }>;
  };
  trends: {
    weekly: Array<{
      week: string;
      count: number;
      change: number;
    }>;
    monthly: Array<{
      month: string;
      count: number;
      change: number;
    }>;
  };
  recommendations: Array<{
    type: 'info' | 'warning' | 'success';
    message: string;
    action?: string;
  }>;
}

export class ReportAnalyticsService {
  private readonly cacheTTL = 3600; // 1 hour

  /**
   * Get report analytics
   */
  async getAnalytics(
    businessId?: string,
    days: number = 30
  ): Promise<ReportAnalytics> {
    try {
      const cacheKey = `analytics:reports:${businessId || 'all'}:${days}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const fromDate = subDays(new Date(), days);

      // Get reports
      const reports = await this.getReportsInRange(businessId, fromDate);

      // Calculate analytics
      const analytics = await this.calculateAnalytics(reports, businessId, days);

      await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(analytics));

      return analytics;
    } catch (error) {
      logger.error('Error getting report analytics:', error);
      throw error;
    }
  }

  /**
   * Get reports in date range
   */
  private async getReportsInRange(
    businessId?: string,
    fromDate?: Date
  ): Promise<any[]> {
    const conditions: any = {};
    
    if (businessId) {
      conditions.business_id = businessId;
    }
    
    if (fromDate) {
      conditions.created_at = { $gte: fromDate };
    }

    return reportModel.find(conditions);
  }

  /**
   * Calculate analytics
   */
  private async calculateAnalytics(
    reports: any[],
    businessId?: string,
    days: number = 30
  ): Promise<ReportAnalytics> {
    // Summary
    const totalReports = reports.length;
    const scheduledReports = reports.filter(r => r.is_scheduled).length;
    const generatedToday = reports.filter(r => {
      const today = new Date().toDateString();
      return new Date(r.created_at).toDateString() === today;
    }).length;

    const generationTimes = reports
      .filter(r => r.processing_time_ms)
      .map(r => r.processing_time_ms);
    
    const averageGenerationTime = generationTimes.length > 0
      ? generationTimes.reduce((a, b) => a + b, 0) / generationTimes.length
      : 0;

    const popularFormats: Record<string, number> = {};
    const popularTypes: Record<string, number> = {};

    reports.forEach(r => {
      popularFormats[r.format] = (popularFormats[r.format] || 0) + 1;
      popularTypes[r.type] = (popularTypes[r.type] || 0) + 1;
    });

    // Usage by business
    const businessMap = new Map<string, { name: string; count: number; last: Date }>();
    
    for (const report of reports) {
      const bizId = report.business_id;
      if (!businessMap.has(bizId)) {
        const business = await businessRepository.findById(bizId);
        businessMap.set(bizId, {
          name: business?.name || 'Unknown',
          count: 0,
          last: new Date(0)
        });
      }
      
      const data = businessMap.get(bizId)!;
      data.count++;
      if (new Date(report.created_at) > data.last) {
        data.last = new Date(report.created_at);
      }
    }

    const byBusiness = Array.from(businessMap.entries())
      .map(([id, data]) => ({
        businessId: id,
        businessName: data.name,
        reportCount: data.count,
        lastGenerated: data.last
      }))
      .sort((a, b) => b.reportCount - a.reportCount)
      .slice(0, 10);

    // Usage by day
    const dayMap = new Map<string, number>();
    reports.forEach(r => {
      const date = format(new Date(r.created_at), 'yyyy-MM-dd');
      dayMap.set(date, (dayMap.get(date) || 0) + 1);
    });

    const byDay = Array.from(dayMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Usage by hour
    const hourMap = new Array(24).fill(0);
    reports.forEach(r => {
      const hour = new Date(r.created_at).getHours();
      hourMap[hour]++;
    });

    const byHour = hourMap.map((count, hour) => ({ hour, count }));

    // Performance
    const timeByType: Record<string, number[]> = {};
    reports.forEach(r => {
      if (r.processing_time_ms) {
        if (!timeByType[r.type]) {
          timeByType[r.type] = [];
        }
        timeByType[r.type].push(r.processing_time_ms);
      }
    });

    const averageTimeByType: Record<string, number> = {};
    Object.entries(timeByType).forEach(([type, times]) => {
      averageTimeByType[type] = times.reduce((a, b) => a + b, 0) / times.length;
    });

    const successCount = reports.filter(r => r.status === 'completed').length;
    const failedCount = reports.filter(r => r.status === 'failed').length;

    const successRate = reports.length > 0 ? (successCount / reports.length) * 100 : 0;
    const failureRate = reports.length > 0 ? (failedCount / reports.length) * 100 : 0;

    // Top errors
    const errorMap = new Map<string, number>();
    reports
      .filter(r => r.status === 'failed' && r.error_message)
      .forEach(r => {
        const error = r.error_message.substring(0, 100); // Truncate
        errorMap.set(error, (errorMap.get(error) || 0) + 1);
      });

    const topErrors = Array.from(errorMap.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Trends
    const weeks = this.getWeeklyTrends(reports, days);
    const months = this.getMonthlyTrends(reports, days);

    // Recommendations
    const recommendations = await this.generateRecommendations(
      reports,
      successRate,
      averageGenerationTime
    );

    return {
      summary: {
        totalReports,
        scheduledReports,
        generatedToday,
        averageGenerationTime,
        popularFormats,
        popularTypes
      },
      usage: {
        byBusiness,
        byDay,
        byHour
      },
      performance: {
        averageTimeByType,
        successRate,
        failureRate,
        topErrors
      },
      trends: {
        weekly: weeks,
        monthly: months
      },
      recommendations
    };
  }

  /**
   * Get weekly trends
   */
  private getWeeklyTrends(reports: any[], days: number): Array<{ week: string; count: number; change: number }> {
    const weeks = Math.ceil(days / 7);
    const weekData: Array<{ week: string; count: number }> = [];

    for (let i = 0; i < weeks; i++) {
      const weekEnd = subDays(new Date(), i * 7);
      const weekStart = subDays(weekEnd, 6);
      const count = reports.filter(r => {
        const date = new Date(r.created_at);
        return date >= weekStart && date <= weekEnd;
      }).length;

      weekData.unshift({
        week: format(weekStart, 'MMM d'),
        count
      });
    }

    return weekData.map((item, index, arr) => ({
      ...item,
      change: index > 0 ? item.count - arr[index - 1].count : 0
    }));
  }

  /**
   * Get monthly trends
   */
  private getMonthlyTrends(reports: any[], days: number): Array<{ month: string; count: number; change: number }> {
    const months = Math.ceil(days / 30);
    const monthData: Array<{ month: string; count: number }> = [];

    for (let i = 0; i < months; i++) {
      const monthEnd = subDays(new Date(), i * 30);
      const monthStart = subDays(monthEnd, 29);
      const count = reports.filter(r => {
        const date = new Date(r.created_at);
        return date >= monthStart && date <= monthEnd;
      }).length;

      monthData.unshift({
        month: format(monthStart, 'MMM yyyy'),
        count
      });
    }

    return monthData.map((item, index, arr) => ({
      ...item,
      change: index > 0 ? item.count - arr[index - 1].count : 0
    }));
  }

  /**
   * Generate recommendations
   */
  private async generateRecommendations(
    reports: any[],
    successRate: number,
    avgTime: number
  ): Promise<Array<{ type: 'info' | 'warning' | 'success'; message: string; action?: string }>> {
    const recommendations = [];

    if (successRate < 90) {
      recommendations.push({
        type: 'warning',
        message: `Report success rate is ${successRate.toFixed(1)}%. Review failed reports for common issues.`,
        action: 'View Failed Reports'
      });
    }

    if (avgTime > 60000) { // > 1 minute
      recommendations.push({
        type: 'info',
        message: 'Average report generation time is high. Consider optimizing complex reports.',
        action: 'Optimize Reports'
      });
    }

    const scheduledCount = reports.filter(r => r.is_scheduled).length;
    if (scheduledCount === 0) {
      recommendations.push({
        type: 'info',
        message: 'No scheduled reports configured. Set up automated reports to save time.',
        action: 'Schedule Report'
      });
    }

    const popularTypes = Object.entries(
      reports.reduce((acc, r) => {
        acc[r.type] = (acc[r.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    ).sort((a, b) => b[1] - a[1]);

    if (popularTypes.length > 0) {
      recommendations.push({
        type: 'success',
        message: `Your most used report type is "${popularTypes[0][0]}". Consider creating a template.`,
        action: 'Create Template'
      });
    }

    return recommendations;
  }

  /**
   * Get report performance metrics
   */
  async getPerformanceMetrics(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any> {
    const reports = await reportModel.find({
      business_id: businessId,
      created_at: { $gte: fromDate, $lte: toDate }
    });

    const metrics = {
      total: reports.length,
      byStatus: {
        completed: reports.filter(r => r.status === 'completed').length,
        failed: reports.filter(r => r.status === 'failed').length,
        pending: reports.filter(r => r.status === 'pending').length
      },
      averageTimeByFormat: {} as Record<string, number>,
      errorRate: 0
    };

    // Calculate average time by format
    const timeByFormat: Record<string, number[]> = {};
    reports.forEach(r => {
      if (r.processing_time_ms) {
        if (!timeByFormat[r.format]) {
          timeByFormat[r.format] = [];
        }
        timeByFormat[r.format].push(r.processing_time_ms);
      }
    });

    Object.entries(timeByFormat).forEach(([format, times]) => {
      metrics.averageTimeByFormat[format] = times.reduce((a, b) => a + b, 0) / times.length;
    });

    metrics.errorRate = reports.length > 0 
      ? (metrics.byStatus.failed / reports.length) * 100 
      : 0;

    return metrics;
  }

  /**
   * Track report view
   */
  async trackReportView(reportId: string, userId: string): Promise<void> {
    const key = `report:views:${reportId}`;
    await redis.sadd(key, userId);
    await redis.expire(key, 86400 * 30); // 30 days
  }

  /**
   * Get report views
   */
  async getReportViews(reportId: string): Promise<number> {
    const key = `report:views:${reportId}`;
    return redis.scard(key);
  }

  /**
   * Get popular reports
   */
  async getPopularReports(businessId: string, limit: number = 10): Promise<any[]> {
    // This would need a real analytics database in production
    // Placeholder implementation
    return [];
  }
}

export const reportAnalyticsService = new ReportAnalyticsService();
