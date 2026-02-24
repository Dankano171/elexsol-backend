import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { 
  startOfMonth, 
  endOfMonth, 
  subMonths, 
  addMonths, 
  differenceInDays,
  isWithinInterval,
  format 
} from 'date-fns';

export interface CashFlowMetrics {
  current: {
    balance: number;
    projectedInflow: number;
    projectedOutflow: number;
    netProjected: number;
    daysOfRunway: number;
  };
  historical: Array<{
    month: string;
    inflow: number;
    outflow: number;
    net: number;
    startingBalance: number;
    endingBalance: number;
  }>;
  projected: Array<{
    month: string;
    inflow: number;
    outflow: number;
    net: number;
    confidence: 'high' | 'medium' | 'low';
  }>;
  insights: {
    burnRate: number;
    runway: number;
    bestMonth: { month: string; amount: number };
    worstMonth: { month: string; amount: number };
    recommendations: string[];
  };
}

export interface CashFlowAlert {
  type: 'low_balance' | 'negative_flow' | 'large_outgoing' | 'payment_due';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  threshold?: number;
  currentValue?: number;
  dueDate?: Date;
  amount?: number;
}

export class CashFlowService {
  private readonly cacheTTL = 3600; // 1 hour
  private readonly lowBalanceThreshold = 100000; // ₦100,000
  private readonly criticalBalanceThreshold = 50000; // ₦50,000

  /**
   * Calculate cash flow metrics
   */
  async calculateMetrics(
    businessId: string,
    months: number = 12
  ): Promise<CashFlowMetrics> {
    try {
      const cacheKey = `cashflow:${businessId}:${months}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      const now = new Date();
      const startDate = subMonths(now, months);
      const projectionMonths = 3;

      // Get historical data
      const [invoices, transactions] = await Promise.all([
        invoiceRepository.findByDateRange(businessId, startDate, now),
        transactionRepository.findByBusiness(businessId, {
          fromDate: startDate,
          toDate: now,
          status: 'completed'
        })
      ]);

      // Calculate historical cash flow
      const historical = this.calculateHistoricalCashFlow(
        invoices,
        transactions,
        months
      );

      // Calculate current metrics
      const current = await this.calculateCurrentMetrics(
        businessId,
        invoices,
        transactions,
        historical
      );

      // Project future cash flow
      const projected = await this.projectCashFlow(
        businessId,
        invoices,
        transactions,
        projectionMonths
      );

      // Generate insights
      const insights = this.generateInsights(historical, current, projected);

      const metrics: CashFlowMetrics = {
        current,
        historical,
        projected,
        insights
      };

      await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(metrics));

      return metrics;
    } catch (error) {
      logger.error('Error calculating cash flow metrics:', error);
      throw error;
    }
  }

  /**
   * Calculate historical cash flow
   */
  private calculateHistoricalCashFlow(
    invoices: any[],
    transactions: any[],
    months: number
  ): CashFlowMetrics['historical'] {
    const result: CashFlowMetrics['historical'] = [];
    let runningBalance = 0;

    for (let i = months - 1; i >= 0; i--) {
      const monthDate = subMonths(new Date(), i);
      const monthStart = startOfMonth(monthDate);
      const monthEnd = endOfMonth(monthDate);

      // Calculate inflow (payments received)
      const inflow = transactions
        .filter(t => 
          t.status === 'completed' &&
          isWithinInterval(t.transaction_date, { start: monthStart, end: monthEnd })
        )
        .reduce((sum, t) => sum + t.amount, 0);

      // Calculate outflow (future expenses, etc.)
      // For now, just track net change
      const startingBalance = runningBalance;
      runningBalance += inflow;
      const endingBalance = runningBalance;

      result.push({
        month: format(monthDate, 'yyyy-MM'),
        inflow,
        outflow: 0, // Would need expense tracking
        net: inflow,
        startingBalance,
        endingBalance
      });
    }

    return result;
  }

  /**
   * Calculate current metrics
   */
  private async calculateCurrentMetrics(
    businessId: string,
    invoices: any[],
    transactions: any[],
    historical: CashFlowMetrics['historical']
  ): Promise<CashFlowMetrics['current']> {
    // Current balance (from latest historical)
    const currentBalance = historical.length > 0 
      ? historical[historical.length - 1].endingBalance 
      : 0;

    // Calculate projected inflow (upcoming invoices)
    const upcomingInvoices = invoices.filter(inv => 
      inv.payment_status !== 'paid' &&
      new Date(inv.due_date) > new Date()
    );

    const projectedInflow = upcomingInvoices
      .filter(inv => inv.due_date <= addMonths(new Date(), 1))
      .reduce((sum, inv) => sum + inv.balance_due, 0);

    // Calculate projected outflow (placeholder - would need expense tracking)
    const projectedOutflow = 0;

    // Calculate days of runway
    const avgMonthlyBurn = this.calculateAverageBurnRate(historical);
    const daysOfRunway = avgMonthlyBurn > 0 
      ? (currentBalance / avgMonthlyBurn) * 30 
      : 365;

    return {
      balance: currentBalance,
      projectedInflow,
      projectedOutflow,
      netProjected: projectedInflow - projectedOutflow,
      daysOfRunway: Math.round(daysOfRunway)
    };
  }

  /**
   * Project future cash flow
   */
  private async projectCashFlow(
    businessId: string,
    invoices: any[],
    transactions: any[],
    months: number
  ): Promise<CashFlowMetrics['projected']> {
    const result: CashFlowMetrics['projected'] = [];
    
    // Get payment velocity for confidence calculation
    const velocityMetrics = await paymentVelocityService.calculateMetrics(businessId, 90);
    const avgPaymentDays = velocityMetrics.overall.averageDays;

    for (let i = 1; i <= months; i++) {
      const projectionMonth = addMonths(new Date(), i);
      
      // Project inflow based on upcoming invoices
      const upcomingInvoices = invoices.filter(inv => {
        const dueDate = new Date(inv.due_date);
        return inv.payment_status !== 'paid' &&
          dueDate >= startOfMonth(projectionMonth) &&
          dueDate <= endOfMonth(projectionMonth);
      });

      const inflow = upcomingInvoices.reduce((sum, inv) => sum + inv.balance_due, 0);

      // Determine confidence level
      let confidence: 'high' | 'medium' | 'low' = 'medium';
      if (upcomingInvoices.length > 10 && avgPaymentDays < 30) {
        confidence = 'high';
      } else if (upcomingInvoices.length < 3) {
        confidence = 'low';
      }

      result.push({
        month: format(projectionMonth, 'yyyy-MM'),
        inflow,
        outflow: 0, // Would need expense tracking
        net: inflow,
        confidence
      });
    }

    return result;
  }

  /**
   * Calculate average monthly burn rate
   */
  private calculateAverageBurnRate(historical: CashFlowMetrics['historical']): number {
    if (historical.length < 2) return 0;

    const recentMonths = historical.slice(-3);
    const netChanges = recentMonths.map(m => m.net);
    
    return netChanges.reduce((a, b) => a + b, 0) / netChanges.length;
  }

  /**
   * Generate insights and recommendations
   */
  private generateInsights(
    historical: CashFlowMetrics['historical'],
    current: CashFlowMetrics['current'],
    projected: CashFlowMetrics['projected']
  ): CashFlowMetrics['insights'] {
    const burnRate = this.calculateAverageBurnRate(historical);
    
    // Find best and worst months
    const monthsWithFlow = historical.map(h => ({
      month: h.month,
      amount: h.net
    }));

    const bestMonth = monthsWithFlow.reduce((best, current) => 
      current.amount > best.amount ? current : best
    , { month: '', amount: -Infinity });

    const worstMonth = monthsWithFlow.reduce((worst, current) => 
      current.amount < worst.amount ? current : worst
    , { month: '', amount: Infinity });

    // Generate recommendations
    const recommendations: string[] = [];

    if (current.daysOfRunway < 30) {
      recommendations.push('⚠️ Critical: Less than 30 days of runway. Consider immediate action to improve cash flow.');
    } else if (current.daysOfRunway < 90) {
      recommendations.push('⚠️ Warning: Runway below 90 days. Review expenses and accelerate receivables.');
    } else if (current.daysOfRunway > 180) {
      recommendations.push('✅ Healthy runway. Consider investing excess cash in growth opportunities.');
    }

    if (projected.length > 0 && projected[0].net < 0) {
      recommendations.push('📉 Negative cash flow projected next month. Review upcoming expenses.');
    }

    if (current.balance < this.lowBalanceThreshold) {
      recommendations.push(`💰 Low balance alert: Current balance (₦${current.balance.toLocaleString()}) below threshold.`);
    }

    if (historical.length >= 3) {
      const recentTrend = historical.slice(-3).map(h => h.net);
      const improving = recentTrend[2] > recentTrend[0];
      
      if (improving) {
        recommendations.push('📈 Cash flow trend is improving. Continue current strategies.');
      } else {
        recommendations.push('📉 Cash flow trend is declining. Review and adjust strategies.');
      }
    }

    return {
      burnRate: Math.round(burnRate * 100) / 100,
      runway: current.daysOfRunway,
      bestMonth,
      worstMonth,
      recommendations
    };
  }

  /**
   * Get cash flow alerts
   */
  async getAlerts(businessId: string): Promise<CashFlowAlert[]> {
    const metrics = await this.calculateMetrics(businessId, 3);
    const alerts: CashFlowAlert[] = [];

    // Check balance thresholds
    if (metrics.current.balance < this.criticalBalanceThreshold) {
      alerts.push({
        type: 'low_balance',
        severity: 'critical',
        message: `Critical low balance: ₦${metrics.current.balance.toLocaleString()}`,
        threshold: this.criticalBalanceThreshold,
        currentValue: metrics.current.balance
      });
    } else if (metrics.current.balance < this.lowBalanceThreshold) {
      alerts.push({
        type: 'low_balance',
        severity: 'warning',
        message: `Low balance warning: ₦${metrics.current.balance.toLocaleString()}`,
        threshold: this.lowBalanceThreshold,
        currentValue: metrics.current.balance
      });
    }

    // Check negative flow
    if (metrics.projected.length > 0 && metrics.projected[0].net < 0) {
      alerts.push({
        type: 'negative_flow',
        severity: 'warning',
        message: `Negative cash flow projected for ${metrics.projected[0].month}`,
        amount: Math.abs(metrics.projected[0].net)
      });
    }

    // Check runway
    if (metrics.current.daysOfRunway < 30) {
      alerts.push({
        type: 'negative_flow',
        severity: 'critical',
        message: `Critical: Only ${metrics.current.daysOfRunway} days of runway remaining`
      });
    } else if (metrics.current.daysOfRunway < 90) {
      alerts.push({
        type: 'negative_flow',
        severity: 'warning',
        message: `Warning: ${metrics.current.daysOfRunway} days of runway remaining`
      });
    }

    return alerts;
  }

  /**
   * Get cash flow forecast chart data
   */
  async getForecastChart(businessId: string): Promise<{
    labels: string[];
    inflow: number[];
    outflow: number[];
    balance: number[];
  }> {
    const metrics = await this.calculateMetrics(businessId, 6);
    
    const labels = [
      ...metrics.historical.slice(-3).map(h => h.month),
      ...metrics.projected.map(p => p.month)
    ];

    const inflow = [
      ...metrics.historical.slice(-3).map(h => h.inflow),
      ...metrics.projected.map(p => p.inflow)
    ];

    const outflow = [
      ...metrics.historical.slice(-3).map(h => h.outflow),
      ...metrics.projected.map(p => p.outflow)
    ];

    // Calculate running balance
    let balance = metrics.historical.length > 0 
      ? metrics.historical[metrics.historical.length - 4]?.endingBalance || 0
      : 0;

    const balanceData = [];

    // Add historical balances
    for (let i = metrics.historical.length - 3; i < metrics.historical.length; i++) {
      if (metrics.historical[i]) {
        balanceData.push(metrics.historical[i].endingBalance);
        balance = metrics.historical[i].endingBalance;
      }
    }

    // Add projected balances
    for (const proj of metrics.projected) {
      balance += proj.net;
      balanceData.push(balance);
    }

    return {
      labels,
      inflow,
      outflow,
      balance: balanceData
    };
  }

  /**
   * Export cash flow report
   */
  async exportReport(
    businessId: string,
    format: 'pdf' | 'excel' | 'csv' = 'csv'
  ): Promise<Buffer> {
    const metrics = await this.calculateMetrics(businessId, 12);

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
  private generateCSVReport(metrics: CashFlowMetrics): Buffer {
    const lines = ['Cash Flow Report'];
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    
    lines.push('Current Metrics');
    lines.push(`Balance,₦${metrics.current.balance.toLocaleString()}`);
    lines.push(`Projected Inflow,₦${metrics.current.projectedInflow.toLocaleString()}`);
    lines.push(`Days of Runway,${metrics.current.daysOfRunway}`);
    lines.push('');
    
    lines.push('Historical Cash Flow');
    lines.push('Month,Inflow,Outflow,Net,Starting Balance,Ending Balance');
    
    metrics.historical.forEach(h => {
      lines.push(
        `${h.month},₦${h.inflow.toLocaleString()},₦${h.outflow.toLocaleString()},` +
        `₦${h.net.toLocaleString()},₦${h.startingBalance.toLocaleString()},` +
        `₦${h.endingBalance.toLocaleString()}`
      );
    });
    
    lines.push('');
    lines.push('Projected Cash Flow');
    lines.push('Month,Projected Inflow,Confidence');
    
    metrics.projected.forEach(p => {
      lines.push(`${p.month},₦${p.inflow.toLocaleString()},${p.confidence}`);
    });

    return Buffer.from(lines.join('\n'));
  }

  /**
   * Generate Excel report
   */
  private async generateExcelReport(metrics: CashFlowMetrics): Promise<Buffer> {
    // Placeholder for Excel generation
    return Buffer.from('Excel report placeholder');
  }

  /**
   * Generate PDF report
   */
  private async generatePDFReport(metrics: CashFlowMetrics): Promise<Buffer> {
    // Placeholder for PDF generation
    return Buffer.from('PDF report placeholder');
  }
}

export const cashFlowService = new CashFlowService();
