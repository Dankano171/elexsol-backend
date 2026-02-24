import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { businessRepository } from '../../repositories/BusinessRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { startOfDay, endOfDay, subDays, subMonths, format } from 'date-fns';

export interface BusinessMetrics {
  revenue: {
    total: number;
    monthly: number;
    weekly: number;
    daily: number;
    growth: number;
  };
  invoices: {
    total: number;
    paid: number;
    overdue: number;
    draft: number;
    averageValue: number;
  };
  customers: {
    total: number;
    active: number;
    new: number;
    repeatRate: number;
  };
  payments: {
    totalCollected: number;
    outstanding: number;
    averageDaysToPay: number;
    paymentMethods: Record<string, number>;
  };
  cashflow: {
    projected: number;
    actual: number;
    trend: 'up' | 'down' | 'stable';
    forecast: Array<{ date: string; amount: number }>;
  };
}

export interface CustomerInsights {
  id: string;
  name: string;
  email?: string;
  totalSpent: number;
  averageOrderValue: number;
  orderCount: number;
  firstPurchase: Date;
  lastPurchase: Date;
  daysSinceLastPurchase: number;
  paymentReliability: 'excellent' | 'good' | 'average' | 'poor';
  lifetimeValue: number;
  predictedLTV: number;
}

export class AnalyticsService {
  private readonly cacheTTL = 3600; // 1 hour

  /**
   * Get business metrics dashboard
   */
  async getBusinessMetrics(businessId: string): Promise<BusinessMetrics> {
    try {
      // Try cache first
      const cached = await redis.get(`metrics:${businessId}`);
      if (cached) {
        return JSON.parse(cached);
      }

      const now = new Date();
      const thirtyDaysAgo = subDays(now, 30);
      const ninetyDaysAgo = subDays(now, 90);

      // Run parallel queries
      const [
        revenueStats,
        invoiceStats,
        customerStats,
        paymentStats,
        cashflowStats
      ] = await Promise.all([
        this.calculateRevenueStats(businessId, thirtyDaysAgo, now),
        this.calculateInvoiceStats(businessId),
        this.calculateCustomerStats(businessId, thirtyDaysAgo),
        this.calculatePaymentStats(businessId, thirtyDaysAgo),
        this.calculateCashflow(businessId, ninetyDaysAgo, now)
      ]);

      const metrics: BusinessMetrics = {
        revenue: revenueStats,
        invoices: invoiceStats,
        customers: customerStats,
        payments: paymentStats,
        cashflow: cashflowStats
      };

      // Cache for 1 hour
      await redis.setex(`metrics:${businessId}`, this.cacheTTL, JSON.stringify(metrics));

      return metrics;
    } catch (error) {
      logger.error('Error calculating business metrics:', error);
      throw error;
    }
  }

  /**
   * Calculate revenue statistics
   */
  private async calculateRevenueStats(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<BusinessMetrics['revenue']> {
    const invoices = await invoiceRepository.findByDateRange(businessId, fromDate, toDate);
    
    const total = invoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    const paid = invoices
      .filter(inv => inv.payment_status === 'paid')
      .reduce((sum, inv) => sum + inv.total_amount, 0);

    // Calculate growth vs previous period
    const previousPeriod = subDays(fromDate, 30);
    const previousInvoices = await invoiceRepository.findByDateRange(
      businessId,
      previousPeriod,
      fromDate
    );
    const previousTotal = previousInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    
    const growth = previousTotal > 0 
      ? ((total - previousTotal) / previousTotal) * 100 
      : 0;

    // Daily and weekly averages
    const days = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));
    const daily = total / days;
    const weekly = daily * 7;
    const monthly = total;

    return {
      total,
      monthly,
      weekly,
      daily,
      growth
    };
  }

  /**
   * Calculate invoice statistics
   */
  private async calculateInvoiceStats(businessId: string): Promise<BusinessMetrics['invoices']> {
    const stats = await invoiceRepository.getStatistics(businessId);
    
    return {
      total: parseInt(stats.total_invoices) || 0,
      paid: parseInt(stats.paid_invoices) || 0,
      overdue: parseInt(stats.overdue_invoices) || 0,
      draft: parseInt(stats.draft_invoices) || 0,
      averageValue: parseFloat(stats.average_value) || 0
    };
  }

  /**
   * Calculate customer statistics
   */
  private async calculateCustomerStats(
    businessId: string,
    sinceDate: Date
  ): Promise<BusinessMetrics['customers']> {
    // Get unique customers from invoices
    const invoices = await invoiceRepository.findByBusiness(businessId, {
      fromDate: sinceDate
    });

    const customers = new Set();
    const activeCustomers = new Set();
    
    invoices.forEach(inv => {
      customers.add(inv.customer_tin);
      if (inv.payment_status === 'paid') {
        activeCustomers.add(inv.customer_tin);
      }
    });

    // Calculate repeat rate
    const customerInvoiceCounts = new Map();
    invoices.forEach(inv => {
      const count = customerInvoiceCounts.get(inv.customer_tin) || 0;
      customerInvoiceCounts.set(inv.customer_tin, count + 1);
    });

    const repeatCustomers = Array.from(customerInvoiceCounts.values())
      .filter(count => count > 1).length;
    
    const repeatRate = customers.size > 0 
      ? (repeatCustomers / customers.size) * 100 
      : 0;

    return {
      total: customers.size,
      active: activeCustomers.size,
      new: customers.size - activeCustomers.size,
      repeatRate
    };
  }

  /**
   * Calculate payment statistics
   */
  private async calculatePaymentStats(
    businessId: string,
    fromDate: Date
  ): Promise<BusinessMetrics['payments']> {
    const transactions = await transactionRepository.findByBusiness(businessId, {
      fromDate,
      status: 'completed'
    });

    const totalCollected = transactions.reduce((sum, t) => sum + t.amount, 0);
    
    // Payment methods breakdown
    const paymentMethods: Record<string, number> = {};
    transactions.forEach(t => {
      paymentMethods[t.payment_method] = (paymentMethods[t.payment_method] || 0) + t.amount;
    });

    // Calculate average days to pay
    const invoices = await invoiceRepository.findByBusiness(businessId, {
      fromDate,
      payment_status: 'paid'
    });

    let totalDays = 0;
    let paidCount = 0;

    invoices.forEach(inv => {
      if (inv.paid_at) {
        const days = Math.ceil(
          (inv.paid_at.getTime() - inv.issue_date.getTime()) / (1000 * 60 * 60 * 24)
        );
        totalDays += days;
        paidCount++;
      }
    });

    const averageDaysToPay = paidCount > 0 ? totalDays / paidCount : 0;

    // Get outstanding balance
    const outstanding = await this.calculateOutstandingBalance(businessId);

    return {
      totalCollected,
      outstanding,
      averageDaysToPay,
      paymentMethods
    };
  }

  /**
   * Calculate cashflow metrics
   */
  private async calculateCashflow(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<BusinessMetrics['cashflow']> {
    const invoices = await invoiceRepository.findByDateRange(businessId, fromDate, toDate);
    
    // Group by month
    const monthlyData: Record<string, { actual: number; projected: number }> = {};
    
    invoices.forEach(inv => {
      const month = format(inv.issue_date, 'yyyy-MM');
      
      if (!monthlyData[month]) {
        monthlyData[month] = { actual: 0, projected: 0 };
      }
      
      monthlyData[month].projected += inv.total_amount;
      
      if (inv.payment_status === 'paid' && inv.paid_at) {
        const paidMonth = format(inv.paid_at, 'yyyy-MM');
        if (!monthlyData[paidMonth]) {
          monthlyData[paidMonth] = { actual: 0, projected: 0 };
        }
        monthlyData[paidMonth].actual += inv.amount_paid;
      }
    });

    // Calculate trend
    const months = Object.keys(monthlyData).sort();
    const recentMonths = months.slice(-3);
    
    let trend: 'up' | 'down' | 'stable' = 'stable';
    
    if (recentMonths.length >= 3) {
      const values = recentMonths.map(m => monthlyData[m].actual);
      const firstAvg = (values[0] + values[1]) / 2;
      const lastAvg = (values[1] + values[2]) / 2;
      
      if (lastAvg > firstAvg * 1.1) {
        trend = 'up';
      } else if (lastAvg < firstAvg * 0.9) {
        trend = 'down';
      }
    }

    // Generate forecast
    const forecast = await this.generateCashflowForecast(businessId);

    return {
      projected: Object.values(monthlyData).reduce((sum, m) => sum + m.projected, 0),
      actual: Object.values(monthlyData).reduce((sum, m) => sum + m.actual, 0),
      trend,
      forecast
    };
  }

  /**
   * Calculate outstanding balance
   */
  private async calculateOutstandingBalance(businessId: string): Promise<number> {
    const invoices = await invoiceRepository.findByStatus(businessId, 'sent');
    return invoices.reduce((sum, inv) => sum + inv.balance_due, 0);
  }

  /**
   * Generate cashflow forecast
   */
  private async generateCashflowForecast(
    businessId: string,
    months: number = 3
  ): Promise<Array<{ date: string; amount: number }>> {
    const forecast: Array<{ date: string; amount: number }> = [];
    
    // Get historical data for trend analysis
    const ninetyDaysAgo = subDays(new Date(), 90);
    const invoices = await invoiceRepository.findByDateRange(
      businessId,
      ninetyDaysAgo,
      new Date()
    );

    if (invoices.length === 0) {
      return forecast;
    }

    // Calculate average monthly revenue
    const monthlyRevenue = new Map<string, number>();
    invoices.forEach(inv => {
      const month = format(inv.issue_date, 'yyyy-MM');
      monthlyRevenue.set(month, (monthlyRevenue.get(month) || 0) + inv.total_amount);
    });

    const avgMonthlyRevenue = Array.from(monthlyRevenue.values()).reduce((a, b) => a + b, 0) / 
      monthlyRevenue.size;

    // Calculate seasonal factors (simplified)
    const seasonalFactor = 1.0; // Would need more data for real seasonality

    // Generate forecast
    const startDate = new Date();
    for (let i = 1; i <= months; i++) {
      const forecastDate = new Date(startDate);
      forecastDate.setMonth(forecastDate.getMonth() + i);
      
      // Simple linear projection with seasonal adjustment
      const amount = avgMonthlyRevenue * seasonalFactor * (1 + (i * 0.02)); // Assume 2% growth
      
      forecast.push({
        date: format(forecastDate, 'yyyy-MM'),
        amount: Math.round(amount * 100) / 100
      });
    }

    return forecast;
  }

  /**
   * Get customer insights
   */
  async getCustomerInsights(
    businessId: string,
    customerTin: string
  ): Promise<CustomerInsights | null> {
    const invoices = await invoiceRepository.findByCustomer(customerTin, businessId);
    
    if (invoices.length === 0) {
      return null;
    }

    const firstInvoice = invoices.reduce((earliest, inv) => 
      inv.issue_date < earliest.issue_date ? inv : earliest
    );
    
    const lastInvoice = invoices.reduce((latest, inv) => 
      inv.issue_date > latest.issue_date ? inv : latest
    );

    const totalSpent = invoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    const averageOrderValue = totalSpent / invoices.length;

    // Calculate payment reliability
    const paidInvoices = invoices.filter(inv => inv.payment_status === 'paid');
    const onTimePayments = paidInvoices.filter(inv => 
      inv.paid_at && inv.paid_at <= inv.due_date
    ).length;

    const reliability = paidInvoices.length > 0
      ? (onTimePayments / paidInvoices.length)
      : 0;

    let paymentReliability: CustomerInsights['paymentReliability'];
    if (reliability >= 0.9) paymentReliability = 'excellent';
    else if (reliability >= 0.7) paymentReliability = 'good';
    else if (reliability >= 0.5) paymentReliability = 'average';
    else paymentReliability = 'poor';

    // Calculate LTV
    const lifetimeValue = totalSpent;
    
    // Predict LTV based on average spend and frequency
    const monthsActive = Math.max(1, Math.ceil(
      (lastInvoice.issue_date.getTime() - firstInvoice.issue_date.getTime()) / 
      (1000 * 60 * 60 * 24 * 30)
    ));
    
    const monthlyAverage = totalSpent / monthsActive;
    const predictedLTV = monthlyAverage * 24; // Predict 2 years

    return {
      id: customerTin,
      name: lastInvoice.customer_name,
      email: lastInvoice.customer_email,
      totalSpent,
      averageOrderValue,
      orderCount: invoices.length,
      firstPurchase: firstInvoice.issue_date,
      lastPurchase: lastInvoice.issue_date,
      daysSinceLastPurchase: Math.ceil(
        (new Date().getTime() - lastInvoice.issue_date.getTime()) / 
        (1000 * 60 * 60 * 24)
      ),
      paymentReliability,
      lifetimeValue,
      predictedLTV
    };
  }

  /**
   * Get revenue by customer
   */
  async getRevenueByCustomer(
    businessId: string,
    limit: number = 10
  ): Promise<Array<{ customer: string; revenue: number; count: number }>> {
    const customers = await invoiceRepository.getCustomerSummary(businessId, limit);
    
    return customers.map(c => ({
      customer: c.customer_name,
      revenue: parseFloat(c.total_billed) || 0,
      count: parseInt(c.invoice_count) || 0
    }));
  }

  /**
   * Get payment velocity
   */
  async getPaymentVelocity(
    businessId: string,
    days: number = 90
  ): Promise<{
    average: number;
    median: number;
    byCustomer: Array<{ customer: string; days: number }>;
  }> {
    const fromDate = subDays(new Date(), days);
    const invoices = await invoiceRepository.findByDateRange(businessId, fromDate, new Date());
    
    const paidInvoices = invoices.filter(inv => 
      inv.payment_status === 'paid' && inv.paid_at
    );

    const paymentDays = paidInvoices.map(inv => 
      Math.ceil((inv.paid_at!.getTime() - inv.issue_date.getTime()) / (1000 * 60 * 60 * 24))
    );

    const average = paymentDays.length > 0
      ? paymentDays.reduce((a, b) => a + b, 0) / paymentDays.length
      : 0;

    // Calculate median
    const sorted = [...paymentDays].sort((a, b) => a - b);
    const median = sorted.length > 0
      ? sorted[Math.floor(sorted.length / 2)]
      : 0;

    // Group by customer
    const customerMap = new Map<string, { name: string; days: number[] }>();
    
    paidInvoices.forEach(inv => {
      const days = Math.ceil((inv.paid_at!.getTime() - inv.issue_date.getTime()) / (1000 * 60 * 60 * 24));
      
      if (!customerMap.has(inv.customer_tin)) {
        customerMap.set(inv.customer_tin, { name: inv.customer_name, days: [] });
      }
      
      customerMap.get(inv.customer_tin)!.days.push(days);
    });

    const byCustomer = Array.from(customerMap.entries()).map(([tin, data]) => ({
      customer: data.name,
      days: data.days.reduce((a, b) => a + b, 0) / data.days.length
    }));

    return { average, median, byCustomer };
  }

  /**
   * Get business health score
   */
  async getHealthScore(businessId: string): Promise<{
    score: number;
    factors: Array<{ name: string; score: number; impact: 'positive' | 'negative' }>;
  }> {
    const metrics = await this.getBusinessMetrics(businessId);
    
    const factors = [];
    let totalScore = 0;

    // Payment velocity factor
    const paymentVelocity = metrics.payments.averageDaysToPay;
    let velocityScore = 100;
    if (paymentVelocity > 45) velocityScore = 40;
    else if (paymentVelocity > 30) velocityScore = 60;
    else if (paymentVelocity > 15) velocityScore = 80;
    
    factors.push({
      name: 'Payment Speed',
      score: velocityScore,
      impact: velocityScore >= 60 ? 'positive' : 'negative'
    });
    totalScore += velocityScore;

    // Revenue growth factor
    const growthScore = Math.min(100, Math.max(0, 50 + metrics.revenue.growth));
    factors.push({
      name: 'Revenue Growth',
      score: growthScore,
      impact: growthScore >= 60 ? 'positive' : 'negative'
    });
    totalScore += growthScore;

    // Customer retention factor
    const retentionScore = metrics.customers.repeatRate;
    factors.push({
      name: 'Customer Retention',
      score: retentionScore,
      impact: retentionScore >= 50 ? 'positive' : 'negative'
    });
    totalScore += retentionScore;

    // Outstanding balance factor
    const outstandingRatio = metrics.payments.outstanding / metrics.revenue.total;
    let outstandingScore = 100;
    if (outstandingRatio > 0.5) outstandingScore = 40;
    else if (outstandingRatio > 0.3) outstandingScore = 60;
    else if (outstandingRatio > 0.1) outstandingScore = 80;
    
    factors.push({
      name: 'Outstanding Balance',
      score: outstandingScore,
      impact: outstandingScore >= 60 ? 'positive' : 'negative'
    });
    totalScore += outstandingScore;

    // Cashflow trend factor
    let cashflowScore = 70;
    if (metrics.cashflow.trend === 'up') cashflowScore = 90;
    else if (metrics.cashflow.trend === 'down') cashflowScore = 50;
    
    factors.push({
      name: 'Cashflow Trend',
      score: cashflowScore,
      impact: cashflowScore >= 70 ? 'positive' : 'negative'
    });
    totalScore += cashflowScore;

    const finalScore = Math.round(totalScore / factors.length);

    return {
      score: finalScore,
      factors
    };
  }

  /**
   * Export analytics report
   */
  async exportReport(
    businessId: string,
    fromDate: Date,
    toDate: Date,
    format: 'pdf' | 'excel' | 'csv' = 'csv'
  ): Promise<Buffer> {
    const metrics = await this.getBusinessMetrics(businessId);
    const invoices = await invoiceRepository.exportForReporting(businessId, fromDate, toDate);
    
    // Format based on export type
    switch (format) {
      case 'csv':
        return this.generateCSVReport(metrics, invoices);
      case 'excel':
        return this.generateExcelReport(metrics, invoices);
      case 'pdf':
        return this.generatePDFReport(metrics, invoices);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Generate CSV report
   */
  private generateCSVReport(metrics: BusinessMetrics, invoices: any[]): Buffer {
    const lines = ['Report Type,Value'];
    
    // Add metrics
    lines.push(`Total Revenue,${metrics.revenue.total}`);
    lines.push(`Monthly Revenue,${metrics.revenue.monthly}`);
    lines.push(`Revenue Growth,${metrics.revenue.growth}%`);
    lines.push(`Total Invoices,${metrics.invoices.total}`);
    lines.push(`Paid Invoices,${metrics.invoices.paid}`);
    lines.push(`Overdue Invoices,${metrics.invoices.overdue}`);
    lines.push(`Average Invoice Value,${metrics.invoices.averageValue}`);
    lines.push(`Total Customers,${metrics.customers.total}`);
    lines.push(`Active Customers,${metrics.customers.active}`);
    lines.push(`Repeat Rate,${metrics.customers.repeatRate}%`);
    lines.push(`Average Days to Pay,${metrics.payments.averageDaysToPay}`);
    lines.push(`Outstanding Balance,${metrics.payments.outstanding}`);
    
    lines.push('');
    lines.push('Invoice Number,Date,Customer,Amount,Status,Payment Date');
    
    // Add invoices
    invoices.forEach(inv => {
      lines.push(
        `${inv.invoice_number},${inv.issue_date},${inv.customer_name},${inv.total_amount},${inv.payment_status},${inv.paid_at || ''}`
      );
    });

    return Buffer.from(lines.join('\n'));
  }

  /**
   * Generate Excel report
   */
  private async generateExcelReport(metrics: BusinessMetrics, invoices: any[]): Promise<Buffer> {
    // In a real implementation, you'd use exceljs or similar
    // This is a placeholder
    return Buffer.from('Excel report placeholder');
  }

  /**
   * Generate PDF report
   */
  private async generatePDFReport(metrics: BusinessMetrics, invoices: any[]): Promise<Buffer> {
    // In a real implementation, you'd use pdfkit or similar
    // This is a placeholder
    return Buffer.from('PDF report placeholder');
  }
}

export const analyticsService = new AnalyticsService();
