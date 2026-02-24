// src/controllers/v1/admin.controller.ts
import { Request, Response } from 'express';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { piiMask } from '../../middleware/pii-mask';
import { ExcelExportService } from '../../lib/utils/excel-export';

export class AdminController {
  
  /**
   * Get aggregate business intelligence
   * Hidden route: /admin-hidden-route/api/intelligence
   */
  static async getIntelligence(req: Request, res: Response): Promise<void> {
    try {
      const { 
        startDate = new Date(new Date().setMonth(new Date().getMonth() - 1)),
        endDate = new Date(),
        segment,
        region 
      } = req.query;

      // Parallel queries for performance
      const [
        businessMetrics,
        financialMetrics,
        integrationMetrics,
        regulatoryMetrics,
        growthMetrics
      ] = await Promise.all([
        this.getBusinessMetrics(startDate, endDate, segment, region),
        this.getFinancialMetrics(startDate, endDate),
        this.getIntegrationMetrics(),
        this.getRegulatoryMetrics(startDate, endDate),
        this.getGrowthMetrics(startDate, endDate)
      ]);

      const intelligence = {
        summary: {
          totalBusinesses: businessMetrics.total,
          activeBusinesses: businessMetrics.active,
          newBusinesses: businessMetrics.new,
          churnRate: businessMetrics.churnRate,
          mrr: financialMetrics.mrr,
          arr: financialMetrics.arr,
          averageRevenuePerBusiness: financialMetrics.arpb
        },
        businesses: businessMetrics.details,
        financials: financialMetrics,
        integrations: integrationMetrics,
        regulatory: regulatoryMetrics,
        growth: growthMetrics,
        generatedAt: new Date(),
        generatedBy: req.user.email
      };

      // Apply PII masking before sending
      const maskedIntelligence = piiMask(intelligence);

      res.json({
        success: true,
        data: maskedIntelligence
      });

    } catch (error) {
      logger.error('Admin intelligence fetch failed:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch business intelligence'
      });
    }
  }

  /**
   * Export intelligence to Excel
   */
  static async exportIntelligence(req: Request, res: Response): Promise<void> {
    try {
      const data = await AdminController.getIntelligence(req, res);
      
      const excelBuffer = await ExcelExportService.generateReport(data);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=elexsol-intelligence-${new Date().toISOString()}.xlsx`);
      
      res.send(excelBuffer);

    } catch (error) {
      logger.error('Admin export failed:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to export intelligence'
      });
    }
  }

  /**
   * Get business metrics with segmentation
   */
  private static async getBusinessMetrics(
    startDate: any,
    endDate: any,
    segment?: any,
    region?: any
  ): Promise<any> {
    const query = `
      WITH business_stats AS (
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
          COUNT(CASE WHEN created_at >= $1 THEN 1 END) as new,
          COUNT(CASE WHEN status = 'churned' AND updated_at BETWEEN $1 AND $2 THEN 1 END) as churned,
          turnover_band,
          region,
          created_at::date as signup_date
        FROM businesses
        WHERE ($3::text IS NULL OR turnover_band = $3)
          AND ($4::text IS NULL OR region = $4)
        GROUP BY turnover_band, region, created_at::date
      )
      SELECT 
        SUM(total) as total,
        SUM(active) as active,
        SUM(new) as new,
        SUM(churned) as churned,
        CASE WHEN SUM(active) > 0 
          THEN ROUND((SUM(churned)::numeric / SUM(active)::numeric) * 100, 2)
          ELSE 0 
        END as churn_rate,
        json_agg(
          json_build_object(
            'turnoverBand', turnover_band,
            'region', region,
            'count', total,
            'active', active,
            'signupDate', signup_date
          )
        ) as details
      FROM business_stats
    `;

    const result = await db.query(query, [startDate, endDate, segment, region]);
    return result.rows[0];
  }

  /**
   * Get financial metrics
   */
  private static async getFinancialMetrics(startDate: any, endDate: any): Promise<any> {
    const query = `
      WITH monthly_revenue AS (
        SELECT 
          DATE_TRUNC('month', created_at) as month,
          SUM(total_amount) as revenue,
          COUNT(DISTINCT business_id) as active_businesses
        FROM invoices
        WHERE created_at BETWEEN $1 AND $2
          AND payment_status = 'paid'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month DESC
        LIMIT 3
      ),
      current_month AS (
        SELECT * FROM monthly_revenue LIMIT 1
      ),
      previous_month AS (
        SELECT * FROM monthly_revenue OFFSET 1 LIMIT 1
      )
      SELECT 
        ROUND((SELECT revenue FROM current_month)::numeric, 2) as mrr,
        ROUND((SELECT revenue * 12 FROM current_month)::numeric, 2) as arr,
        ROUND(
          (SELECT revenue::numeric / NULLIF(active_businesses::numeric, 0) 
           FROM current_month), 2
        ) as arpb,
        ROUND(
          ((SELECT revenue FROM current_month) - 
           COALESCE((SELECT revenue FROM previous_month), 0))::numeric, 2
        ) as revenue_growth,
        ROUND(
          (SELECT 
            CASE WHEN (SELECT revenue FROM previous_month) > 0 
            THEN ((revenue - (SELECT revenue FROM previous_month))::numeric / 
                  (SELECT revenue FROM previous_month)::numeric) * 100
            ELSE 0 END
           FROM current_month), 2
        ) as growth_percentage
    `;

    const result = await db.query(query, [startDate, endDate]);
    return result.rows[0];
  }

  /**
   * Get integration metrics
   */
  private static async getIntegrationMetrics(): Promise<any> {
    const query = `
      SELECT 
        provider,
        COUNT(*) as total_connections,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (NOW() - last_sync_at)) / 3600
        )::numeric, 2) as avg_hours_since_sync
      FROM account_integrations
      GROUP BY provider
    `;

    const result = await db.query(query);
    
    return {
      byProvider: result.rows,
      total: result.rows.reduce((acc, r) => acc + parseInt(r.total_connections), 0),
      active: result.rows.reduce((acc, r) => acc + parseInt(r.active), 0),
      failed: result.rows.reduce((acc, r) => acc + parseInt(r.failed), 0)
    };
  }

  /**
   * Get regulatory compliance metrics
   */
  private static async getRegulatoryMetrics(startDate: any, endDate: any): Promise<any> {
    const query = `
      SELECT 
        COUNT(*) as total_submissions,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60)::numeric, 2) as avg_processing_minutes,
        COUNT(DISTINCT business_id) as businesses_submitted
      FROM regulatory_logs
      WHERE created_at BETWEEN $1 AND $2
    `;

    const result = await db.query(query, [startDate, endDate]);
    return result.rows[0];
  }

  /**
   * Get growth metrics
   */
  private static async getGrowthMetrics(startDate: any, endDate: any): Promise<any> {
    const query = `
      WITH invoice_stats AS (
        SELECT 
          DATE_TRUNC('week', created_at) as week,
          COUNT(*) as invoice_count,
          SUM(total_amount) as invoice_volume,
          COUNT(DISTINCT business_id) as active_senders,
          COUNT(DISTINCT customer_tin) as unique_customers
        FROM invoices
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY DATE_TRUNC('week', created_at)
        ORDER BY week DESC
      ),
      payment_velocity AS (
        SELECT 
          AVG(EXTRACT(DAY FROM (payment_date - issue_date))) as avg_days_to_payment
        FROM invoices
        WHERE payment_date BETWEEN $1 AND $2
          AND payment_status = 'paid'
      )
      SELECT 
        json_agg(
          json_build_object(
            'week', week,
            'invoices', invoice_count,
            'volume', invoice_volume,
            'activeSenders', active_senders,
            'uniqueCustomers', unique_customers
          ) ORDER BY week
        ) as weekly_trend,
        (SELECT avg_days_to_payment FROM payment_velocity) as avg_payment_velocity
      FROM invoice_stats
    `;

    const result = await db.query(query, [startDate, endDate]);
    return result.rows[0];
  }

  /**
   * Get system health metrics
   */
  static async getSystemHealth(req: Request, res: Response): Promise<void> {
    try {
      // Check database connectivity
      const dbHealth = await db.query('SELECT 1 as health_check');
      
      // Check Redis connectivity
      const redisHealth = await redisConnection.ping();
      
      // Check queue health
      const queueHealth = await this.checkQueueHealth();

      // Get error rates
      const errorRates = await this.getErrorRates();

      res.json({
        success: true,
        data: {
          status: 'operational',
          timestamp: new Date(),
          components: {
            database: {
              status: dbHealth.rows[0] ? 'healthy' : 'unhealthy',
              latency: dbHealth.duration
            },
            redis: {
              status: redisHealth === 'PONG' ? 'healthy' : 'unhealthy',
              latency: redisHealth.duration
            },
            queues: queueHealth,
            api: {
              status: 'healthy',
              errorRate: errorRates.api,
              avgResponseTime: errorRates.responseTime
            },
            webhooks: {
              status: errorRates.webhookFailureRate < 5 ? 'healthy' : 'degraded',
              failureRate: `${errorRates.webhookFailureRate}%`
            }
          }
        }
      });

    } catch (error) {
      logger.error('System health check failed:', error);
      res.status(500).json({
        success: false,
        error: 'System health check failed'
      });
    }
  }

  private static async checkQueueHealth(): Promise<any> {
    const queues = ['webhook-processing', 'integration-sync', 'digest-processing', 'immediate-notifications'];
    const health: Record<string, any> = {};

    for (const queueName of queues) {
      const queue = new Queue(queueName, { connection: redisConnection });
      const counts = await queue.getJobCounts();
      
      health[queueName] = {
        status: counts.waiting + counts.active < 1000 ? 'healthy' : 'degraded',
        waiting: counts.waiting,
        active: counts.active,
        failed: counts.failed,
        delayed: counts.delayed
      };
      
      await queue.close();
    }

    return health;
  }

  private static async getErrorRates(): Promise<any> {
    const result = await db.query(`
      SELECT 
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' THEN 1 END) as hourly_requests,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' AND status >= 500 THEN 1 END) as hourly_errors,
        ROUND(AVG(response_time)::numeric, 2) as avg_response_time,
        COUNT(CASE WHEN webhook_status = 'failed' AND created_at >= NOW() - INTERVAL '1 hour' THEN 1 END) as webhook_failures,
        COUNT(CASE WHEN webhook_status IS NOT NULL AND created_at >= NOW() - INTERVAL '1 hour' THEN 1 END) as total_webhooks
      FROM api_logs
      WHERE created_at >= NOW() - INTERVAL '1 hour'
    `);

    const row = result.rows[0];
    
    return {
      api: row.hourly_requests > 0 
        ? Math.round((row.hourly_errors / row.hourly_requests) * 100) 
        : 0,
      responseTime: row.avg_response_time || 0,
      webhookFailureRate: row.total_webhooks > 0
        ? Math.round((row.webhook_failures / row.total_webhooks) * 100)
        : 0
    };
  }
}
