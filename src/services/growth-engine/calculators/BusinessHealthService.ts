import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { businessRepository } from '../../repositories/BusinessRepository';
import { userRepository } from '../../repositories/UserRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { subDays, subMonths, differenceInDays } from 'date-fns';

export interface HealthScore {
  overall: number;
  category: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
  components: {
    financial: ComponentScore;
    operational: ComponentScore;
    customer: ComponentScore;
    compliance: ComponentScore;
    growth: ComponentScore;
  };
  trends: {
    weekly: number;
    monthly: number;
    quarterly: number;
  };
  alerts: HealthAlert[];
}

export interface ComponentScore {
  score: number;
  weight: number;
  status: 'healthy' | 'warning' | 'critical';
  factors: Array<{
    name: string;
    value: any;
    impact: 'positive' | 'negative' | 'neutral';
    threshold?: number;
  }>;
}

export interface HealthAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  category: string;
  message: string;
  timestamp: Date;
  acknowledged: boolean;
  actionable: boolean;
  actionUrl?: string;
  threshold?: number;
  currentValue?: number;
}

export interface BenchmarkData {
  metric: string;
  businessValue: number;
  industryAverage: number;
  topPerformer: number;
  percentile: number;
  recommendation?: string;
}

export class BusinessHealthService {
  private readonly cacheTTL = 1800; // 30 minutes
  private readonly warningThreshold = 60;
  private readonly criticalThreshold = 40;

  /**
   * Calculate overall business health score
   */
  async calculateHealthScore(businessId: string): Promise<HealthScore> {
    try {
      const cacheKey = `health_score:${businessId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Calculate component scores
      const [
        financialScore,
        operationalScore,
        customerScore,
        complianceScore,
        growthScore
      ] = await Promise.all([
        this.calculateFinancialHealth(businessId),
        this.calculateOperationalHealth(businessId),
        this.calculateCustomerHealth(businessId),
        this.calculateComplianceHealth(businessId),
        this.calculateGrowthHealth(businessId)
      ]);

      // Calculate weighted overall score
      const weights = {
        financial: 0.35,
        operational: 0.20,
        customer: 0.20,
        compliance: 0.15,
        growth: 0.10
      };

      const overall = Math.round(
        financialScore.score * weights.financial +
        operationalScore.score * weights.operational +
        customerScore.score * weights.customer +
        complianceScore.score * weights.compliance +
        growthScore.score * weights.growth
      );

      // Determine category
      let category: HealthScore['category'] = 'poor';
      if (overall >= 80) category = 'excellent';
      else if (overall >= 70) category = 'good';
      else if (overall >= 60) category = 'fair';
      else if (overall >= 40) category = 'poor';
      else category = 'critical';

      // Calculate trends
      const trends = await this.calculateTrends(businessId);

      // Generate alerts
      const alerts = await this.generateAlerts(businessId, {
        financial: financialScore,
        operational: operationalScore,
        customer: customerScore,
        compliance: complianceScore,
        growth: growthScore
      });

      const healthScore: HealthScore = {
        overall,
        category,
        components: {
          financial: financialScore,
          operational: operationalScore,
          customer: customerScore,
          compliance: complianceScore,
          growth: growthScore
        },
        trends,
        alerts
      };

      await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(healthScore));

      return healthScore;
    } catch (error) {
      logger.error('Error calculating health score:', error);
      throw error;
    }
  }

  /**
   * Calculate financial health
   */
  private async calculateFinancialHealth(businessId: string): Promise<ComponentScore> {
    const factors = [];
    let totalScore = 0;

    // Factor 1: Cash flow (weight: 30%)
    const cashFlow = await this.analyzeCashFlow(businessId);
    let cashFlowScore = 50;
    if (cashFlow.positive) {
      cashFlowScore = 80;
      if (cashFlow.growth > 10) cashFlowScore = 90;
    } else {
      cashFlowScore = 30;
    }
    factors.push({
      name: 'Cash Flow',
      value: cashFlow,
      impact: cashFlow.positive ? 'positive' : 'negative'
    });
    totalScore += cashFlowScore * 0.3;

    // Factor 2: Profit margin (weight: 25%)
    const margin = await this.calculateProfitMargin(businessId);
    let marginScore = 50;
    if (margin > 20) marginScore = 90;
    else if (margin > 15) marginScore = 80;
    else if (margin > 10) marginScore = 70;
    else if (margin > 5) marginScore = 60;
    else marginScore = 40;
    
    factors.push({
      name: 'Profit Margin',
      value: `${margin.toFixed(1)}%`,
      impact: margin >= 10 ? 'positive' : 'negative',
      threshold: 10
    });
    totalScore += marginScore * 0.25;

    // Factor 3: Outstanding receivables (weight: 20%)
    const receivables = await this.calculateOutstandingRatio(businessId);
    let receivablesScore = 50;
    if (receivables < 0.2) receivablesScore = 90;
    else if (receivables < 0.3) receivablesScore = 80;
    else if (receivables < 0.4) receivablesScore = 70;
    else if (receivables < 0.5) receivablesScore = 60;
    else receivablesScore = 40;

    factors.push({
      name: 'Outstanding Receivables',
      value: `${(receivables * 100).toFixed(1)}%`,
      impact: receivables < 0.3 ? 'positive' : 'negative',
      threshold: 30
    });
    totalScore += receivablesScore * 0.2;

    // Factor 4: Revenue stability (weight: 25%)
    const stability = await this.calculateRevenueStability(businessId);
    let stabilityScore = 50;
    if (stability < 0.1) stabilityScore = 90;
    else if (stability < 0.2) stabilityScore = 80;
    else if (stability < 0.3) stabilityScore = 70;
    else stabilityScore = 50;

    factors.push({
      name: 'Revenue Stability',
      value: `${(stability * 100).toFixed(1)}%`,
      impact: stability < 0.2 ? 'positive' : 'negative'
    });
    totalScore += stabilityScore * 0.25;

    const finalScore = Math.round(totalScore);
    
    return {
      score: finalScore,
      weight: 0.35,
      status: this.getStatusFromScore(finalScore),
      factors
    };
  }

  /**
   * Calculate operational health
   */
  private async calculateOperationalHealth(businessId: string): Promise<ComponentScore> {
    const factors = [];
    let totalScore = 0;

    // Factor 1: Payment velocity (weight: 30%)
    const velocity = await this.calculatePaymentVelocity(businessId);
    let velocityScore = 50;
    if (velocity < 15) velocityScore = 90;
    else if (velocity < 30) velocityScore = 80;
    else if (velocity < 45) velocityScore = 70;
    else if (velocity < 60) velocityScore = 60;
    else velocityScore = 40;

    factors.push({
      name: 'Payment Velocity',
      value: `${velocity} days`,
      impact: velocity < 30 ? 'positive' : 'negative',
      threshold: 30
    });
    totalScore += velocityScore * 0.3;

    // Factor 2: Invoice processing time (weight: 25%)
    const processingTime = await this.calculateInvoiceProcessingTime(businessId);
    let processingScore = 50;
    if (processingTime < 1) processingScore = 90;
    else if (processingTime < 2) processingScore = 80;
    else if (processingTime < 3) processingScore = 70;
    else processingScore = 50;

    factors.push({
      name: 'Invoice Processing',
      value: `${processingTime} hours`,
      impact: processingTime < 2 ? 'positive' : 'negative',
      threshold: 2
    });
    totalScore += processingScore * 0.25;

    // Factor 3: Automation rate (weight: 25%)
    const automationRate = await this.calculateAutomationRate(businessId);
    let automationScore = 50;
    if (automationRate > 80) automationScore = 90;
    else if (automationRate > 60) automationScore = 80;
    else if (automationRate > 40) automationScore = 70;
    else if (automationRate > 20) automationScore = 60;
    else automationScore = 40;

    factors.push({
      name: 'Automation Rate',
      value: `${automationRate}%`,
      impact: automationRate > 60 ? 'positive' : 'negative',
      threshold: 60
    });
    totalScore += automationScore * 0.25;

    // Factor 4: Error rate (weight: 20%)
    const errorRate = await this.calculateErrorRate(businessId);
    let errorScore = 50;
    if (errorRate < 1) errorScore = 90;
    else if (errorRate < 2) errorScore = 80;
    else if (errorRate < 5) errorScore = 70;
    else if (errorRate < 10) errorScore = 60;
    else errorScore = 40;

    factors.push({
      name: 'Error Rate',
      value: `${errorRate}%`,
      impact: errorRate < 5 ? 'positive' : 'negative',
      threshold: 5
    });
    totalScore += errorScore * 0.2;

    const finalScore = Math.round(totalScore);

    return {
      score: finalScore,
      weight: 0.20,
      status: this.getStatusFromScore(finalScore),
      factors
    };
  }

  /**
   * Calculate customer health
   */
  private async calculateCustomerHealth(businessId: string): Promise<ComponentScore> {
    const factors = [];
    let totalScore = 0;

    // Factor 1: Customer retention (weight: 35%)
    const retention = await this.calculateRetentionRate(businessId);
    let retentionScore = 50;
    if (retention > 90) retentionScore = 90;
    else if (retention > 80) retentionScore = 80;
    else if (retention > 70) retentionScore = 70;
    else if (retention > 60) retentionScore = 60;
    else retentionScore = 40;

    factors.push({
      name: 'Customer Retention',
      value: `${retention}%`,
      impact: retention > 70 ? 'positive' : 'negative',
      threshold: 70
    });
    totalScore += retentionScore * 0.35;

    // Factor 2: Customer satisfaction (weight: 30%)
    const satisfaction = await this.calculateSatisfactionScore(businessId);
    let satisfactionScore = 50;
    if (satisfaction > 4.5) satisfactionScore = 90;
    else if (satisfaction > 4.0) satisfactionScore = 80;
    else if (satisfaction > 3.5) satisfactionScore = 70;
    else if (satisfaction > 3.0) satisfactionScore = 60;
    else satisfactionScore = 40;

    factors.push({
      name: 'Customer Satisfaction',
      value: `${satisfaction}/5`,
      impact: satisfaction > 4.0 ? 'positive' : 'negative',
      threshold: 4.0
    });
    totalScore += satisfactionScore * 0.3;

    // Factor 3: Repeat purchase rate (weight: 35%)
    const repeatRate = await this.calculateRepeatRate(businessId);
    let repeatScore = 50;
    if (repeatRate > 50) repeatScore = 90;
    else if (repeatRate > 40) repeatScore = 80;
    else if (repeatRate > 30) repeatScore = 70;
    else if (repeatRate > 20) repeatScore = 60;
    else repeatScore = 40;

    factors.push({
      name: 'Repeat Purchase Rate',
      value: `${repeatRate}%`,
      impact: repeatRate > 30 ? 'positive' : 'negative',
      threshold: 30
    });
    totalScore += repeatScore * 0.35;

    const finalScore = Math.round(totalScore);

    return {
      score: finalScore,
      weight: 0.20,
      status: this.getStatusFromScore(finalScore),
      factors
    };
  }

  /**
   * Calculate compliance health
   */
  private async calculateComplianceHealth(businessId: string): Promise<ComponentScore> {
    const factors = [];
    let totalScore = 0;

    // Factor 1: FIRS compliance (weight: 40%)
    const firsCompliance = await this.calculateFIRSCompliance(businessId);
    let firsScore = 50;
    if (firsCompliance.compliant) {
      firsScore = 90;
      if (firsCompliance.onTime) firsScore = 100;
    } else {
      firsScore = 30;
    }

    factors.push({
      name: 'FIRS Compliance',
      value: firsCompliance,
      impact: firsCompliance.compliant ? 'positive' : 'critical'
    });
    totalScore += firsScore * 0.4;

    // Factor 2: Document completeness (weight: 30%)
    const completeness = await this.calculateDocumentCompleteness(businessId);
    let completenessScore = 50;
    if (completeness > 95) completenessScore = 90;
    else if (completeness > 90) completenessScore = 80;
    else if (completeness > 85) completenessScore = 70;
    else if (completeness > 80) completenessScore = 60;
    else completenessScore = 40;

    factors.push({
      name: 'Document Completeness',
      value: `${completeness}%`,
      impact: completeness > 90 ? 'positive' : 'negative',
      threshold: 90
    });
    totalScore += completenessScore * 0.3;

    // Factor 3: Data accuracy (weight: 30%)
    const accuracy = await this.calculateDataAccuracy(businessId);
    let accuracyScore = 50;
    if (accuracy > 98) accuracyScore = 90;
    else if (accuracy > 95) accuracyScore = 80;
    else if (accuracy > 90) accuracyScore = 70;
    else accuracyScore = 50;

    factors.push({
      name: 'Data Accuracy',
      value: `${accuracy}%`,
      impact: accuracy > 95 ? 'positive' : 'negative',
      threshold: 95
    });
    totalScore += accuracyScore * 0.3;

    const finalScore = Math.round(totalScore);

    return {
      score: finalScore,
      weight: 0.15,
      status: this.getStatusFromScore(finalScore),
      factors
    };
  }

  /**
   * Calculate growth health
   */
  private async calculateGrowthHealth(businessId: string): Promise<ComponentScore> {
    const factors = [];
    let totalScore = 0;

    // Factor 1: Revenue growth (weight: 40%)
    const revenueGrowth = await this.calculateRevenueGrowth(businessId);
    let growthScore = 50;
    if (revenueGrowth > 20) growthScore = 90;
    else if (revenueGrowth > 15) growthScore = 80;
    else if (revenueGrowth > 10) growthScore = 70;
    else if (revenueGrowth > 5) growthScore = 60;
    else if (revenueGrowth > 0) growthScore = 50;
    else growthScore = 30;

    factors.push({
      name: 'Revenue Growth',
      value: `${revenueGrowth}%`,
      impact: revenueGrowth > 10 ? 'positive' : 'negative',
      threshold: 10
    });
    totalScore += growthScore * 0.4;

    // Factor 2: Customer acquisition (weight: 30%)
    const acquisition = await this.calculateCustomerAcquisition(businessId);
    let acquisitionScore = 50;
    if (acquisition > 30) acquisitionScore = 90;
    else if (acquisition > 20) acquisitionScore = 80;
    else if (acquisition > 10) acquisitionScore = 70;
    else if (acquisition > 5) acquisitionScore = 60;
    else acquisitionScore = 40;

    factors.push({
      name: 'Customer Acquisition',
      value: `${acquisition}%`,
      impact: acquisition > 10 ? 'positive' : 'negative',
      threshold: 10
    });
    totalScore += acquisitionScore * 0.3;

    // Factor 3: Market share (weight: 30%)
    const marketShare = await this.calculateMarketShare(businessId);
    let shareScore = 50;
    if (marketShare > 20) shareScore = 90;
    else if (marketShare > 10) shareScore = 80;
    else if (marketShare > 5) shareScore = 70;
    else if (marketShare > 2) shareScore = 60;
    else shareScore = 50;

    factors.push({
      name: 'Market Share',
      value: `${marketShare}%`,
      impact: marketShare > 5 ? 'positive' : 'neutral'
    });
    totalScore += shareScore * 0.3;

    const finalScore = Math.round(totalScore);

    return {
      score: finalScore,
      weight: 0.10,
      status: this.getStatusFromScore(finalScore),
      factors
    };
  }

  /**
   * Calculate trends
   */
  private async calculateTrends(businessId: string): Promise<HealthScore['trends']> {
    const now = new Date();
    
    // Get historical scores
    const weekAgo = subDays(now, 7);
    const monthAgo = subMonths(now, 1);
    const quarterAgo = subMonths(now, 3);

    const [weekScore, monthScore, quarterScore] = await Promise.all([
      this.getHistoricalScore(businessId, weekAgo),
      this.getHistoricalScore(businessId, monthAgo),
      this.getHistoricalScore(businessId, quarterAgo)
    ]);

    const currentScore = (await this.calculateHealthScore(businessId)).overall;

    return {
      weekly: currentScore - weekScore,
      monthly: currentScore - monthScore,
      quarterly: currentScore - quarterScore
    };
  }

  /**
   * Get historical health score
   */
  private async getHistoricalScore(businessId: string, date: Date): Promise<number> {
    // In production, this would query stored historical scores
    // Placeholder implementation
    return 70;
  }

  /**
   * Generate alerts based on component scores
   */
  private async generateAlerts(
    businessId: string,
    components: Record<string, ComponentScore>
  ): Promise<HealthAlert[]> {
    const alerts: HealthAlert[] = [];

    for (const [category, component] of Object.entries(components)) {
      if (component.status === 'critical') {
        alerts.push({
          id: `alert-${Date.now()}-${category}`,
          severity: 'critical',
          category,
          message: `${category} health is critical (${component.score}/100)`,
          timestamp: new Date(),
          acknowledged: false,
          actionable: true,
          actionUrl: `/dashboard/health/${category}`
        });
      } else if (component.status === 'warning') {
        alerts.push({
          id: `alert-${Date.now()}-${category}`,
          severity: 'warning',
          category,
          message: `${category} health needs attention (${component.score}/100)`,
          timestamp: new Date(),
          acknowledged: false,
          actionable: true,
          actionUrl: `/dashboard/health/${category}`
        });
      }

      // Check factor-specific alerts
      for (const factor of component.factors) {
        if (factor.impact === 'negative' && factor.threshold) {
          alerts.push({
            id: `factor-${Date.now()}-${factor.name}`,
            severity: 'warning',
            category,
            message: `${factor.name} is below threshold (${factor.value})`,
            timestamp: new Date(),
            acknowledged: false,
            actionable: true,
            threshold: factor.threshold,
            currentValue: typeof factor.value === 'number' ? factor.value : undefined
          });
        }
      }
    }

    return alerts.slice(0, 10); // Limit to 10 most recent alerts
  }

  /**
   * Get benchmark comparisons
   */
  async getBenchmarks(businessId: string): Promise<BenchmarkData[]> {
    const health = await this.calculateHealthScore(businessId);
    const benchmarks: BenchmarkData[] = [];

    // Financial benchmarks
    benchmarks.push({
      metric: 'Profit Margin',
      businessValue: health.components.financial.factors.find(f => f.name === 'Profit Margin')?.value as number || 0,
      industryAverage: 12,
      topPerformer: 25,
      percentile: 65,
      recommendation: 'Consider reviewing pricing strategy to improve margins'
    });

    // Operational benchmarks
    benchmarks.push({
      metric: 'Payment Velocity',
      businessValue: health.components.operational.factors.find(f => f.name === 'Payment Velocity')?.value as number || 0,
      industryAverage: 35,
      topPerformer: 15,
      percentile: 70,
      recommendation: 'Implement automated payment reminders to reduce days'
    });

    // Customer benchmarks
    benchmarks.push({
      metric: 'Customer Retention',
      businessValue: health.components.customer.factors.find(f => f.name === 'Customer Retention')?.value as number || 0,
      industryAverage: 75,
      topPerformer: 90,
      percentile: 55,
      recommendation: 'Develop loyalty program for repeat customers'
    });

    return benchmarks;
  }

  /**
   * Get status from score
   */
  private getStatusFromScore(score: number): 'healthy' | 'warning' | 'critical' {
    if (score >= 70) return 'healthy';
    if (score >= 50) return 'warning';
    return 'critical';
  }

  // Placeholder implementations for metric calculations
  private async analyzeCashFlow(businessId: string): Promise<{ positive: boolean; growth: number }> {
    return { positive: true, growth: 5 };
  }

  private async calculateProfitMargin(businessId: string): Promise<number> {
    return 15.5;
  }

  private async calculateOutstandingRatio(businessId: string): Promise<number> {
    return 0.25;
  }

  private async calculateRevenueStability(businessId: string): Promise<number> {
    return 0.15;
  }

  private async calculatePaymentVelocity(businessId: string): Promise<number> {
    return 28;
  }

  private async calculateInvoiceProcessingTime(businessId: string): Promise<number> {
    return 1.5;
  }

  private async calculateAutomationRate(businessId: string): Promise<number> {
    return 75;
  }

  private async calculateErrorRate(businessId: string): Promise<number> {
    return 2.5;
  }

  private async calculateRetentionRate(businessId: string): Promise<number> {
    return 82;
  }

  private async calculateSatisfactionScore(businessId: string): Promise<number> {
    return 4.2;
  }

  private async calculateRepeatRate(businessId: string): Promise<number> {
    return 35;
  }

  private async calculateFIRSCompliance(businessId: string): Promise<{ compliant: boolean; onTime: boolean }> {
    return { compliant: true, onTime: true };
  }

  private async calculateDocumentCompleteness(businessId: string): Promise<number> {
    return 94;
  }

  private async calculateDataAccuracy(businessId: string): Promise<number> {
    return 97;
  }

  private async calculateRevenueGrowth(businessId: string): Promise<number> {
    return 12.5;
  }

  private async calculateCustomerAcquisition(businessId: string): Promise<number> {
    return 15;
  }

  private async calculateMarketShare(businessId: string): Promise<number> {
    return 3.5;
  }
}

export const businessHealthService = new BusinessHealthService();
