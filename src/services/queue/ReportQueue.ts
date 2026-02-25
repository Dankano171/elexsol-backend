import { Job } from 'bullmq';
import { queueService } from './QueueService';
import { reportModel } from '../../models/Report';
import { analyticsService } from '../growth-engine/AnalyticsService';
import { cashFlowService } from '../growth-engine/CashFlowService';
import { customerInsightsService } from '../growth-engine/CustomerInsightsService';
import { revenueForecastService } from '../growth-engine/RevenueForecastService';
import { logger } from '../../config/logger';
import { format, addDays } from 'date-fns';

export interface ReportJobData {
  reportId: string;
  businessId: string;
  type: 'analytics' | 'cashflow' | 'customers' | 'revenue' | 'compliance' | 'custom';
  format: 'pdf' | 'excel' | 'csv';
  parameters: Record<string, any>;
  userId?: string;
}

export interface ScheduledReportJobData {
  reportId: string;
  businessId: string;
  scheduleId: string;
  scheduledTime: Date;
}

export class ReportQueue {
  private readonly queueName = 'report-generation';
  private initialized = false;

  /**
   * Initialize report queue
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create queue
    queueService.createQueue({
      name: this.queueName,
      concurrency: 2,
      maxRetries: 2,
      backoff: {
        type: 'exponential',
        delay: 5000
      },
      timeout: 300000 // 5 minutes for report generation
    });

    // Create worker
    queueService.createWorker<ReportJobData>(
      this.queueName,
      this.processReport.bind(this),
      {
        concurrency: 2
      }
    );

    this.initialized = true;
    logger.info('Report queue initialized');
  }

  /**
   * Process report job
   */
  private async processReport(job: Job<ReportJobData>): Promise<any> {
    const { data } = job;

    logger.info('Processing report job', {
      jobId: job.id,
      reportId: data.reportId,
      type: data.type,
      format: data.format
    });

    // Update status to processing
    await reportModel.updateProgress(data.reportId, 10, 'processing');

    try {
      // Generate report data based on type
      let reportData: any;
      let progress = 30;

      switch (data.type) {
        case 'analytics':
          reportData = await this.generateAnalyticsReport(data);
          progress = 80;
          break;
        case 'cashflow':
          reportData = await this.generateCashflowReport(data);
          progress = 80;
          break;
        case 'customers':
          reportData = await this.generateCustomersReport(data);
          progress = 80;
          break;
        case 'revenue':
          reportData = await this.generateRevenueReport(data);
          progress = 80;
          break;
        case 'compliance':
          reportData = await this.generateComplianceReport(data);
          progress = 80;
          break;
        default:
          reportData = await this.generateCustomReport(data);
          progress = 80;
      }

      // Update progress
      await reportModel.updateProgress(data.reportId, progress);

      // Generate file based on format
      const fileData = await this.generateFile(reportData, data.format);
      
      // Store file (in production, upload to S3/MinIO)
      const fileUrl = `https://storage.elexsol.com/reports/${data.reportId}.${data.format}`;
      
      // Mark as completed
      await reportModel.markCompleted(
        data.reportId,
        fileUrl,
        fileData.length,
        this.generateFileHash(fileData)
      );

      logger.info('Report generated successfully', {
        reportId: data.reportId,
        format: data.format,
        size: fileData.length
      });

      return {
        reportId: data.reportId,
        fileUrl,
        format: data.format,
        size: fileData.length
      };
    } catch (error) {
      logger.error('Error generating report:', error);
      await reportModel.markFailed(data.reportId, error.message);
      throw error;
    }
  }

  /**
   * Generate analytics report
   */
  private async generateAnalyticsReport(data: ReportJobData): Promise<any> {
    const { businessId, parameters } = data;
    
    const metrics = await analyticsService.getBusinessMetrics(businessId);
    const velocity = await paymentVelocityService.calculateMetrics(businessId);
    
    return {
      generatedAt: new Date().toISOString(),
      businessId,
      parameters,
      metrics,
      velocity,
      summary: {
        totalRevenue: metrics.revenue.total,
        averagePaymentDays: velocity.overall.averageDays,
        customerCount: metrics.customers.total,
        invoiceCount: metrics.invoices.total
      }
    };
  }

  /**
   * Generate cashflow report
   */
  private async generateCashflowReport(data: ReportJobData): Promise<any> {
    const { businessId, parameters } = data;
    
    const cashflow = await cashFlowService.calculateMetrics(businessId);
    const forecast = await cashFlowService.getForecastChart(businessId);
    
    return {
      generatedAt: new Date().toISOString(),
      businessId,
      parameters,
      cashflow,
      forecast,
      summary: {
        currentBalance: cashflow.current.balance,
        projectedInflow: cashflow.current.projectedInflow,
        daysOfRunway: cashflow.current.daysOfRunway,
        burnRate: cashflow.insights.burnRate
      }
    };
  }

  /**
   * Generate customers report
   */
  private async generateCustomersReport(data: ReportJobData): Promise<any> {
    const { businessId, parameters } = data;
    
    const segments = await customerInsightsService.segmentCustomers(businessId);
    const churn = await customerInsightsService.predictChurn(businessId);
    
    return {
      generatedAt: new Date().toISOString(),
      businessId,
      parameters,
      segments,
      churn: churn.slice(0, 20),
      summary: {
        totalCustomers: segments.reduce((sum, s) => sum + s.metrics.customerCount, 0),
        vipCount: segments.find(s => s.id === 'vip')?.metrics.customerCount || 0,
        atRiskCount: segments.find(s => s.id === 'at_risk')?.metrics.customerCount || 0,
        churnRiskRevenue: churn.reduce((sum, c) => sum + c.estimatedRevenueAtRisk, 0)
      }
    };
  }

  /**
   * Generate revenue report
   */
  private async generateRevenueReport(data: ReportJobData): Promise<any> {
    const { businessId, parameters } = data;
    
    const forecast = await revenueForecastService.generateForecast(businessId);
    
    return {
      generatedAt: new Date().toISOString(),
      businessId,
      parameters,
      forecast,
      summary: {
        currentRevenue: forecast.current.actual,
        projectedRevenue: forecast.current.projected,
        growth: forecast.metrics.averageGrowthRate,
        cagr: forecast.metrics.cagr
      }
    };
  }

  /**
   * Generate compliance report
   */
  private async generateComplianceReport(data: ReportJobData): Promise<any> {
    const { businessId, parameters } = data;
    
    // This would use compliance service
    return {
      generatedAt: new Date().toISOString(),
      businessId,
      parameters,
      summary: {
        compliant: true,
        score: 95,
        issues: []
      }
    };
  }

  /**
   * Generate custom report
   */
  private async generateCustomReport(data: ReportJobData): Promise<any> {
    // For custom reports, parameters would define what to include
    return {
      generatedAt: new Date().toISOString(),
      businessId: data.businessId,
      parameters: data.parameters,
      data: {} // Would be built based on parameters
    };
  }

  /**
   * Generate file in requested format
   */
  private async generateFile(data: any, format: string): Promise<Buffer> {
    switch (format) {
      case 'json':
        return Buffer.from(JSON.stringify(data, null, 2));
      case 'csv':
        return this.generateCSV(data);
      case 'pdf':
        return this.generatePDF(data);
      case 'excel':
        return this.generateExcel(data);
      default:
        return Buffer.from(JSON.stringify(data));
    }
  }

  /**
   * Generate CSV
   */
  private generateCSV(data: any): Buffer {
    // Simplified CSV generation
    const lines: string[] = [];
    
    if (data.summary) {
      lines.push('Summary');
      Object.entries(data.summary).forEach(([key, value]) => {
        lines.push(`${key},${value}`);
      });
      lines.push('');
    }

    return Buffer.from(lines.join('\n'));
  }

  /**
   * Generate PDF (placeholder)
   */
  private generatePDF(data: any): Buffer {
    // In production, use PDFKit or similar
    return Buffer.from('PDF content placeholder');
  }

  /**
   * Generate Excel (placeholder)
   */
  private generateExcel(data: any): Buffer {
    // In production, use ExcelJS or similar
    return Buffer.from('Excel content placeholder');
  }

  /**
   * Generate file hash
   */
  private generateFileHash(data: Buffer): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Add report to queue
   */
  async addToQueue(data: ReportJobData, delay?: number): Promise<Job<ReportJobData>> {
    await this.ensureInitialized();

    return queueService.addJob<ReportJobData>(
      this.queueName,
      `report-${data.type}`,
      data,
      {
        jobId: `report-${data.reportId}`,
        delay,
        attempts: 2
      }
    );
  }

  /**
   * Schedule recurring report
   */
  async scheduleReport(data: ScheduledReportJobData): Promise<Job<ScheduledReportJobData>> {
    await this.ensureInitialized();

    const delay = data.scheduledTime.getTime() - Date.now();

    return queueService.addJob<ScheduledReportJobData>(
      this.queueName,
      'scheduled-report',
      data,
      {
        jobId: `scheduled-${data.scheduleId}`,
        delay: Math.max(0, delay),
        attempts: 3
      }
    );
  }

  /**
   * Process scheduled reports
   */
  async processScheduledReports(): Promise<void> {
    await this.ensureInitialized();

    // This would query for reports that need to be generated
    // Placeholder implementation
    logger.info('Processing scheduled reports');
  }

  /**
   * Get queue metrics
   */
  async getMetrics(): Promise<any> {
    await this.ensureInitialized();
    return queueService.getMetrics(this.queueName);
  }

  /**
   * Get job status
   */
  async getJobStatus(reportId: string): Promise<any> {
    await this.ensureInitialized();

    const jobId = `report-${reportId}`;
    const job = await queueService.getJob(this.queueName, jobId);

    if (!job) return null;

    const state = await job.getState();

    return {
      jobId: job.id,
      status: state,
      attempts: job.attemptsMade,
      error: job.failedReason,
      result: job.returnvalue
    };
  }

  /**
   * Ensure queue is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

export const reportQueue = new ReportQueue();
