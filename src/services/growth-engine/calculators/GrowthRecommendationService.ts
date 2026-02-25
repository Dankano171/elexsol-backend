import { businessHealthService } from './BusinessHealthService';
import { paymentVelocityService } from './PaymentVelocityService';
import { cashFlowService } from './CashFlowService';
import { customerInsightsService } from './CustomerInsightsService';
import { revenueForecastService } from './RevenueForecastService';
import { performanceMetricsService } from './PerformanceMetricsService';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';

export interface Recommendation {
  id: string;
  category: 'revenue' | 'cashflow' | 'customers' | 'operations' | 'compliance';
  priority: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  impact: {
    type: 'financial' | 'efficiency' | 'risk' | 'growth';
    value?: number;
    unit?: string;
    timeframe: 'immediate' | 'short' | 'medium' | 'long';
  };
  effort: 'low' | 'medium' | 'high';
  roi?: number;
  steps: string[];
  resources?: string[];
  kpis: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'dismissed';
  dueDate?: Date;
  assignedTo?: string;
  createdAt: Date;
  expiresAt?: Date;
}

export interface GrowthOpportunity {
  id: string;
  type: 'upsell' | 'cross_sell' | 'new_market' | 'partnership' | 'product';
  title: string;
  description: string;
  potentialRevenue: number;
  confidence: number;
  prerequisites: string[];
  timeframe: string;
}

export class GrowthRecommendationService {
  private readonly cacheTTL = 3600; // 1 hour

  /**
   * Generate growth recommendations
   */
  async generateRecommendations(businessId: string): Promise<Recommendation[]> {
    try {
      const cacheKey = `recommendations:${businessId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Gather data from all services
      const [
        health,
        velocity,
        cashflow,
        insights,
        forecast,
        performance
      ] = await Promise.all([
        businessHealthService.calculateHealthScore(businessId),
        paymentVelocityService.calculateMetrics(businessId),
        cashFlowService.calculateMetrics(businessId),
        customerInsightsService.segmentCustomers(businessId),
        revenueForecastService.generateForecast(businessId),
        performanceMetricsService.getMetrics(businessId)
      ]);

      const recommendations: Recommendation[] = [];

      // Generate recommendations based on insights
      recommendations.push(
        ...this.generateRevenueRecommendations(forecast, performance),
        ...this.generateCashflowRecommendations(cashflow, velocity),
        ...this.generateCustomerRecommendations(insights, health),
        ...this.generateOperationsRecommendations(performance, velocity),
        ...this.generateComplianceRecommendations(health)
      );

      // Sort by priority and impact
      const sorted = this.sortRecommendations(recommendations);

      await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(sorted));

      return sorted;
    } catch (error) {
      logger.error('Error generating recommendations:', error);
      throw error;
    }
  }

  /**
   * Generate revenue-focused recommendations
   */
  private generateRevenueRecommendations(
    forecast: any,
    performance: any
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Check revenue growth
    if (forecast.metrics.averageGrowthRate < 5) {
      recommendations.push({
        id: `rev-${Date.now()}-1`,
        category: 'revenue',
        priority: 'high',
        title: 'Boost Revenue Growth',
        description: 'Your revenue growth is below industry average. Consider implementing a customer acquisition campaign.',
        impact: {
          type: 'financial',
          value: forecast.current.projected * 0.1,
          unit: 'NGN',
          timeframe: 'medium'
        },
        effort: 'medium',
        roi: 150,
        steps: [
          'Analyze current marketing channels',
          'Identify high-performing customer segments',
          'Develop targeted acquisition campaigns',
          'Set up conversion tracking',
          'Launch and monitor campaign performance'
        ],
        resources: ['Marketing budget', 'Campaign management tools'],
        kpis: ['Customer acquisition cost', 'Conversion rate', 'Revenue growth'],
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      });
    }

    // Check seasonal opportunities
    const seasonalPeaks = Object.entries(forecast.metrics.seasonalFactors)
      .filter(([_, factor]) => factor > 1.2)
      .map(([month]) => parseInt(month));

    if (seasonalPeaks.length > 0) {
      const nextPeak = seasonalPeaks[0];
      const peakMonth = new Date();
      peakMonth.setMonth(nextPeak);

      recommendations.push({
        id: `rev-${Date.now()}-2`,
        category: 'revenue',
        priority: 'medium',
        title: 'Prepare for Seasonal Peak',
        description: `Your business typically performs well in ${peakMonth.toLocaleString('default', { month: 'long' })}. Start preparing now.`,
        impact: {
          type: 'financial',
          value: forecast.historical[forecast.historical.length - 1]?.revenue * 1.2,
          unit: 'NGN',
          timeframe: 'short'
        },
        effort: 'low',
        roi: 200,
        steps: [
          'Increase inventory levels',
          'Schedule marketing campaigns',
          'Ensure adequate staffing',
          'Prepare promotional materials',
          'Set up automated follow-ups'
        ],
        kpis: ['Peak revenue', 'Conversion rate', 'Customer satisfaction'],
        status: 'pending',
        createdAt: new Date(),
        dueDate: peakMonth
      });
    }

    return recommendations;
  }

  /**
   * Generate cashflow-focused recommendations
   */
  private generateCashflowRecommendations(cashflow: any, velocity: any): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Check runway
    if (cashflow.current.daysOfRunway < 90) {
      recommendations.push({
        id: `cash-${Date.now()}-1`,
        category: 'cashflow',
        priority: 'critical',
        title: 'Extend Cash Runway',
        description: `Your cash runway is only ${cashflow.current.daysOfRunway} days. Take immediate action to improve liquidity.`,
        impact: {
          type: 'financial',
          value: cashflow.current.daysOfRunway * 100000,
          unit: 'NGN',
          timeframe: 'immediate'
        },
        effort: 'high',
        steps: [
          'Review and reduce non-essential expenses',
          'Accelerate accounts receivable',
          'Consider invoice factoring',
          'Negotiate extended payment terms with suppliers',
          'Explore short-term financing options'
        ],
        resources: ['Financial advisor', 'Bank relationships'],
        kpis: ['Days of runway', 'Burn rate', 'Working capital'],
        status: 'pending',
        createdAt: new Date()
      });
    }

    // Check payment velocity
    if (velocity.overall.averageDays > 45) {
      recommendations.push({
        id: `cash-${Date.now()}-2`,
        category: 'cashflow',
        priority: 'high',
        title: 'Improve Payment Velocity',
        description: `Customers take an average of ${velocity.overall.averageDays} days to pay. Implement strategies to speed up payments.`,
        impact: {
          type: 'financial',
          value: cashflow.current.balance * 0.15,
          unit: 'NGN',
          timeframe: 'short'
        },
        effort: 'medium',
        roi: 300,
        steps: [
          'Implement automated payment reminders',
          'Offer early payment discounts',
          'Review credit terms for slow-paying customers',
          'Enable multiple payment methods',
          'Consider requiring deposits for large orders'
        ],
        resources: ['Payment processing tools', 'Customer service team'],
        kpis: ['Days sales outstanding', 'Payment velocity', 'Late payment rate'],
        status: 'pending',
        createdAt: new Date()
      });
    }

    // Check outstanding balance
    if (cashflow.payments?.outstanding > cashflow.current.balance * 0.5) {
      recommendations.push({
        id: `cash-${Date.now()}-3`,
        category: 'cashflow',
        priority: 'high',
        title: 'Reduce Outstanding Receivables',
        description: 'High outstanding balance is tying up working capital. Focus on collections.',
        impact: {
          type: 'financial',
          value: cashflow.payments.outstanding * 0.3,
          unit: 'NGN',
          timeframe: 'short'
        },
        effort: 'medium',
        steps: [
          'Identify largest outstanding invoices',
          'Contact customers with overdue payments',
          'Offer payment plans for large balances',
          'Consider sending to collections agency',
          'Write off uncollectible amounts'
        ],
        resources: ['Collections team', 'Legal counsel'],
        kpis: ['Outstanding balance', 'Collection rate', 'Bad debt expense'],
        status: 'pending',
        createdAt: new Date()
      });
    }

    return recommendations;
  }

  /**
   * Generate customer-focused recommendations
   */
  private generateCustomerRecommendations(insights: any, health: any): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Check churn risk
    const atRiskSegment = insights.find((s: any) => s.id === 'at_risk');
    if (atRiskSegment && atRiskSegment.metrics.customerCount > 10) {
      recommendations.push({
        id: `cust-${Date.now()}-1`,
        category: 'customers',
        priority: 'high',
        title: 'Retain At-Risk Customers',
        description: `${atRiskSegment.metrics.customerCount} customers are at risk of churning. Implement retention strategies.`,
        impact: {
          type: 'financial',
          value: atRiskSegment.metrics.totalRevenue * 0.25,
          unit: 'NGN',
          timeframe: 'medium'
        },
        effort: 'medium',
        roi: 400,
        steps: [
          'Segment at-risk customers by reason',
          'Create personalized re-engagement campaigns',
          'Offer loyalty incentives',
          'Conduct exit interviews',
          'Implement feedback loop'
        ],
        resources: ['Customer success team', 'Marketing automation'],
        kpis: ['Churn rate', 'Customer retention', 'Re-engagement rate'],
        status: 'pending',
        createdAt: new Date()
      });
    }

    // Upsell opportunities
    const vipSegment = insights.find((s: any) => s.id === 'vip');
    if (vipSegment && vipSegment.metrics.customerCount > 0) {
      recommendations.push({
        id: `cust-${Date.now()}-2`,
        category: 'customers',
        priority: 'medium',
        title: 'Expand VIP Customer Program',
        description: `Your ${vipSegment.metrics.customerCount} VIP customers represent significant growth potential.`,
        impact: {
          type: 'financial',
          value: vipSegment.metrics.totalRevenue * 0.2,
          unit: 'NGN',
          timeframe: 'short'
        },
        effort: 'low',
        roi: 500,
        steps: [
          'Create exclusive VIP offers',
          'Develop referral program',
          'Schedule regular business reviews',
          'Offer premium support options',
          'Gather feedback for product improvements'
        ],
        resources: ['Account managers', 'Premium products/services'],
        kpis: ['VIP revenue growth', 'Referral rate', 'Customer satisfaction'],
        status: 'pending',
        createdAt: new Date()
      });
    }

    return recommendations;
  }

  /**
   * Generate operations-focused recommendations
   */
  private generateOperationsRecommendations(performance: any, velocity: any): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Check invoice processing time
    if (performance.operational.invoiceProcessingTime > 4) {
      recommendations.push({
        id: `ops-${Date.now()}-1`,
        category: 'operations',
        priority: 'medium',
        title: 'Streamline Invoice Processing',
        description: 'Invoice processing time is higher than industry average. Automate to improve efficiency.',
        impact: {
          type: 'efficiency',
          value: 50,
          unit: 'hours/month',
          timeframe: 'short'
        },
        effort: 'low',
        roi: 200,
        steps: [
          'Enable automated invoice generation',
          'Set up invoice templates',
          'Implement approval workflows',
          'Integrate with accounting software',
          'Train staff on new processes'
        ],
        resources: ['Automation tools', 'Training materials'],
        kpis: ['Processing time', 'Error rate', 'Staff productivity'],
        status: 'pending',
        createdAt: new Date()
      });
    }

    // Check integration health
    if (performance.operational.integrationSyncTime > 10) {
      recommendations.push({
        id: `ops-${Date.now()}-2`,
        category: 'operations',
        priority: 'medium',
        title: 'Optimize Integration Performance',
        description: 'Integration sync times are slow. Review and optimize your connected services.',
        impact: {
          type: 'efficiency',
          value: 20,
          unit: 'hours/month',
          timeframe: 'medium'
        },
        effort: 'medium',
        steps: [
          'Audit current integrations',
          'Remove unused connections',
          'Update to latest API versions',
          'Implement error handling',
          'Monitor sync performance'
        ],
        resources: ['Technical team', 'API documentation'],
        kpis: ['Sync time', 'Error rate', 'Data consistency'],
        status: 'pending',
        createdAt: new Date()
      });
    }

    return recommendations;
  }

  /**
   * Generate compliance-focused recommendations
   */
  private generateComplianceRecommendations(health: any): Recommendation[] {
    const recommendations: Recommendation[] = [];

    if (health.components.compliance.status === 'warning') {
      recommendations.push({
        id: `comp-${Date.now()}-1`,
        category: 'compliance',
        priority: 'critical',
        title: 'Address Compliance Gaps',
        description: 'Compliance health is below target. Review and address regulatory requirements.',
        impact: {
          type: 'risk',
          timeframe: 'immediate'
        },
        effort: 'high',
        steps: [
          'Review FIRS submission status',
          'Audit document completeness',
          'Verify data accuracy',
          'Update compliance calendar',
          'Schedule compliance training'
        ],
        resources: ['Compliance officer', 'Legal counsel'],
        kpis: ['Compliance score', 'FIRS approval rate', 'Audit findings'],
        status: 'pending',
        createdAt: new Date()
      });
    }

    return recommendations;
  }

  /**
   * Sort recommendations by priority and impact
   */
  private sortRecommendations(recommendations: Recommendation[]): Recommendation[] {
    const priorityWeight = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1
    };

    return recommendations.sort((a, b) => {
      // Sort by priority first
      if (priorityWeight[a.priority] !== priorityWeight[b.priority]) {
        return priorityWeight[b.priority] - priorityWeight[a.priority];
      }
      
      // Then by ROI (if available)
      const aRoi = a.roi || 0;
      const bRoi = b.roi || 0;
      if (aRoi !== bRoi) {
        return bRoi - aRoi;
      }
      
      // Then by effort (lower effort first for same ROI)
      const effortWeight = { low: 1, medium: 2, high: 3 };
      return effortWeight[a.effort] - effortWeight[b.effort];
    });
  }

  /**
   * Identify growth opportunities
   */
  async identifyOpportunities(businessId: string): Promise<GrowthOpportunity[]> {
    const opportunities: GrowthOpportunity[] = [];

    // Analyze customer segments for upsell opportunities
    const segments = await customerInsightsService.segmentCustomers(businessId);
    const vipSegment = segments.find(s => s.id === 'vip');
    
    if (vipSegment && vipSegment.metrics.customerCount > 5) {
      opportunities.push({
        id: `opp-${Date.now()}-1`,
        type: 'upsell',
        title: 'Premium Tier Upsell',
        description: 'Offer premium features to existing VIP customers',
        potentialRevenue: vipSegment.metrics.totalRevenue * 0.3,
        confidence: 75,
        prerequisites: ['Develop premium features', 'Train sales team'],
        timeframe: '3-6 months'
      });
    }

    // Look for cross-sell opportunities
    opportunities.push({
      id: `opp-${Date.now()}-2`,
      type: 'cross_sell',
      title: 'Product Bundle Offering',
      description: 'Create bundled packages combining popular services',
      potentialRevenue: 500000,
      confidence: 60,
      prerequisites: ['Product bundling strategy', 'Pricing analysis'],
      timeframe: '2-3 months'
    });

    // Consider new markets
    opportunities.push({
      id: `opp-${Date.now()}-3`,
      type: 'new_market',
      title: 'Regional Expansion',
      description: 'Expand services to new geographic regions',
      potentialRevenue: 2000000,
      confidence: 45,
      prerequisites: ['Market research', 'Local partnerships', 'Regulatory compliance'],
      timeframe: '6-12 months'
    });

    return opportunities;
  }

  /**
   * Track recommendation progress
   */
  async trackProgress(
    businessId: string,
    recommendationId: string,
    status: Recommendation['status'],
    notes?: string
  ): Promise<void> {
    const key = `recommendation_progress:${businessId}:${recommendationId}`;
    await redis.setex(key, 86400 * 30, JSON.stringify({
      status,
      notes,
      updatedAt: new Date(),
      history: await this.getProgressHistory(businessId, recommendationId)
    }));
  }

  /**
   * Get progress history
   */
  private async getProgressHistory(businessId: string, recommendationId: string): Promise<any[]> {
    const key = `recommendation_progress:${businessId}:${recommendationId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data).history || [] : [];
  }
}

export const growthRecommendationService = new GrowthRecommendationService();
