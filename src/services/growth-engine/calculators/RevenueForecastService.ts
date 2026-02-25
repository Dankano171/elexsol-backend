import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { businessRepository } from '../../repositories/BusinessRepository';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { 
  subMonths, 
  addMonths, 
  differenceInDays,
  format,
  startOfMonth,
  endOfMonth
} from 'date-fns';

export interface RevenueForecast {
  current: {
    month: string;
    actual: number;
    projected: number;
    variance: number;
    confidence: number;
  };
  historical: Array<{
    month: string;
    revenue: number;
    growth: number;
  }>;
  forecast: Array<{
    month: string;
    low: number;
    medium: number;
    high: number;
    confidence: number;
    drivers: string[];
  }>;
  metrics: {
    cagr: number; // Compound Annual Growth Rate
    seasonalFactors: Record<string, number>;
    averageGrowthRate: number;
    volatility: number;
  };
  insights: {
    growthStage: 'accelerating' | 'stable' | 'declining' | 'volatile';
    nextMilestone: { amount: number; date: string } | null;
    risks: string[];
    opportunities: string[];
    recommendations: string[];
  };
}

export class RevenueForecastService {
  private readonly cacheTTL = 7200; // 2 hours

  /**
   * Generate revenue forecast
   */
  async generateForecast(
    businessId: string,
    forecastMonths: number = 6
  ): Promise<RevenueForecast> {
    try {
      const cacheKey = `revenue_forecast:${businessId}:${forecastMonths}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Get historical data (last 12 months)
      const endDate = new Date();
      const startDate = subMonths(endDate, 12);
      
      const invoices = await invoiceRepository.findByDateRange(
        businessId,
        startDate,
        endDate
      );

      // Group by month
      const monthlyData = this.groupRevenueByMonth(invoices);
      
      // Calculate historical metrics
      const historical = this.calculateHistoricalMetrics(monthlyData);
      
      // Calculate forecast
      const forecast = await this.calculateForecast(monthlyData, forecastMonths, businessId);
      
      // Calculate current month
      const currentMonth = format(new Date(), 'yyyy-MM');
      const currentMonthData = monthlyData.find(m => m.month === currentMonth) || {
        month: currentMonth,
        revenue: 0,
        growth: 0
      };

      // Calculate metrics
      const metrics = this.calculateForecastMetrics(monthlyData, forecast);
      
      // Generate insights
      const insights = this.generateInsights(historical, forecast, metrics);

      const result: RevenueForecast = {
        current: {
          month: currentMonth,
          actual: currentMonthData.revenue,
          projected: forecast[0]?.medium || 0,
          variance: forecast[0] ? ((currentMonthData.revenue - forecast[0].medium) / forecast[0].medium) * 100 : 0,
          confidence: forecast[0]?.confidence || 0
        },
        historical,
        forecast,
        metrics,
        insights
      };

      await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(result));

      return result;
    } catch (error) {
      logger.error('Error generating revenue forecast:', error);
      throw error;
    }
  }

  /**
   * Group revenue by month
   */
  private groupRevenueByMonth(invoices: any[]): Array<{ month: string; revenue: number; growth: number }> {
    const monthMap = new Map<string, number>();

    invoices.forEach(inv => {
      const month = format(inv.issue_date, 'yyyy-MM');
      const current = monthMap.get(month) || 0;
      monthMap.set(month, current + inv.total_amount);
    });

    const months = Array.from(monthMap.entries())
      .map(([month, revenue]) => ({ month, revenue, growth: 0 }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Calculate growth rates
    for (let i = 1; i < months.length; i++) {
      const prevRevenue = months[i - 1].revenue;
      if (prevRevenue > 0) {
        months[i].growth = ((months[i].revenue - prevRevenue) / prevRevenue) * 100;
      }
    }

    return months;
  }

  /**
   * Calculate historical metrics
   */
  private calculateHistoricalMetrics(
    monthlyData: Array<{ month: string; revenue: number; growth: number }>
  ): RevenueForecast['historical'] {
    return monthlyData.slice(-12).map((m, i, arr) => ({
      month: m.month,
      revenue: m.revenue,
      growth: i > 0 ? m.growth : 0
    }));
  }

  /**
   * Calculate forecast
   */
  private async calculateForecast(
    monthlyData: Array<{ month: string; revenue: number; growth: number }>,
    forecastMonths: number,
    businessId: string
  ): Promise<RevenueForecast['forecast']> {
    if (monthlyData.length < 3) {
      return this.generateBaselineForecast(forecastMonths);
    }

    // Calculate trends
    const recentMonths = monthlyData.slice(-6);
    const growthRates = recentMonths.map(m => m.growth).filter(g => !isNaN(g));
    
    const avgGrowth = growthRates.length > 0
      ? growthRates.reduce((a, b) => a + b, 0) / growthRates.length
      : 2.5; // Default 2.5% growth

    const volatility = this.calculateVolatility(growthRates);
    
    // Get seasonal factors
    const seasonalFactors = await this.calculateSeasonalFactors(businessId);
    
    const lastRevenue = monthlyData[monthlyData.length - 1].revenue;
    const forecast: RevenueForecast['forecast'] = [];

    for (let i = 1; i <= forecastMonths; i++) {
      const forecastDate = addMonths(new Date(), i);
      const month = format(forecastDate, 'yyyy-MM');
      const monthNum = forecastDate.getMonth();
      
      // Apply seasonal factor
      const seasonalFactor = seasonalFactors[monthNum] || 1.0;
      
      // Calculate base projection
      const baseProjection = lastRevenue * Math.pow(1 + avgGrowth / 100, i) * seasonalFactor;
      
      // Add confidence intervals
      const confidence = Math.max(50, 100 - (i * 10) - (volatility * 5));
      const margin = (100 - confidence) / 100;

      forecast.push({
        month,
        low: Math.max(0, baseProjection * (1 - margin)),
        medium: baseProjection,
        high: baseProjection * (1 + margin),
        confidence,
        drivers: this.identifyRevenueDrivers(i, seasonalFactor, avgGrowth)
      });
    }

    return forecast;
  }

  /**
   * Generate baseline forecast when insufficient data
   */
  private generateBaselineForecast(months: number): RevenueForecast['forecast'] {
    const forecast = [];
    const baseRevenue = 100000; // Default assumption

    for (let i = 1; i <= months; i++) {
      const forecastDate = addMonths(new Date(), i);
      
      forecast.push({
        month: format(forecastDate, 'yyyy-MM'),
        low: baseRevenue * 0.7,
        medium: baseRevenue,
        high: baseRevenue * 1.3,
        confidence: 50,
        drivers: ['Insufficient historical data for accurate forecast']
      });
    }

    return forecast;
  }

  /**
   * Calculate volatility from historical growth rates
   */
  private calculateVolatility(growthRates: number[]): number {
    if (growthRates.length < 2) return 30;

    const mean = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
    const variance = growthRates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / growthRates.length;
    
    return Math.min(50, Math.sqrt(variance));
  }

  /**
   * Calculate seasonal factors
   */
  private async calculateSeasonalFactors(businessId: string): Promise<Record<number, number>> {
    const factors: Record<number, number> = {};
    
    // Get 2 years of data
    const endDate = new Date();
    const startDate = subMonths(endDate, 24);
    
    const invoices = await invoiceRepository.findByDateRange(businessId, startDate, endDate);
    
    if (invoices.length < 12) {
      // Return default factors if insufficient data
      for (let i = 0; i < 12; i++) {
        factors[i] = 1.0;
      }
      return factors;
    }

    // Group by month
    const monthTotals: Record<number, { sum: number; count: number }> = {};
    
    invoices.forEach(inv => {
      const month = inv.issue_date.getMonth();
      if (!monthTotals[month]) {
        monthTotals[month] = { sum: 0, count: 0 };
      }
      monthTotals[month].sum += inv.total_amount;
      monthTotals[month].count++;
    });

    // Calculate average per month
    const monthlyAverages: Record<number, number> = {};
    for (let i = 0; i < 12; i++) {
      if (monthTotals[i] && monthTotals[i].count > 0) {
        monthlyAverages[i] = monthTotals[i].sum / monthTotals[i].count;
      }
    }

    // Calculate overall average
    const allAverages = Object.values(monthlyAverages);
    const overallAvg = allAverages.reduce((a, b) => a + b, 0) / allAverages.length;

    // Calculate factors
    for (let i = 0; i < 12; i++) {
      if (monthlyAverages[i]) {
        factors[i] = monthlyAverages[i] / overallAvg;
      } else {
        factors[i] = 1.0;
      }
    }

    return factors;
  }

  /**
   * Identify revenue drivers for forecast period
   */
  private identifyRevenueDrivers(
    monthOffset: number,
    seasonalFactor: number,
    growthRate: number
  ): string[] {
    const drivers: string[] = [];

    if (seasonalFactor > 1.1) {
      drivers.push('Seasonal high period');
    } else if (seasonalFactor < 0.9) {
      drivers.push('Seasonal low period');
    }

    if (growthRate > 5) {
      drivers.push('Strong growth trend');
    } else if (growthRate < -2) {
      drivers.push('Declining trend');
    }

    if (monthOffset === 1) {
      drivers.push('Short-term forecast');
    } else if (monthOffset > 3) {
      drivers.push('Long-term projection');
    }

    return drivers;
  }

  /**
   * Calculate forecast metrics
   */
  private calculateForecastMetrics(
    historical: Array<{ month: string; revenue: number; growth: number }>,
    forecast: RevenueForecast['forecast']
  ): RevenueForecast['metrics'] {
    // Calculate CAGR
    const firstYearRevenue = historical[0]?.revenue || 0;
    const lastYearRevenue = historical[historical.length - 1]?.revenue || 0;
    const years = historical.length / 12;
    
    const cagr = firstYearRevenue > 0 && years > 0
      ? (Math.pow(lastYearRevenue / firstYearRevenue, 1 / years) - 1) * 100
      : 0;

    // Calculate seasonal factors
    const seasonalFactors: Record<string, number> = {};
    for (let i = 0; i < 12; i++) {
      const monthData = historical.filter(m => {
        const month = parseInt(m.month.split('-')[1]) - 1;
        return month === i;
      });

      if (monthData.length > 0) {
        const avgRevenue = monthData.reduce((sum, m) => sum + m.revenue, 0) / monthData.length;
        const overallAvg = historical.reduce((sum, m) => sum + m.revenue, 0) / historical.length;
        seasonalFactors[i.toString()] = avgRevenue / overallAvg;
      } else {
        seasonalFactors[i.toString()] = 1.0;
      }
    }

    // Calculate average growth rate
    const growthRates = historical.map(m => m.growth).filter(g => !isNaN(g) && isFinite(g));
    const avgGrowthRate = growthRates.length > 0
      ? growthRates.reduce((a, b) => a + b, 0) / growthRates.length
      : 0;

    // Calculate volatility
    const volatility = this.calculateVolatility(growthRates);

    return {
      cagr,
      seasonalFactors,
      averageGrowthRate: avgGrowthRate,
      volatility
    };
  }

  /**
   * Generate insights from forecast
   */
  private generateInsights(
    historical: RevenueForecast['historical'],
    forecast: RevenueForecast['forecast'],
    metrics: RevenueForecast['metrics']
  ): RevenueForecast['insights'] {
    // Determine growth stage
    let growthStage: 'accelerating' | 'stable' | 'declining' | 'volatile' = 'stable';
    
    const recentGrowth = historical.slice(-3).map(m => m.growth);
    const avgRecentGrowth = recentGrowth.reduce((a, b) => a + b, 0) / recentGrowth.length;
    const olderGrowth = historical.slice(-6, -3).map(m => m.growth);
    const avgOlderGrowth = olderGrowth.length > 0 
      ? olderGrowth.reduce((a, b) => a + b, 0) / olderGrowth.length
      : 0;

    if (metrics.volatility > 30) {
      growthStage = 'volatile';
    } else if (avgRecentGrowth > avgOlderGrowth * 1.5) {
      growthStage = 'accelerating';
    } else if (avgRecentGrowth < avgOlderGrowth * 0.5) {
      growthStage = 'declining';
    }

    // Find next milestone
    let nextMilestone: { amount: number; date: string } | null = null;
    const milestones = [1000000, 5000000, 10000000, 50000000, 100000000]; // 1M, 5M, 10M, 50M, 100M
    
    const lastRevenue = historical[historical.length - 1]?.revenue || 0;
    const nextMilestoneAmount = milestones.find(m => m > lastRevenue);
    
    if (nextMilestoneAmount && forecast.length > 0) {
      // Estimate when milestone will be reached
      const monthlyGrowth = metrics.averageGrowthRate / 100;
      const monthsNeeded = Math.log(nextMilestoneAmount / lastRevenue) / Math.log(1 + monthlyGrowth);
      
      if (monthsNeeded <= forecast.length) {
        const milestoneDate = addMonths(new Date(), Math.ceil(monthsNeeded));
        nextMilestone = {
          amount: nextMilestoneAmount,
          date: format(milestoneDate, 'yyyy-MM')
        };
      }
    }

    // Identify risks
    const risks: string[] = [];
    
    if (metrics.volatility > 30) {
      risks.push('High revenue volatility makes forecasting unreliable');
    }
    
    if (growthStage === 'declining') {
      risks.push('Revenue trend is declining - investigate causes');
    }
    
    if (historical.length < 6) {
      risks.push('Limited historical data reduces forecast accuracy');
    }

    // Identify opportunities
    const opportunities: string[] = [];
    
    const seasonalPeaks = Object.entries(metrics.seasonalFactors)
      .filter(([_, factor]) => factor > 1.2)
      .map(([month]) => {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return monthNames[parseInt(month)];
      });

    if (seasonalPeaks.length > 0) {
      opportunities.push(`Peak seasons: ${seasonalPeaks.join(', ')} - prepare marketing campaigns`);
    }

    if (metrics.cagr > 20) {
      opportunities.push('Strong CAGR - consider expansion opportunities');
    }

    // Generate recommendations
    const recommendations: string[] = [];

    if (growthStage === 'declining') {
      recommendations.push('Review pricing strategy and competitive positioning');
      recommendations.push('Analyze customer churn and implement retention programs');
    } else if (growthStage === 'accelerating') {
      recommendations.push('Capitalize on growth momentum - increase marketing spend');
      recommendations.push('Ensure operational capacity can handle projected growth');
    }

    if (metrics.volatility > 30) {
      recommendations.push('Build larger cash reserves to handle revenue fluctuations');
      recommendations.push('Diversify customer base to reduce volatility');
    }

    if (nextMilestone) {
      recommendations.push(`Set goal to reach ₦${(nextMilestone.amount / 1000000).toFixed(1)}M by ${nextMilestone.date}`);
    }

    return {
      growthStage,
      nextMilestone,
      risks,
      opportunities,
      recommendations: recommendations.slice(0, 5)
    };
  }

  /**
   * Export forecast report
   */
  async exportReport(
    businessId: string,
    format: 'pdf' | 'excel' | 'csv' = 'csv'
  ): Promise<Buffer> {
    const forecast = await this.generateForecast(businessId);

    switch (format) {
      case 'csv':
        return this.generateCSVReport(forecast);
      case 'excel':
        return this.generateExcelReport(forecast);
      case 'pdf':
        return this.generatePDFReport(forecast);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Generate CSV report
   */
  private generateCSVReport(forecast: RevenueForecast): Buffer {
    const lines = ['Revenue Forecast Report'];
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    lines.push('Current Month');
    lines.push(`Month,${forecast.current.month}`);
    lines.push(`Actual Revenue,₦${forecast.current.actual.toLocaleString()}`);
    lines.push(`Projected Revenue,₦${forecast.current.projected.toLocaleString()}`);
    lines.push(`Variance,${forecast.current.variance.toFixed(1)}%`);
    lines.push(`Confidence,${forecast.current.confidence}%`);
    lines.push('');

    lines.push('Historical Revenue');
    lines.push('Month,Revenue,Growth %');
    forecast.historical.forEach(h => {
      lines.push(`${h.month},₦${h.revenue.toLocaleString()},${h.growth.toFixed(1)}%`);
    });

    lines.push('');
    lines.push('Forecast');
    lines.push('Month,Low,Medium,High,Confidence');
    forecast.forecast.forEach(f => {
      lines.push(
        `${f.month},₦${f.low.toLocaleString()},₦${f.medium.toLocaleString()},` +
        `₦${f.high.toLocaleString()},${f.confidence}%`
      );
    });

    return Buffer.from(lines.join('\n'));
  }

  /**
   * Generate Excel report
   */
  private async generateExcelReport(forecast: RevenueForecast): Promise<Buffer> {
    // Placeholder for Excel generation
    return Buffer.from('Excel report placeholder');
  }

  /**
   * Generate PDF report
   */
  private async generatePDFReport(forecast: RevenueForecast): Promise<Buffer> {
    // Placeholder for PDF generation
    return Buffer.from('PDF report placeholder');
  }
}

export const revenueForecastService = new RevenueForecastService();
