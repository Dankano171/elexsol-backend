// src/services/growth-engine/calculators/payment-velocity.ts
import { db } from '../../../config/database';
import { logger } from '../../../config/logger';

export interface PaymentVelocityMetrics {
  averageDaysToPayment: number;
  medianDaysToPayment: number;
  fastestPaymentDays: number;
  slowestPaymentDays: number;
  byCustomer: Record<string, CustomerVelocity>;
  trend: MonthlyVelocity[];
}

export interface CustomerVelocity {
  customerName: string;
  customerTIN: string;
  averageDaysToPayment: number;
  invoiceCount: number;
  totalValue: number;
}

export interface MonthlyVelocity {
  month: string;
  averageDays: number;
  invoiceCount: number;
  totalAmount: number;
}

export class PaymentVelocityCalculator {
  
  /**
   * Calculate payment velocity for a business
   */
  static async calculate(
    businessId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<PaymentVelocityMetrics> {
    const start = startDate || new Date(new Date().setMonth(new Date().getMonth() - 12));
    const end = endDate || new Date();

    try {
      // Get all paid invoices within date range
      const invoices = await db.query(`
        SELECT 
          i.id,
          i.invoice_number,
          i.customer_name,
          i.customer_tin,
          i.total_amount,
          i.issue_date,
          i.payment_date,
          EXTRACT(DAY FROM (i.payment_date - i.issue_date)) as days_to_payment
        FROM invoices i
        WHERE i.business_id = $1
          AND i.payment_status = 'paid'
          AND i.payment_date IS NOT NULL
          AND i.payment_date BETWEEN $2 AND $3
          AND i.issue_date IS NOT NULL
        ORDER BY i.payment_date DESC
      `, [businessId, start, end]);

      if (invoices.rows.length === 0) {
        return {
          averageDaysToPayment: 0,
          medianDaysToPayment: 0,
          fastestPaymentDays: 0,
          slowestPaymentDays: 0,
          byCustomer: {},
          trend: []
        };
      }

      const daysArray = invoices.rows.map(r => parseFloat(r.days_to_payment));
      
      // Calculate aggregates
      const average = this.calculateAverage(daysArray);
      const median = this.calculateMedian(daysArray);
      const fastest = Math.min(...daysArray);
      const slowest = Math.max(...daysArray);

      // Calculate by customer
      const byCustomer = this.aggregateByCustomer(invoices.rows);

      // Calculate monthly trend
      const trend = await this.calculateMonthlyTrend(businessId, start, end);

      return {
        averageDaysToPayment: average,
        medianDaysToPayment: median,
        fastestPaymentDays: fastest,
        slowestPaymentDays: slowest,
        byCustomer,
        trend
      };

    } catch (error) {
      logger.error('Payment velocity calculation failed:', error);
      throw new Error(`Failed to calculate payment velocity: ${error.message}`);
    }
  }

  /**
   * Calculate average days to payment
   */
  private static calculateAverage(days: number[]): number {
    const sum = days.reduce((acc, d) => acc + d, 0);
    return Math.round((sum / days.length) * 10) / 10;
  }

  /**
   * Calculate median days to payment
   */
  private static calculateMedian(days: number[]): number {
    const sorted = [...days].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    
    return sorted[mid];
  }

  /**
   * Aggregate metrics by customer
   */
  private static aggregateByCustomer(invoices: any[]): Record<string, CustomerVelocity> {
    const customerMap: Record<string, {
      name: string;
      tin: string;
      days: number[];
      totalValue: number;
      invoiceCount: number;
    }> = {};

    invoices.forEach(inv => {
      const key = inv.customer_tin || `unknown-${inv.customer_name}`;
      
      if (!customerMap[key]) {
        customerMap[key] = {
          name: inv.customer_name || 'Unknown',
          tin: inv.customer_tin || '',
          days: [],
          totalValue: 0,
          invoiceCount: 0
        };
      }
      
      customerMap[key].days.push(parseFloat(inv.days_to_payment));
      customerMap[key].totalValue += parseFloat(inv.total_amount);
      customerMap[key].invoiceCount++;
    });

    const result: Record<string, CustomerVelocity> = {};
    
    Object.entries(customerMap).forEach(([key, data]) => {
      result[key] = {
        customerName: data.name,
        customerTIN: data.tin,
        averageDaysToPayment: this.calculateAverage(data.days),
        invoiceCount: data.invoiceCount,
        totalValue: Math.round(data.totalValue * 100) / 100
      };
    });

    return result;
  }

  /**
   * Calculate monthly payment velocity trend
   */
  private static async calculateMonthlyTrend(
    businessId: string,
    startDate: Date,
    endDate: Date
  ): Promise<MonthlyVelocity[]> {
    const result = await db.query(`
      WITH monthly_data AS (
        SELECT 
          DATE_TRUNC('month', payment_date) as month,
          AVG(EXTRACT(DAY FROM (payment_date - issue_date))) as avg_days,
          COUNT(*) as invoice_count,
          SUM(total_amount) as total_amount
        FROM invoices
        WHERE business_id = $1
          AND payment_status = 'paid'
          AND payment_date BETWEEN $2 AND $3
          AND payment_date IS NOT NULL
          AND issue_date IS NOT NULL
        GROUP BY DATE_TRUNC('month', payment_date)
        ORDER BY month DESC
      )
      SELECT 
        TO_CHAR(month, 'YYYY-MM') as month,
        ROUND(COALESCE(avg_days, 0)::numeric, 1) as avg_days,
        invoice_count,
        ROUND(total_amount::numeric, 2) as total_amount
      FROM monthly_data
    `, [businessId, startDate, endDate]);

    return result.rows.map(row => ({
      month: row.month,
      averageDays: parseFloat(row.avg_days),
      invoiceCount: parseInt(row.invoice_count),
      totalAmount: parseFloat(row.total_amount)
    }));
  }

  /**
   * Get payment velocity insights
   */
  static async getInsights(businessId: string): Promise<any> {
    const currentPeriod = await this.calculate(
      businessId,
      new Date(new Date().setMonth(new Date().getMonth() - 3)),
      new Date()
    );

    const previousPeriod = await this.calculate(
      businessId,
      new Date(new Date().setMonth(new Date().getMonth() - 6)),
      new Date(new Date().setMonth(new Date().getMonth() - 3))
    );

    const change = currentPeriod.averageDaysToPayment - previousPeriod.averageDaysToPayment;
    const percentChange = previousPeriod.averageDaysToPayment > 0 
      ? (change / previousPeriod.averageDaysToPayment) * 100 
      : 0;

    // Identify fastest paying customers
    const topCustomers = Object.values(currentPeriod.byCustomer)
      .sort((a, b) => a.averageDaysToPayment - b.averageDaysToPayment)
      .slice(0, 5);

    // Identify slowest paying customers
    const slowCustomers = Object.values(currentPeriod.byCustomer)
      .sort((a, b) => b.averageDaysToPayment - a.averageDaysToPayment)
      .slice(0, 5);

    return {
      currentAverage: currentPeriod.averageDaysToPayment,
      previousAverage: previousPeriod.averageDaysToPayment,
      change: {
        days: Math.round(change * 10) / 10,
        percent: Math.round(percentChange * 10) / 10,
        improved: change < 0
      },
      fastestCustomers: topCustomers,
      slowestCustomers: slowCustomers,
      trend: currentPeriod.trend,
      recommendation: this.generateRecommendation(currentPeriod.averageDaysToPayment, change)
    };
  }

  private static generateRecommendation(average: number, change: number): string {
    if (average <= 7) {
      return "Excellent payment velocity! Consider offering early payment discounts to maintain this.";
    } else if (average <= 15) {
      return "Good payment velocity. Automate payment reminders at day 10 to improve further.";
    } else if (average <= 30) {
      return "Average payment velocity. Implement automated invoice tracking and reminders.";
    } else {
      return "Slow payment velocity. Review your credit terms and consider payment incentives.";
    }
  }
}
