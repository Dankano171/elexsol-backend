import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { subDays, differenceInDays } from 'date-fns';

export interface PaymentVelocityMetrics {
  overall: {
    averageDays: number;
    medianDays: number;
    fastestDays: number;
    slowestDays: number;
    totalPayments: number;
    totalValue: number;
  };
  byCustomer: Array<{
    customerId: string;
    customerName: string;
    averageDays: number;
    paymentCount: number;
    totalValue: number;
    trend: 'improving' | 'stable' | 'worsening';
  }>;
  byMonth: Array<{
    month: string;
    averageDays: number;
    paymentCount: number;
    totalValue: number;
  }>;
  insights: {
    fastestPayingCustomers: Array<{ name: string; days: number }>;
    slowestPayingCustomers: Array<{ name: string; days: number }>;
    seasonalPatterns: Array<{ month: string; deviation: number }>;
    recommendations: string[];
  };
}

export class PaymentVelocityService {
  private readonly cacheTTL = 1800; // 30 minutes

  /**
   * Calculate payment velocity metrics
   */
  async calculateMetrics(
    businessId: string,
    days: number = 365
  ): Promise<PaymentVelocityMetrics> {
    try {
      // Try cache first
      const cacheKey = `velocity:${businessId}:${days}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const fromDate = subDays(new Date(), days);
      
      // Get paid invoices
      const invoices = await invoiceRepository.findByDateRange(businessId, fromDate, new Date());
      const paidInvoices = invoices.filter(inv => 
        inv.payment_status === 'paid' && inv.paid_at
      );

      if (paidInvoices.length === 0) {
        return this.getEmptyMetrics();
      }

      // Calculate payment days
      const paymentDays = paidInvoices.map(inv => ({
        invoice: inv,
        days: differenceInDays(inv.paid_at!, inv.issue_date)
      }));

      // Overall metrics
      const overall = this.calculateOverallMetrics(paymentDays);

      // Customer metrics
      const byCustomer = await this.calculateCustomerMetrics(businessId, paymentDays);

      // Monthly trends
      const byMonth = this.calculateMonthlyTrends(paymentDays);

      // Insights
      const insights = this.generateInsights(paymentDays, byCustomer);

      const metrics: PaymentVelocityMetrics = {
        overall,
        byCustomer,
        byMonth,
        insights
      };

      // Cache results
      await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(metrics));

      return metrics;
    } catch (error) {
      logger.error('Error calculating payment velocity:', error);
      throw error;
    }
  }

  /**
   * Calculate overall metrics
   */
  private calculateOverallMetrics(
    paymentDays: Array<{ days: number; invoice: any }>
  ): PaymentVelocityMetrics['overall'] {
    const days = paymentDays.map(p => p.days);
    
    const average = days.reduce((a, b) => a + b, 0) / days.length;
    
    const sorted = [...days].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    
    const totalValue = paymentDays.reduce((sum, p) => sum + p.invoice.total_amount, 0);

    return {
      averageDays: Math.round(average * 10) / 10,
      medianDays: median,
      fastestDays: Math.min(...days),
      slowestDays: Math.max(...days),
      totalPayments: days.length,
      totalValue
    };
  }

  /**
   * Calculate customer metrics
   */
  private async calculateCustomerMetrics(
    businessId: string,
    paymentDays: Array<{ days: number; invoice: any }>
  ): Promise<PaymentVelocityMetrics['byCustomer']> {
    const customerMap = new Map<string, {
      name: string;
      days: number[];
      values: number[];
      dates: Date[];
    }>();

    paymentDays.forEach(p => {
      const tin = p.invoice.customer_tin;
      if (!customerMap.has(tin)) {
        customerMap.set(tin, {
          name: p.invoice.customer_name,
          days: [],
          values: [],
          dates: []
        });
      }
      
      const customer = customerMap.get(tin)!;
      customer.days.push(p.days);
      customer.values.push(p.invoice.total_amount);
      customer.dates.push(p.invoice.paid_at!);
    });

    const result: PaymentVelocityMetrics['byCustomer'] = [];

    for (const [tin, data] of customerMap.entries()) {
      const avgDays = data.days.reduce((a, b) => a + b, 0) / data.days.length;
      const totalValue = data.values.reduce((a, b) => a + b, 0);

      // Calculate trend
      const sortedByDate = data.dates
        .map((date, i) => ({ date, days: data.days[i] }))
        .sort((a, b) => a.date.getTime() - b.date.getTime());

      const recentDays = sortedByDate.slice(-3).map(d => d.days);
      const olderDays = sortedByDate.slice(0, 3).map(d => d.days);

      const recentAvg = recentDays.reduce((a, b) => a + b, 0) / recentDays.length;
      const olderAvg = olderDays.reduce((a, b) => a + b, 0) / olderDays.length;

      let trend: 'improving' | 'stable' | 'worsening' = 'stable';
      if (recentAvg < olderAvg * 0.9) trend = 'improving';
      else if (recentAvg > olderAvg * 1.1) trend = 'worsening';

      result.push({
        customerId: tin,
        customerName: data.name,
        averageDays: Math.round(avgDays * 10) / 10,
        paymentCount: data.days.length,
        totalValue,
        trend
      });
    }

    // Sort by average days
    return result.sort((a, b) => a.averageDays - b.averageDays);
  }

  /**
   * Calculate monthly trends
   */
  private calculateMonthlyTrends(
    paymentDays: Array<{ days: number; invoice: any }>
  ): PaymentVelocityMetrics['byMonth'] {
    const monthMap = new Map<string, { days: number[]; values: number[] }>();

    paymentDays.forEach(p => {
      const month = p.invoice.paid_at!.toISOString().slice(0, 7); // YYYY-MM
      
      if (!monthMap.has(month)) {
        monthMap.set(month, { days: [], values: [] });
      }
      
      const monthData = monthMap.get(month)!;
      monthData.days.push(p.days);
      monthData.values.push(p.invoice.total_amount);
    });

    const result: PaymentVelocityMetrics['byMonth'] = [];

    for (const [month, data] of monthMap.entries()) {
      const avgDays = data.days.reduce((a, b) => a + b, 0) / data.days.length;
      const totalValue = data.values.reduce((a, b) => a + b, 0);

      result.push({
        month,
        averageDays: Math.round(avgDays * 10) / 10,
        paymentCount: data.days.length,
        totalValue
      });
    }

    return result.sort((a, b) => a.month.localeCompare(b.month));
  }

  /**
   * Generate insights and recommendations
   */
  private generateInsights(
    paymentDays: Array<{ days: number; invoice: any }>,
    customerMetrics: PaymentVelocityMetrics['byCustomer']
  ): PaymentVelocityMetrics['insights'] {
    // Fastest paying customers
    const fastest = [...customerMetrics]
      .sort((a, b) => a.averageDays - b.averageDays)
      .slice(0, 5)
      .map(c => ({ name: c.customerName, days: c.averageDays }));

    // Slowest paying customers
    const slowest = [...customerMetrics]
      .sort((a, b) => b.averageDays - a.averageDays)
      .slice(0, 5)
      .map(c => ({ name: c.customerName, days: c.averageDays }));

    // Seasonal patterns
    const seasonalPatterns = this.detectSeasonalPatterns(paymentDays);

    // Generate recommendations
    const recommendations: string[] = [];

    const overallAvg = paymentDays.reduce((a, b) => a + b.days, 0) / paymentDays.length;

    if (overallAvg > 45) {
      recommendations.push('Your payment velocity is slower than average. Consider offering early payment discounts.');
    } else if (overallAvg > 30) {
      recommendations.push('Payment velocity is acceptable but could be improved with automated reminders.');
    } else if (overallAvg < 15) {
      recommendations.push('Excellent payment velocity! Consider asking satisfied customers for referrals.');
    }

    if (slowest.length > 0) {
      recommendations.push(`Follow up with ${slowest[0].name} who takes an average of ${slowest[0].days} days to pay.`);
    }

    if (seasonalPatterns.some(p => Math.abs(p.deviation) > 20)) {
      recommendations.push('Consider adjusting credit terms during historically slow payment months.');
    }

    return {
      fastestPayingCustomers: fastest,
      slowestPayingCustomers: slowest,
      seasonalPatterns,
      recommendations
    };
  }

  /**
   * Detect seasonal payment patterns
   */
  private detectSeasonalPatterns(
    paymentDays: Array<{ days: number; invoice: any }>
  ): Array<{ month: string; deviation: number }> {
    const monthAvgs = new Map<string, number[]>();
    
    paymentDays.forEach(p => {
      const month = p.invoice.paid_at!.toLocaleString('default', { month: 'short' });
      if (!monthAvgs.has(month)) {
        monthAvgs.set(month, []);
      }
      monthAvgs.get(month)!.push(p.days);
    });

    const overallAvg = paymentDays.reduce((a, b) => a + b.days, 0) / paymentDays.length;
    const patterns: Array<{ month: string; deviation: number }> = [];

    for (const [month, days] of monthAvgs.entries()) {
      const monthAvg = days.reduce((a, b) => a + b, 0) / days.length;
      const deviation = ((monthAvg - overallAvg) / overallAvg) * 100;
      
      patterns.push({
        month,
        deviation: Math.round(deviation * 10) / 10
      });
    }

    return patterns.sort((a, b) => new Date(`2000-${a.month}-01`).getMonth() - 
                                 new Date(`2000-${b.month}-01`).getMonth());
  }

  /**
   * Get empty metrics (no data)
   */
  private getEmptyMetrics(): PaymentVelocityMetrics {
    return {
      overall: {
        averageDays: 0,
        medianDays: 0,
        fastestDays: 0,
        slowestDays: 0,
        totalPayments: 0,
        totalValue: 0
      },
      byCustomer: [],
      byMonth: [],
      insights: {
        fastestPayingCustomers: [],
        slowestPayingCustomers: [],
        seasonalPatterns: [],
        recommendations: ['Start accepting payments to see payment velocity metrics.']
      }
    };
  }

  /**
   * Get payment velocity forecast
   */
  async getForecast(businessId: string, months: number = 3): Promise<any> {
    const metrics = await this.calculateMetrics(businessId);
    
    if (metrics.byMonth.length === 0) {
      return { forecast: [], confidence: 0 };
    }

    // Simple linear regression for forecasting
    const monthsData = metrics.byMonth.map((m, i) => ({
      x: i,
      y: m.averageDays
    }));

    const n = monthsData.length;
    const sumX = monthsData.reduce((s, m) => s + m.x, 0);
    const sumY = monthsData.reduce((s, m) => s + m.y, 0);
    const sumXY = monthsData.reduce((s, m) => s + (m.x * m.y), 0);
    const sumXX = monthsData.reduce((s, m) => s + (m.x * m.x), 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    const forecast = [];
    const lastX = monthsData[monthsData.length - 1].x;

    for (let i = 1; i <= months; i++) {
      const x = lastX + i;
      const y = intercept + slope * x;
      
      forecast.push({
        month: new Date(Date.now() + i * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 7),
        predictedDays: Math.max(0, Math.round(y * 10) / 10)
      });
    }

    // Calculate confidence (based on R-squared)
    const yMean = sumY / n;
    const ssRes = monthsData.reduce((s, m) => s + Math.pow(m.y - (intercept + slope * m.x), 2), 0);
    const ssTot = monthsData.reduce((s, m) => s + Math.pow(m.y - yMean, 2), 0);
    const rSquared = 1 - (ssRes / ssTot);

    return {
      forecast,
      confidence: Math.round(rSquared * 100)
    };
  }
}

export const paymentVelocityService = new PaymentVelocityService();
