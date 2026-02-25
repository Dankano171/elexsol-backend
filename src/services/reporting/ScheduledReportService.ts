import { reportModel } from '../../models/Report';
import { reportGeneratorService } from './ReportGeneratorService';
import { notificationService } from '../notification/NotificationService';
import { reportQueue } from '../queue/ReportQueue';
import { logger } from '../../config/logger';
import { CronJob } from 'cron';
import { format, addDays, addWeeks, addMonths, setHours, setMinutes } from 'date-fns';

export interface ScheduledReport {
  id: string;
  businessId: string;
  name: string;
  type: string;
  format: 'pdf' | 'excel' | 'csv';
  schedule: {
    frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly';
    dayOfWeek?: number;
    dayOfMonth?: number;
    time: string; // HH:mm format
  };
  parameters: Record<string, any>;
  recipients: string[];
  lastSent?: Date;
  nextRun: Date;
  enabled: boolean;
}

export class ScheduledReportService {
  private jobs: Map<string, CronJob> = new Map();

  /**
   * Initialize scheduled reports
   */
  async initialize(): Promise<void> {
    try {
      // Load all enabled scheduled reports
      const reports = await reportModel.find({
        is_scheduled: true,
        status: 'active'
      });

      for (const report of reports) {
        await this.scheduleReport(report);
      }

      logger.info(`Scheduled reports initialized: ${this.jobs.size}`);
    } catch (error) {
      logger.error('Error initializing scheduled reports:', error);
    }
  }

  /**
   * Schedule a report
   */
  async scheduleReport(report: any): Promise<void> {
    try {
      // Cancel existing job if any
      await this.cancelReport(report.id);

      const schedule = report.schedule_config;
      const cronExpression = this.generateCronExpression(schedule);
      
      const job = new CronJob(
        cronExpression,
        async () => {
          await this.executeReport(report);
        },
        null,
        true,
        'Africa/Lagos' // Nigerian timezone
      );

      this.jobs.set(report.id, job);

      // Calculate next run time
      const nextRun = this.calculateNextRun(schedule);
      
      await reportModel.update(report.id, {
        next_run: nextRun
      });

      logger.info(`Report scheduled: ${report.name}`, {
        reportId: report.id,
        cron: cronExpression,
        nextRun
      });
    } catch (error) {
      logger.error('Error scheduling report:', error);
    }
  }

  /**
   * Execute scheduled report
   */
  private async executeReport(report: any): Promise<void> {
    try {
      logger.info('Executing scheduled report', {
        reportId: report.id,
        reportName: report.name
      });

      // Generate report
      const reportData = await reportGeneratorService.generateReport({
        id: report.id,
        businessId: report.business_id,
        name: report.name,
        type: report.type,
        format: report.format,
        parameters: report.parameters
      });

      // Export to file
      const fileBuffer = await reportGeneratorService.exportReport(
        reportData,
        report.format
      );

      // Store report (in production, upload to cloud storage)
      const fileUrl = `https://storage.elexsol.com/reports/scheduled/${report.id}/${format(new Date(), 'yyyy-MM-dd')}.${report.format}`;

      // Update report record
      await reportModel.update(report.id, {
        last_sent: new Date(),
        next_run: this.calculateNextRun(report.schedule_config)
      });

      // Send to recipients
      await this.sendReportToRecipients(report, fileUrl, reportData);

      logger.info('Scheduled report executed successfully', {
        reportId: report.id
      });
    } catch (error) {
      logger.error('Error executing scheduled report:', error);
      
      // Log failure but don't throw - prevent cron job from stopping
      await reportModel.logError(report.id, error.message);
    }
  }

  /**
   * Send report to recipients
   */
  private async sendReportToRecipients(
    report: any,
    fileUrl: string,
    reportData: any
  ): Promise<void> {
    const recipients = report.schedule_config?.recipients || [];

    for (const recipient of recipients) {
      await notificationService.send({
        businessId: report.business_id,
        type: 'success',
        title: `Scheduled Report: ${report.name}`,
        body: `Your scheduled report for ${format(new Date(), 'MMMM d, yyyy')} is ready.`,
        data: {
          reportId: report.id,
          reportName: report.name,
          fileUrl,
          period: {
            from: reportData.metadata.period.from,
            to: reportData.metadata.period.to
          },
          summary: reportData.summary
        },
        channels: ['email'],
        priority: 'medium'
      });
    }
  }

  /**
   * Generate cron expression from schedule
   */
  private generateCronExpression(schedule: any): string {
    const [hour, minute] = schedule.time.split(':').map(Number);

    switch (schedule.frequency) {
      case 'daily':
        return `${minute} ${hour} * * *`;
      
      case 'weekly':
        const dayOfWeek = schedule.dayOfWeek || 1; // Default Monday
        return `${minute} ${hour} * * ${dayOfWeek}`;
      
      case 'monthly':
        const dayOfMonth = schedule.dayOfMonth || 1;
        return `${minute} ${hour} ${dayOfMonth} * *`;
      
      case 'quarterly':
        // Run on first day of Jan, Apr, Jul, Oct
        return `${minute} ${hour} 1 1,4,7,10 *`;
      
      default:
        throw new Error(`Unsupported frequency: ${schedule.frequency}`);
    }
  }

  /**
   * Calculate next run time
   */
  private calculateNextRun(schedule: any): Date {
    const [hour, minute] = schedule.time.split(':').map(Number);
    let next = new Date();
    next = setHours(next, hour);
    next = setMinutes(next, minute);

    switch (schedule.frequency) {
      case 'daily':
        if (next <= new Date()) {
          next = addDays(next, 1);
        }
        break;
      
      case 'weekly':
        const targetDay = schedule.dayOfWeek || 1;
        while (next.getDay() !== targetDay || next <= new Date()) {
          next = addDays(next, 1);
        }
        break;
      
      case 'monthly':
        const targetDate = schedule.dayOfMonth || 1;
        next.setDate(targetDate);
        if (next <= new Date()) {
          next = addMonths(next, 1);
        }
        break;
      
      case 'quarterly':
        const month = next.getMonth();
        const quarter = Math.floor(month / 3);
        next.setMonth(quarter * 3, 1);
        if (next <= new Date()) {
          next = addMonths(next, 3);
        }
        break;
    }

    return next;
  }

  /**
   * Cancel scheduled report
   */
  async cancelReport(reportId: string): Promise<void> {
    const job = this.jobs.get(reportId);
    if (job) {
      job.stop();
      this.jobs.delete(reportId);
      logger.info(`Scheduled report cancelled: ${reportId}`);
    }
  }

  /**
   * Update scheduled report
   */
  async updateReport(report: any): Promise<void> {
    await this.cancelReport(report.id);
    await this.scheduleReport(report);
  }

  /**
   * Pause scheduled report
   */
  async pauseReport(reportId: string): Promise<void> {
    await this.cancelReport(reportId);
    await reportModel.update(reportId, {
      status: 'paused'
    });
  }

  /**
   * Resume scheduled report
   */
  async resumeReport(reportId: string): Promise<void> {
    const report = await reportModel.findById(reportId);
    if (report) {
      report.status = 'active';
      await this.scheduleReport(report);
    }
  }

  /**
   * Get upcoming reports
   */
  async getUpcomingReports(
    businessId: string,
    days: number = 7
  ): Promise<ScheduledReport[]> {
    const reports = await reportModel.find({
      business_id: businessId,
      is_scheduled: true,
      status: 'active'
    });

    const cutoff = addDays(new Date(), days);
    
    return reports
      .filter(r => r.next_run && r.next_run <= cutoff)
      .map(r => ({
        id: r.id,
        businessId: r.business_id,
        name: r.name,
        type: r.type,
        format: r.format,
        schedule: r.schedule_config,
        parameters: r.parameters,
        recipients: r.schedule_config?.recipients || [],
        lastSent: r.last_sent,
        nextRun: r.next_run,
        enabled: true
      }))
      .sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime());
  }

  /**
   * Get report history
   */
  async getReportHistory(
    reportId: string,
    limit: number = 10
  ): Promise<any[]> {
    // In production, query from report executions table
    return [];
  }

  /**
   * Stop all scheduled reports
   */
  async stopAll(): Promise<void> {
    for (const [id, job] of this.jobs) {
      job.stop();
      this.jobs.delete(id);
    }
    logger.info('All scheduled reports stopped');
  }
}

export const scheduledReportService = new ScheduledReportService();
