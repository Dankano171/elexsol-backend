import { Request, Response } from 'express';
import { analyticsService } from '../../services/growth-engine/AnalyticsService';
import { paymentVelocityService } from '../../services/growth-engine/PaymentVelocityService';
import { cashFlowService } from '../../services/growth-engine/CashFlowService';
import { customerInsightsService } from '../../services/growth-engine/CustomerInsightsService';
import { revenueForecastService } from '../../services/growth-engine/RevenueForecastService';
import { businessHealthService } from '../../services/growth-engine/BusinessHealthService';
import { performanceMetricsService } from '../../services/growth-engine/PerformanceMetricsService';
import { growthRecommendationService } from '../../services/growth-engine/GrowthRecommendationService';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class AnalyticsController {
  /**
   * Get business metrics dashboard
   */
  async getDashboard(req: Request, res: Response): Promise<void> {
    try {
      const metrics = await analyticsService.getBusinessMetrics(req.user.business_id);

      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      logger.error('Get dashboard error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get payment velocity
   */
  async getPaymentVelocity(req: Request, res: Response): Promise<void> {
    try {
      const { days = 90 } = req.query;

      const velocity = await paymentVelocityService.calculateMetrics(
        req.user.business_id,
        Number(days)
      );

      res.json({
        success: true,
        data: velocity
      });
    } catch (error) {
      logger.error('Get payment velocity error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get cash flow metrics
   */
  async getCashFlow(req: Request, res: Response): Promise<void> {
    try {
      const { months = 12 } = req.query;

      const cashflow = await cashFlowService.calculateMetrics(
        req.user.business_id,
        Number(months)
      );

      res.json({
        success: true,
        data: cashflow
      });
    } catch (error) {
      logger.error('Get cash flow error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get cash flow forecast
   */
  async getCashFlowForecast(req: Request, res: Response): Promise<void> {
    try {
      const forecast = await cashFlowService.getForecastChart(req.user.business_id);

      res.json({
        success: true,
        data: forecast
      });
    } catch (error) {
      logger.error('Get cash flow forecast error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get cash flow alerts
   */
  async getCashFlowAlerts(req: Request, res: Response): Promise<void> {
    try {
      const alerts = await cashFlowService.getAlerts(req.user.business_id);

      res.json({
        success: true,
        data: alerts
      });
    } catch (error) {
      logger.error('Get cash flow alerts error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get customer insights
   */
  async getCustomerInsights(req: Request, res: Response): Promise<void> {
    try {
      const { customerTin } = req.params;

      const insights = await customerInsightsService.getCustomerHealthScore(
        req.user.business_id,
        customerTin
      );

      res.json({
        success: true,
        data: insights
      });
    } catch (error) {
      logger.error('Get customer insights error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get customer segments
   */
  async getCustomerSegments(req: Request, res: Response): Promise<void> {
    try {
      const segments = await customerInsightsService.segmentCustomers(
        req.user.business_id
      );

      res.json({
        success: true,
        data: segments
      });
    } catch (error) {
      logger.error('Get customer segments error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get churn predictions
   */
  async getChurnPredictions(req: Request, res: Response): Promise<void> {
    try {
      const predictions = await customerInsightsService.predictChurn(
        req.user.business_id
      );

      res.json({
        success: true,
        data: predictions
      });
    } catch (error) {
      logger.error('Get churn predictions error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get revenue forecast
   */
  async getRevenueForecast(req: Request, res: Response): Promise<void> {
    try {
      const { months = 6 } = req.query;

      const forecast = await revenueForecastService.generateForecast(
        req.user.business_id,
        Number(months)
      );

      res.json({
        success: true,
        data: forecast
      });
    } catch (error) {
      logger.error('Get revenue forecast error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get business health score
   */
  async getHealthScore(req: Request, res: Response): Promise<void> {
    try {
      const health = await businessHealthService.calculateHealthScore(
        req.user.business_id
      );

      res.json({
        success: true,
        data: health
      });
    } catch (error) {
      logger.error('Get health score error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get benchmarks
   */
  async getBenchmarks(req: Request, res: Response): Promise<void> {
    try {
      const benchmarks = await businessHealthService.getBenchmarks(
        req.user.business_id
      );

      res.json({
        success: true,
        data: benchmarks
      });
    } catch (error) {
      logger.error('Get benchmarks error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get performance metrics
   */
  async getPerformanceMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { period = 'month' } = req.query;

      const metrics = await performanceMetricsService.getMetrics(
        req.user.business_id,
        period as any
      );

      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      logger.error('Get performance metrics error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get KPIs
   */
  async getKPIs(req: Request, res: Response): Promise<void> {
    try {
      const metrics = await performanceMetricsService.getMetrics(
        req.user.business_id,
        'month'
      );

      res.json({
        success: true,
        data: metrics.kpis
      });
    } catch (error) {
      logger.error('Get KPIs error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get growth recommendations
   */
  async getRecommendations(req: Request, res: Response): Promise<void> {
    try {
      const recommendations = await growthRecommendationService.generateRecommendations(
        req.user.business_id
      );

      res.json({
        success: true,
        data: recommendations
      });
    } catch (error) {
      logger.error('Get recommendations error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get growth opportunities
   */
  async getOpportunities(req: Request, res: Response): Promise<void> {
    try {
      const opportunities = await growthRecommendationService.identifyOpportunities(
        req.user.business_id
      );

      res.json({
        success: true,
        data: opportunities
      });
    } catch (error) {
      logger.error('Get opportunities error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get revenue by customer
   */
  async getRevenueByCustomer(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 10 } = req.query;

      const data = await analyticsService.getRevenueByCustomer(
        req.user.business_id,
        Number(limit)
      );

      res.json({
        success: true,
        data
      });
    } catch (error) {
      logger.error('Get revenue by customer error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Export analytics report
   */
  async exportReport(req: Request, res: Response): Promise<void> {
    try {
      const { format = 'csv', fromDate, toDate } = req.query;

      const buffer = await analyticsService.exportReport(
        req.user.business_id,
        fromDate ? new Date(fromDate as string) : new Date(new Date().setMonth(new Date().getMonth() - 1)),
        toDate ? new Date(toDate as string) : new Date(),
        format as any
      );

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=analytics-${new Date().toISOString()}.${format}`);
      res.send(buffer);
    } catch (error) {
      logger.error('Export report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Track recommendation progress
   */
  async trackRecommendation(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, notes } = req.body;

      await growthRecommendationService.trackProgress(
        req.user.business_id,
        id,
        status,
        notes
      );

      res.json({
        success: true,
        message: 'Progress updated'
      });
    } catch (error) {
      logger.error('Track recommendation error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const analyticsController = new AnalyticsController();
