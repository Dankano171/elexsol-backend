import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { subDays, subMonths, differenceInDays, differenceInMonths } from 'date-fns';

export interface CustomerSegment {
  id: string;
  name: string;
  description: string;
  criteria: {
    minOrders?: number;
    minSpend?: number;
    maxDaysSinceLastOrder?: number;
    paymentReliability?: 'excellent' | 'good' | 'average' | 'poor';
  };
  customers: Array<{
    id: string;
    name: string;
    email?: string;
    totalSpent: number;
    orderCount: number;
    lastOrderDate: Date;
    averageOrderValue: number;
    paymentReliability: string;
  }>;
  metrics: {
    customerCount: number;
    totalRevenue: number;
    averageOrderValue: number;
    repeatRate: number;
  };
}

export interface CustomerLTV {
  customerId: string;
  customerName: string;
  customerEmail?: string;
  firstPurchaseDate: Date;
  lastPurchaseDate: Date;
  totalSpent: number;
  totalOrders: number;
  averageOrderValue: number;
  customerLifetime: number; // in days
  ltv: number;
  predictedLTV: number;
  cohort: string;
  churnRisk: 'low' | 'medium' | 'high';
}

export interface ChurnPrediction {
  customerId: string;
  customerName: string;
  churnProbability: number; // 0-1
  riskFactors: string[];
  recommendedActions: string[];
  estimatedRevenueAtRisk: number;
}

export class CustomerInsightsService {
  private readonly cacheTTL = 3600; // 1 hour
  private readonly churnThreshold = 60; // days since last purchase

  /**
   * Segment customers based on behavior
   */
  async segmentCustomers(
    businessId: string,
    refreshCache: boolean = false
  ): Promise<CustomerSegment[]> {
    try {
      const cacheKey = `customer_segments:${businessId}`;
      
      if (!refreshCache) {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      }

      // Get all customers with their purchase history
      const customerSummaries = await invoiceRepository.getCustomerSummary(businessId, 1000);
      
      const segments: CustomerSegment[] = [
        this.getVIPCustomers(customerSummaries),
        this.getRegularCustomers(customerSummaries),
        this.getOccasionalCustomers(customerSummaries),
        this.getAtRiskCustomers(customerSummaries),
        this.getNewCustomers(customerSummaries),
        this.getChurnedCustomers(customerSummaries)
      ];

      // Enrich with customer details
      for (const segment of segments) {
        segment.customers = await this.enrichCustomerDetails(businessId, segment.criteria);
      }

      await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(segments));

      return segments;
    } catch (error) {
      logger.error('Error segmenting customers:', error);
      throw error;
    }
  }

  /**
   * Get VIP customers (high spend, frequent)
   */
  private getVIPCustomers(customerSummaries: any[]): CustomerSegment {
    const vipCriteria = {
      minOrders: 10,
      minSpend: 1000000, // ₦1M
      maxDaysSinceLastOrder: 60
    };

    const vipCustomers = customerSummaries.filter(c => 
      c.invoice_count >= vipCriteria.minOrders &&
      c.total_billed >= vipCriteria.minSpend
    );

    const totalRevenue = vipCustomers.reduce((sum, c) => sum + parseFloat(c.total_billed), 0);
    const totalOrders = vipCustomers.reduce((sum, c) => sum + parseInt(c.invoice_count), 0);

    return {
      id: 'vip',
      name: 'VIP Customers',
      description: 'High-value customers with frequent purchases',
      criteria: vipCriteria,
      customers: [],
      metrics: {
        customerCount: vipCustomers.length,
        totalRevenue,
        averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
        repeatRate: vipCustomers.length > 0 ? 1 : 0
      }
    };
  }

  /**
   * Get regular customers
   */
  private getRegularCustomers(customerSummaries: any[]): CustomerSegment {
    const regularCriteria = {
      minOrders: 5,
      minSpend: 100000, // ₦100K
      maxDaysSinceLastOrder: 90
    };

    const regularCustomers = customerSummaries.filter(c => 
      c.invoice_count >= regularCriteria.minOrders &&
      c.total_billed >= regularCriteria.minSpend &&
      c.invoice_count < 10 // Exclude VIP
    );

    const totalRevenue = regularCustomers.reduce((sum, c) => sum + parseFloat(c.total_billed), 0);
    const totalOrders = regularCustomers.reduce((sum, c) => sum + parseInt(c.invoice_count), 0);

    return {
      id: 'regular',
      name: 'Regular Customers',
      description: 'Consistent customers with moderate spending',
      criteria: regularCriteria,
      customers: [],
      metrics: {
        customerCount: regularCustomers.length,
        totalRevenue,
        averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
        repeatRate: regularCustomers.length > 0 ? 1 : 0
      }
    };
  }

  /**
   * Get occasional customers
   */
  private getOccasionalCustomers(customerSummaries: any[]): CustomerSegment {
    const occasionalCriteria = {
      minOrders: 2,
      maxOrders: 4,
      maxDaysSinceLastOrder: 120
    };

    const occasionalCustomers = customerSummaries.filter(c => 
      c.invoice_count >= occasionalCriteria.minOrders &&
      c.invoice_count <= occasionalCriteria.maxOrders
    );

    const totalRevenue = occasionalCustomers.reduce((sum, c) => sum + parseFloat(c.total_billed), 0);
    const totalOrders = occasionalCustomers.reduce((sum, c) => sum + parseInt(c.invoice_count), 0);

    return {
      id: 'occasional',
      name: 'Occasional Customers',
      description: 'Customers who purchase occasionally',
      criteria: occasionalCriteria,
      customers: [],
      metrics: {
        customerCount: occasionalCustomers.length,
        totalRevenue,
        averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
        repeatRate: occasionalCustomers.length > 0 ? 1 : 0
      }
    };
  }

  /**
   * Get at-risk customers
   */
  private getAtRiskCustomers(customerSummaries: any[]): CustomerSegment {
    const now = new Date();
    const atRiskCriteria = {
      minOrders: 2,
      maxDaysSinceLastOrder: this.churnThreshold,
      lastOrderDays: { $gt: 30, $lt: this.churnThreshold }
    };

    // This would need actual last order dates - simplified version
    const atRiskCustomers = customerSummaries.filter(c => 
      c.invoice_count >= 2
    ).slice(0, 20); // Placeholder

    const totalRevenue = atRiskCustomers.reduce((sum, c) => sum + parseFloat(c.total_billed), 0);
    const totalOrders = atRiskCustomers.reduce((sum, c) => sum + parseInt(c.invoice_count), 0);

    return {
      id: 'at_risk',
      name: 'At-Risk Customers',
      description: 'Customers who haven\'t purchased recently',
      criteria: atRiskCriteria,
      customers: [],
      metrics: {
        customerCount: atRiskCustomers.length,
        totalRevenue,
        averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
        repeatRate: 0
      }
    };
  }

  /**
   * Get new customers
   */
  private getNewCustomers(customerSummaries: any[]): CustomerSegment {
    const thirtyDaysAgo = subDays(new Date(), 30);
    
    const newCriteria = {
      firstPurchaseAfter: thirtyDaysAgo,
      maxOrders: 1
    };

    // This would need actual first purchase dates - simplified
    const newCustomers = customerSummaries.slice(0, 20); // Placeholder

    const totalRevenue = newCustomers.reduce((sum, c) => sum + parseFloat(c.total_billed), 0);
    const totalOrders = newCustomers.reduce((sum, c) => sum + parseInt(c.invoice_count), 0);

    return {
      id: 'new',
      name: 'New Customers',
      description: 'Customers who made their first purchase in the last 30 days',
      criteria: newCriteria,
      customers: [],
      metrics: {
        customerCount: newCustomers.length,
        totalRevenue,
        averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
        repeatRate: 0
      }
    };
  }

  /**
   * Get churned customers
   */
  private getChurnedCustomers(customerSummaries: any[]): CustomerSegment {
    const churnedCriteria = {
      maxDaysSinceLastOrder: this.churnThreshold,
      lastOrderDays: { $gt: this.churnThreshold }
    };

    // This would need actual last order dates - simplified
    const churnedCustomers = []; // Placeholder

    return {
      id: 'churned',
      name: 'Churned Customers',
      description: 'Customers who haven\'t purchased in over 60 days',
      criteria: churnedCriteria,
      customers: [],
      metrics: {
        customerCount: 0,
        totalRevenue: 0,
        averageOrderValue: 0,
        repeatRate: 0
      }
    };
  }

  /**
   * Enrich customer details with actual data
   */
  private async enrichCustomerDetails(
    businessId: string,
    criteria: any
  ): Promise<any[]> {
    // This would fetch actual customer data from database
    // Placeholder implementation
    return [];
  }

  /**
   * Calculate customer lifetime value
   */
  async calculateLTV(
    businessId: string,
    customerTin: string
  ): Promise<CustomerLTV | null> {
    try {
      const invoices = await invoiceRepository.findByCustomer(customerTin, businessId);
      
      if (invoices.length === 0) {
        return null;
      }

      const firstPurchase = invoices.reduce((earliest, inv) => 
        inv.issue_date < earliest.issue_date ? inv : earliest
      );
      
      const lastPurchase = invoices.reduce((latest, inv) => 
        inv.issue_date > latest.issue_date ? inv : latest
      );

      const totalSpent = invoices.reduce((sum, inv) => sum + inv.total_amount, 0);
      const totalOrders = invoices.length;
      const averageOrderValue = totalSpent / totalOrders;
      
      const customerLifetime = differenceInDays(lastPurchase.issue_date, firstPurchase.issue_date);
      
      // Calculate LTV (simplified)
      const ltv = totalSpent;

      // Predict LTV based on average monthly spend
      const monthsActive = Math.max(1, customerLifetime / 30);
      const monthlyAverage = totalSpent / monthsActive;
      const predictedLTV = monthlyAverage * 24; // Predict 2 years

      // Determine cohort
      const cohort = `${firstPurchase.issue_date.getFullYear()}-${(firstPurchase.issue_date.getMonth() + 1)
        .toString().padStart(2, '0')}`;

      // Calculate churn risk
      const daysSinceLastPurchase = differenceInDays(new Date(), lastPurchase.issue_date);
      let churnRisk: 'low' | 'medium' | 'high' = 'low';
      
      if (daysSinceLastPurchase > 45) {
        churnRisk = 'high';
      } else if (daysSinceLastPurchase > 30) {
        churnRisk = 'medium';
      }

      return {
        customerId: customerTin,
        customerName: lastPurchase.customer_name,
        customerEmail: lastPurchase.customer_email,
        firstPurchaseDate: firstPurchase.issue_date,
        lastPurchaseDate: lastPurchase.issue_date,
        totalSpent,
        totalOrders,
        averageOrderValue,
        customerLifetime,
        ltv,
        predictedLTV,
        cohort,
        churnRisk
      };
    } catch (error) {
      logger.error('Error calculating LTV:', error);
      throw error;
    }
  }

  /**
   * Predict churn for all customers
   */
  async predictChurn(businessId: string): Promise<ChurnPrediction[]> {
    try {
      const customers = await invoiceRepository.getCustomerSummary(businessId, 1000);
      const predictions: ChurnPrediction[] = [];

      for (const customer of customers) {
        const prediction = await this.predictCustomerChurn(
          businessId,
          customer.customer_tin
        );
        if (prediction) {
          predictions.push(prediction);
        }
      }

      // Sort by churn probability (highest first)
      return predictions.sort((a, b) => b.churnProbability - a.churnProbability);
    } catch (error) {
      logger.error('Error predicting churn:', error);
      throw error;
    }
  }

  /**
   * Predict churn for a single customer
   */
  async predictCustomerChurn(
    businessId: string,
    customerTin: string
  ): Promise<ChurnPrediction | null> {
    try {
      const invoices = await invoiceRepository.findByCustomer(customerTin, businessId);
      
      if (invoices.length === 0) {
        return null;
      }

      const lastInvoice = invoices.reduce((latest, inv) => 
        inv.issue_date > latest.issue_date ? inv : latest
      );

      const daysSinceLastPurchase = differenceInDays(new Date(), lastInvoice.issue_date);
      
      // Calculate churn probability using simple heuristics
      let churnProbability = 0;
      const riskFactors: string[] = [];

      // Factor 1: Recency
      if (daysSinceLastPurchase > this.churnThreshold) {
        churnProbability += 0.5;
        riskFactors.push(`No purchase in ${daysSinceLastPurchase} days`);
      } else if (daysSinceLastPurchase > 30) {
        churnProbability += 0.3;
        riskFactors.push(`No purchase in ${daysSinceLastPurchase} days`);
      }

      // Factor 2: Purchase frequency
      if (invoices.length === 1) {
        churnProbability += 0.3;
        riskFactors.push('Single purchase only');
      } else {
        const purchaseFrequency = invoices.length / 
          (differenceInMonths(new Date(), invoices[0].issue_date) || 1);
        
        if (purchaseFrequency < 0.5) { // Less than one purchase every 2 months
          churnProbability += 0.2;
          riskFactors.push('Low purchase frequency');
        }
      }

      // Factor 3: Payment issues
      const overdueInvoices = invoices.filter(inv => 
        inv.payment_status === 'overdue'
      ).length;

      if (overdueInvoices > 0) {
        churnProbability += 0.2;
        riskFactors.push(`${overdueInvoices} overdue invoice(s)`);
      }

      // Cap probability at 0.95
      churnProbability = Math.min(0.95, churnProbability);

      // Generate recommendations
      const recommendedActions = this.generateChurnPreventionActions(
        churnProbability,
        riskFactors,
        lastInvoice
      );

      // Calculate revenue at risk
      const averageOrderValue = invoices.reduce((sum, inv) => sum + inv.total_amount, 0) / invoices.length;
      const estimatedRevenueAtRisk = averageOrderValue * (invoices.length > 1 ? 2 : 1) * churnProbability;

      return {
        customerId: customerTin,
        customerName: lastInvoice.customer_name,
        churnProbability: Math.round(churnProbability * 100) / 100,
        riskFactors,
        recommendedActions,
        estimatedRevenueAtRisk: Math.round(estimatedRevenueAtRisk * 100) / 100
      };
    } catch (error) {
      logger.error('Error predicting customer churn:', error);
      throw error;
    }
  }

  /**
   * Generate churn prevention actions
   */
  private generateChurnPreventionActions(
    churnProbability: number,
    riskFactors: string[],
    lastInvoice: any
  ): string[] {
    const actions: string[] = [];

    if (churnProbability > 0.7) {
      actions.push('🚨 Immediate outreach required - high churn risk');
      actions.push('Consider offering a special discount or loyalty bonus');
    }

    if (riskFactors.some(f => f.includes('overdue'))) {
      actions.push('Reach out to resolve outstanding payments');
      actions.push('Offer payment plan if needed');
    }

    if (riskFactors.some(f => f.includes('Single purchase'))) {
      actions.push('Send follow-up email with related products');
      actions.push('Offer first-time buyer discount on next purchase');
    }

    if (lastInvoice) {
      actions.push(`Reference their last purchase: ${lastInvoice.invoice_number}`);
    }

    // Add general actions based on probability
    if (churnProbability > 0.4) {
      actions.push('Send personalized re-engagement email');
      actions.push('Invite to provide feedback on their experience');
    }

    return actions.slice(0, 5); // Limit to 5 actions
  }

  /**
   * Get customer health score
   */
  async getCustomerHealthScore(
    businessId: string,
    customerTin: string
  ): Promise<{
    score: number;
    factors: Array<{ name: string; score: number; impact: 'positive' | 'negative' }>;
  }> {
    const invoices = await invoiceRepository.findByCustomer(customerTin, businessId);
    
    if (invoices.length === 0) {
      return { score: 0, factors: [] };
    }

    const factors = [];
    let totalScore = 0;

    // Recency factor
    const lastInvoice = invoices.reduce((latest, inv) => 
      inv.issue_date > latest.issue_date ? inv : latest
    );
    const daysSinceLast = differenceInDays(new Date(), lastInvoice.issue_date);
    
    let recencyScore = 100;
    if (daysSinceLast > 60) recencyScore = 30;
    else if (daysSinceLast > 30) recencyScore = 60;
    else if (daysSinceLast > 15) recencyScore = 80;
    
    factors.push({
      name: 'Recency',
      score: recencyScore,
      impact: recencyScore >= 60 ? 'positive' : 'negative'
    });
    totalScore += recencyScore;

    // Frequency factor
    const monthsActive = Math.max(1, 
      differenceInMonths(new Date(), invoices[0].issue_date)
    );
    const purchasesPerMonth = invoices.length / monthsActive;
    
    let frequencyScore = 50;
    if (purchasesPerMonth > 2) frequencyScore = 90;
    else if (purchasesPerMonth > 1) frequencyScore = 75;
    else if (purchasesPerMonth > 0.5) frequencyScore = 60;
    else frequencyScore = 40;
    
    factors.push({
      name: 'Frequency',
      score: frequencyScore,
      impact: frequencyScore >= 60 ? 'positive' : 'negative'
    });
    totalScore += frequencyScore;

    // Monetary factor
    const totalSpent = invoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    const avgOrderValue = totalSpent / invoices.length;
    
    let monetaryScore = 50;
    if (avgOrderValue > 100000) monetaryScore = 90;
    else if (avgOrderValue > 50000) monetaryScore = 75;
    else if (avgOrderValue > 10000) monetaryScore = 60;
    else monetaryScore = 40;
    
    factors.push({
      name: 'Average Order Value',
      score: monetaryScore,
      impact: monetaryScore >= 60 ? 'positive' : 'negative'
    });
    totalScore += monetaryScore;

    // Payment reliability factor
    const paidInvoices = invoices.filter(inv => inv.payment_status === 'paid');
    const onTimePayments = paidInvoices.filter(inv => 
      inv.paid_at && inv.paid_at <= inv.due_date
    ).length;

    let reliabilityScore = 50;
    if (paidInvoices.length > 0) {
      const reliability = onTimePayments / paidInvoices.length;
      if (reliability >= 0.9) reliabilityScore = 90;
      else if (reliability >= 0.7) reliabilityScore = 75;
      else if (reliability >= 0.5) reliabilityScore = 60;
      else reliabilityScore = 30;
    }
    
    factors.push({
      name: 'Payment Reliability',
      score: reliabilityScore,
      impact: reliabilityScore >= 60 ? 'positive' : 'negative'
    });
    totalScore += reliabilityScore;

    const finalScore = Math.round(totalScore / factors.length);

    return {
      score: finalScore,
      factors
    };
  }

  /**
   * Export customer insights report
   */
  async exportReport(
    businessId: string,
    format: 'pdf' | 'excel' | 'csv' = 'csv'
  ): Promise<Buffer> {
    const segments = await this.segmentCustomers(businessId, true);
    const churnPredictions = await this.predictChurn(businessId);

    switch (format) {
      case 'csv':
        return this.generateCSVReport(segments, churnPredictions);
      case 'excel':
        return this.generateExcelReport(segments, churnPredictions);
      case 'pdf':
        return this.generatePDFReport(segments, churnPredictions);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Generate CSV report
   */
  private generateCSVReport(segments: CustomerSegment[], churnPredictions: ChurnPrediction[]): Buffer {
    const lines = ['Customer Insights Report'];
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    // Segment summary
    lines.push('Customer Segments');
    lines.push('Segment,Count,Total Revenue,Avg Order Value');
    
    segments.forEach(s => {
      lines.push(
        `${s.name},${s.metrics.customerCount},` +
        `₦${s.metrics.totalRevenue.toLocaleString()},` +
        `₦${s.metrics.averageOrderValue.toLocaleString()}`
      );
    });

    lines.push('');
    lines.push('Top Churn Risks');
    lines.push('Customer,Probability,Risk Factors,Revenue at Risk');
    
    churnPredictions.slice(0, 20).forEach(p => {
      lines.push(
        `${p.customerName},${(p.churnProbability * 100).toFixed(1)}%,` +
        `"${p.riskFactors.join('; ')}",` +
        `₦${p.estimatedRevenueAtRisk.toLocaleString()}`
      );
    });

    return Buffer.from(lines.join('\n'));
  }

  /**
   * Generate Excel report
   */
  private async generateExcelReport(segments: CustomerSegment[], churnPredictions: ChurnPrediction[]): Promise<Buffer> {
    // Placeholder for Excel generation
    return Buffer.from('Excel report placeholder');
  }

  /**
   * Generate PDF report
   */
  private async generatePDFReport(segments: CustomerSegment[], churnPredictions: ChurnPrediction[]): Promise<Buffer> {
    // Placeholder for PDF generation
    return Buffer.from('PDF report placeholder');
  }
}

export const customerInsightsService = new CustomerInsightsService();
