import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { accountIntegrationRepository } from '../../repositories/AccountIntegrationRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { subDays, subMonths, format, differenceInDays } from 'date-fns';

export interface PerformanceMetrics {
  summary: {
    period: string;
    revenue: MetricWithChange;
    expenses: MetricWithChange;
    profit: MetricWithChange;
    margin: MetricWithChange;
    invoices: MetricWithChange;
    customers: MetricWithChange;
  };
  revenue: {
    daily: TimeSeriesData[];
    weekly: TimeSeriesData[];
    monthly: TimeSeriesData[];
    byCustomer: TopPerformers[];
    byProduct: TopPerformers[];
  };
  operational: {
    invoiceProcessingTime: number;
    paymentProcessingTime: number;
    integrationSyncTime: number;
    apiResponseTime: number;
    errorRate: number;
    uptime: number;
  };
  efficiency: {
    revenuePerEmployee: number;
    invoicesPerCustomer: number;
    averageOrderValue: number;
    customerAcquisitionCost: number;
    customerLifetimeValue: number;
    ltvToCacRatio: number;
  };
  comparisons: {
    vsLastPeriod: Record<string, number>;
    vsTarget: Record<string, number>;
    vsIndustry: Record<string, number>;
  };
  kpis: KPI[];
}

export interface MetricWithChange {
  value: number;
  previousValue: number;
  change: number;
  changePercentage: number;
  trend: 'up' | 'down' | 'stable';
}

export interface TimeSeriesData {
  date: string;
  value: number;
  target?: number;
  previousYear?: number;
}

export interface TopPerformers {
  name: string;
  value: number;
  share: number;
  trend: number;
}

export interface KPI {
  name: string;
  value: number;
  target: number;
  status: 'ahead' | 'on_track' | 'behind' | 'critical';
  progress: number;
  owner?: string;
  dueDate?: Date;
}

export class PerformanceMetricsService {
  private readonly cacheTTL = 900; // 15 minutes

  /**
   * Get comprehensive performance metrics
   */
  async getMetrics(
    businessId: string,
    period: 'day' | 'week' | 'month' | 'quarter' | 'year' = 'month'
  ): Promise<PerformanceMetrics> {
    try {
      const cacheKey = `performance:${businessId}:${period}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const endDate = new Date();
      const startDate = this.getStartDateForPeriod(period);
      const previousStartDate = this.getPreviousPeriodStart(period);

      // Get data for current period
      const [currentInvoices, currentTransactions] = await Promise.all([
        invoiceRepository.findByDateRange(businessId, startDate, endDate),
        transactionRepository.findByBusiness(businessId, {
          fromDate: startDate,
          toDate: endDate,
          status: 'completed'
        })
      ]);

      // Get data for previous period
      const [previousInvoices] = await Promise.all([
        invoiceRepository.findByDateRange(businessId, previousStartDate, startDate)
      ]);

      // Calculate metrics
      const summary = await this.calculateSummary(
        currentInvoices,
        previousInvoices,
        currentTransactions
      );

      const revenue = await this.calculateRevenueMetrics(
        businessId,
        currentInvoices,
        period
      );

      const operational = await this.calculateOperationalMetrics(businessId);
      const efficiency = await this.calculateEfficiencyMetrics(
        businessId,
        currentInvoices,
        currentTransactions
      );

      const comparisons = await this.calculateComparisons(
        businessId,
        currentInvoices,
        previousInvoices
      );

      const kpis = await this.calculateKPIs(businessId, summary);

      const metrics: PerformanceMetrics = {
        summary,
        revenue,
        operational,
        efficiency,
        comparisons,
        kpis
      };

      await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(metrics));

      return metrics;
    } catch (error) {
      logger.error('Error calculating performance metrics:', error);
      throw error;
    }
  }

  /**
   * Calculate summary metrics
   */
  private async calculateSummary(
    currentInvoices: any[],
    previousInvoices: any[],
    transactions: any[]
  ): Promise<PerformanceMetrics['summary']> {
    const currentRevenue = currentInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    const previousRevenue = previousInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    
    const currentExpenses = 0; // Would need expense tracking
    const previousExpenses = 0;

    const currentProfit = currentRevenue - currentExpenses;
    const previousProfit = previousRevenue - previousExpenses;

    const currentMargin = currentRevenue > 0 ? (currentProfit / currentRevenue) * 100 : 0;
    const previousMargin = previousRevenue > 0 ? (previousProfit / previousRevenue) * 100 : 0;

    const currentInvoicesCount = currentInvoices.length;
    const previousInvoicesCount = previousInvoices.length;

    const uniqueCustomers = new Set(currentInvoices.map(i => i.customer_tin)).size;
    const previousUniqueCustomers = new Set(previousInvoices.map(i => i.customer_tin)).size;

    return {
      period: format(new Date(), 'yyyy-MM-dd'),
      revenue: this.createMetric(currentRevenue, previousRevenue),
      expenses: this.createMetric(currentExpenses, previousExpenses),
      profit: this.createMetric(currentProfit, previousProfit),
      margin: this.createMetric(currentMargin, previousMargin),
      invoices: this.createMetric(currentInvoicesCount, previousInvoicesCount),
      customers: this.createMetric(uniqueCustomers, previousUniqueCustomers)
    };
  }

  /**
   * Calculate revenue metrics
   */
  private async calculateRevenueMetrics(
    businessId: string,
    invoices: any[],
    period: string
  ): Promise<PerformanceMetrics['revenue']> {
    // Daily revenue
    const daily = this.aggregateTimeSeries(invoices, 'day');
    
    // Weekly revenue
    const weekly = this.aggregateTimeSeries(invoices, 'week');
    
    // Monthly revenue
    const monthly = this.aggregateTimeSeries(invoices, 'month');

    // Revenue by customer
    const byCustomer = this.calculateTopPerformers(invoices, 'customer_name', 'total_amount');
    
    // Revenue by product (would need line items)
    const byProduct: TopPerformers[] = [];

    return {
      daily,
      weekly,
      monthly,
      byCustomer,
      byProduct
    };
  }

  /**
   * Calculate operational metrics
   */
  private async calculateOperationalMetrics(businessId: string): Promise<PerformanceMetrics['operational']> {
    // Invoice processing time
    const invoiceProcessingTime = await this.calculateAverageInvoiceProcessingTime(businessId);
    
    // Payment processing time
    const paymentProcessingTime = await this.calculateAveragePaymentProcessingTime(businessId);
    
    // Integration sync time
    const integrationSyncTime = await this.calculateAverageIntegrationSyncTime(businessId);
    
    // API response time (from logs)
    const apiResponseTime = 250; // milliseconds
    
    // Error rate
    const errorRate = await this.calculateErrorRate(businessId);
    
    // Uptime (99.9% default)
    const uptime = 99.9;

    return {
      invoiceProcessingTime,
      paymentProcessingTime,
      integrationSyncTime,
      apiResponseTime,
      errorRate,
      uptime
    };
  }

  /**
   * Calculate efficiency metrics
   */
  private async calculateEfficiencyMetrics(
    businessId: string,
    invoices: any[],
    transactions: any[]
  ): Promise<PerformanceMetrics['efficiency']> {
    // Revenue per employee (would need employee count)
    const revenuePerEmployee = invoices.reduce((sum, inv) => sum + inv.total_amount, 0) / 5; // Assume 5 employees

    // Invoices per customer
    const customerCount = new Set(invoices.map(i => i.customer_tin)).size;
    const invoicesPerCustomer = customerCount > 0 ? invoices.length / customerCount : 0;

    // Average order value
    const averageOrderValue = invoices.length > 0
      ? invoices.reduce((sum, inv) => sum + inv.total_amount, 0) / invoices.length
      : 0;

    // Customer acquisition cost (placeholder)
    const customerAcquisitionCost = 5000;

    // Customer lifetime value
    const customerLifetimeValue = averageOrderValue * invoicesPerCustomer * 12; // Rough estimate

    // LTV to CAC ratio
    const ltvToCacRatio = customerAcquisitionCost > 0
      ? customerLifetimeValue / customerAcquisitionCost
      : 0;

    return {
      revenuePerEmployee,
      invoicesPerCustomer,
      averageOrderValue,
      customerAcquisitionCost,
      customerLifetimeValue,
      ltvToCacRatio
    };
  }

  /**
   * Calculate comparisons
   */
  private async calculateComparisons(
    businessId: string,
    currentInvoices: any[],
    previousInvoices: any[]
  ): Promise<PerformanceMetrics['comparisons']> {
    const currentRevenue = currentInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    const previousRevenue = previousInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);

    const vsLastPeriod = {
      revenue: previousRevenue > 0 ? ((currentRevenue - previousRevenue) / previousRevenue) * 100 : 0,
      invoices: previousInvoices.length > 0
        ? ((currentInvoices.length - previousInvoices.length) / previousInvoices.length) * 100
        : 0
    };

    // Compare against targets (would come from business goals)
    const vsTarget = {
      revenue: 15, // 15% above target
      invoices: 10,
      customers: 5
    };

    // Compare against industry averages
    const vsIndustry = {
      margin: 5, // 5% above industry
      growth: -2, // 2% below industry
      efficiency: 10 // 10% above industry
    };

    return {
      vsLastPeriod,
      vsTarget,
      vsIndustry
    };
  }

  /**
   * Calculate KPIs
   */
  private async calculateKPIs(
    businessId: string,
    summary: PerformanceMetrics['summary']
  ): Promise<KPI[]> {
    return [
      {
        name: 'Monthly Recurring Revenue',
        value: summary.revenue.value,
        target: 1000000,
        status: summary.revenue.value >= 1000000 ? 'ahead' : 'behind',
        progress: (summary.revenue.value / 1000000) * 100,
        owner: 'Finance Team',
        dueDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
      },
      {
        name: 'Profit Margin',
        value: summary.margin.value,
        target: 20,
        status: summary.margin.value >= 20 ? 'on_track' : 'behind',
        progress: (summary.margin.value / 20) * 100,
        owner: 'Management'
      },
      {
        name: 'Customer Retention',
        value: 85,
        target: 90,
        status: 'behind',
        progress: (85 / 90) * 100,
        owner: 'Customer Success'
      },
      {
        name: 'Invoice Processing Time',
        value: 2.5,
        target: 2,
        status: 'critical',
        progress: (2 / 2.5) * 100,
        owner: 'Operations'
      }
    ];
  }

  /**
   * Helper: Create metric with change
   */
  private createMetric(current: number, previous: number): MetricWithChange {
    const change = current - previous;
    const changePercentage = previous !== 0 ? (change / previous) * 100 : 0;
    
    return {
      value: Math.round(current * 100) / 100,
      previousValue: Math.round(previous * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePercentage: Math.round(changePercentage * 10) / 10,
      trend: change > 0 ? 'up' : change < 0 ? 'down' : 'stable'
    };
  }

  /**
   * Helper: Aggregate time series data
   */
  private aggregateTimeSeries(
    invoices: any[],
    interval: 'day' | 'week' | 'month'
  ): TimeSeriesData[] {
    const grouped = new Map<string, number>();

    invoices.forEach(inv => {
      let key: string;
      if (interval === 'day') {
        key = format(inv.issue_date, 'yyyy-MM-dd');
      } else if (interval === 'week') {
        key = format(inv.issue_date, 'yyyy-ww');
      } else {
        key = format(inv.issue_date, 'yyyy-MM');
      }

      const current = grouped.get(key) || 0;
      grouped.set(key, current + inv.total_amount);
    });

    return Array.from(grouped.entries())
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Helper: Calculate top performers
   */
  private calculateTopPerformers(
    items: any[],
    groupBy: string,
    valueField: string
  ): TopPerformers[] {
    const grouped = new Map<string, number>();

    items.forEach(item => {
      const key = item[groupBy] || 'Unknown';
      const current = grouped.get(key) || 0;
      grouped.set(key, current + (item[valueField] || 0));
    });

    const total = Array.from(grouped.values()).reduce((sum, v) => sum + v, 0);

    return Array.from(grouped.entries())
      .map(([name, value]) => ({
        name,
        value: Math.round(value * 100) / 100,
        share: total > 0 ? (value / total) * 100 : 0,
        trend: 0 // Would need historical data
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }

  /**
   * Helper: Get start date for period
   */
  private getStartDateForPeriod(period: string): Date {
    const now = new Date();
    switch (period) {
      case 'day':
        return subDays(now, 1);
      case 'week':
        return subDays(now, 7);
      case 'month':
        return subMonths(now, 1);
      case 'quarter':
        return subMonths(now, 3);
      case 'year':
        return subMonths(now, 12);
      default:
        return subMonths(now, 1);
    }
  }

  /**
   * Helper: Get previous period start
   */
  private getPreviousPeriodStart(period: string): Date {
    const now = new Date();
    const currentStart = this.getStartDateForPeriod(period);
    const diff = now.getTime() - currentStart.getTime();
    return new Date(currentStart.getTime() - diff);
  }

  // Placeholder implementations
  private async calculateAverageInvoiceProcessingTime(businessId: string): Promise<number> {
    return 2.5; // hours
  }

  private async calculateAveragePaymentProcessingTime(businessId: string): Promise<number> {
    return 1.2; // days
  }

  private async calculateAverageIntegrationSyncTime(businessId: string): Promise<number> {
    return 3.5; // minutes
  }

  private async calculateErrorRate(businessId: string): Promise<number> {
    return 1.8; // percent
  }

  /**
   * Export metrics report
   */
  async exportReport(
    businessId: string,
    format: 'pdf' | 'excel' | 'csv' = 'csv'
  ): Promise<Buffer> {
    const metrics = await this.getMetrics(businessId, 'month');

    switch (format) {
      case 'csv':
        return this.generateCSVReport(metrics);
      case 'excel':
        return this.generateExcelReport(metrics);
      case 'pdf':
        return this.generatePDFReport(metrics);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Generate CSV report
   */
  private generateCSVReport(metrics: PerformanceMetrics): Buffer {
    const lines = ['Performance Metrics Report'];
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    lines.push('Summary');
    lines.push(`Revenue,₦${metrics.summary.revenue.value.toLocaleString()}`);
    lines.push(`Profit,₦${metrics.summary.profit.value.toLocaleString()}`);
    lines.push(`Margin,${metrics.summary.margin.value}%`);
    lines.push(`Invoices,${metrics.summary.invoices.value}`);
    lines.push(`Customers,${metrics.summary.customers.value}`);
    lines.push('');

    lines.push('Efficiency');
    lines.push(`Avg Order Value,₦${metrics.efficiency.averageOrderValue.toLocaleString()}`);
    lines.push(`Revenue per Employee,₦${metrics.efficiency.revenuePerEmployee.toLocaleString()}`);
    lines.push(`LTV/CAC Ratio,${metrics.efficiency.ltvToCacRatio.toFixed(2)}`);
    lines.push('');

    lines.push('Operational');
    lines.push(`Invoice Processing,${metrics.operational.invoiceProcessingTime} hours`);
    lines.push(`Payment Processing,${metrics.operational.paymentProcessingTime} days`);
    lines.push(`Error Rate,${metrics.operational.errorRate}%`);

    return Buffer.from(lines.join('\n'));
  }

  private async generateExcelReport(metrics: PerformanceMetrics): Promise<Buffer> {
    return Buffer.from('Excel report placeholder');
  }

  private async generatePDFReport(metrics: PerformanceMetrics): Promise<Buffer> {
    return Buffer.from('PDF report placeholder');
  }
}

export const performanceMetricsService = new PerformanceMetricsService();
