import { businessRepository } from '../../repositories/BusinessRepository';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { regulatoryLogRepository } from '../../repositories/RegulatoryLogRepository';
import { notificationDigestModel } from '../../models/NotificationDigest';
import { logger } from '../../config/logger';
import { format, subMonths, startOfMonth, endOfMonth, differenceInDays } from 'date-fns';

export interface RegulatoryReport {
  id: string;
  businessId: string;
  period: {
    from: Date;
    to: Date;
  };
  type: 'monthly' | 'quarterly' | 'annual';
  generatedAt: Date;
  summary: {
    totalInvoices: number;
    totalValue: number;
    totalVAT: number;
    firsSubmissions: number;
    approvalRate: number;
    rejectionRate: number;
    averageResponseTime: number;
  };
  submissions: Array<{
    invoiceNumber: string;
    submissionDate: Date;
    status: string;
    irn?: string;
    responseTime?: number;
    errors?: string[];
  }>;
  compliance: {
    score: number;
    issues: Array<{
      type: string;
      severity: 'high' | 'medium' | 'low';
      description: string;
    }>;
  };
  recommendations: string[];
  attachments?: Array<{
    name: string;
    type: string;
    url: string;
  }>;
}

export class RegulatoryReportingService {
  private readonly reportTypes = ['monthly', 'quarterly', 'annual'] as const;

  /**
   * Generate regulatory report
   */
  async generateReport(
    businessId: string,
    period: {
      from: Date;
      to: Date;
    },
    type: 'monthly' | 'quarterly' | 'annual' = 'monthly'
  ): Promise<RegulatoryReport> {
    try {
      const [business, invoices, submissions] = await Promise.all([
        businessRepository.findById(businessId),
        invoiceRepository.findByDateRange(businessId, period.from, period.to),
        regulatoryLogRepository.findByBusiness(businessId, {
          fromDate: period.from,
          toDate: period.to
        })
      ]);

      if (!business) {
        throw new Error('Business not found');
      }

      // Calculate summary statistics
      const summary = this.calculateSummary(invoices, submissions);

      // Get submission details
      const submissionsList = await this.getSubmissionDetails(submissions);

      // Calculate compliance score
      const compliance = await this.calculateComplianceScore(businessId, invoices, submissions);

      // Generate recommendations
      const recommendations = this.generateRecommendations(summary, compliance);

      const report: RegulatoryReport = {
        id: `reg-report-${Date.now()}`,
        businessId,
        period,
        type,
        generatedAt: new Date(),
        summary,
        submissions: submissionsList,
        compliance,
        recommendations
      };

      // Store report reference
      await this.storeReport(report);

      return report;
    } catch (error) {
      logger.error('Error generating regulatory report:', error);
      throw error;
    }
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(invoices: any[], submissions: any[]): RegulatoryReport['summary'] {
    const totalInvoices = invoices.length;
    const totalValue = invoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    const totalVAT = invoices.reduce((sum, inv) => sum + inv.vat_amount, 0);

    const firsSubmissions = submissions.length;
    const approved = submissions.filter(s => s.status === 'approved').length;
    const rejected = submissions.filter(s => s.status === 'rejected').length;

    const approvalRate = firsSubmissions > 0 ? (approved / firsSubmissions) * 100 : 0;
    const rejectionRate = firsSubmissions > 0 ? (rejected / firsSubmissions) * 100 : 0;

    // Calculate average response time (in minutes)
    const responseTimes = submissions
      .filter(s => s.completed_at && s.created_at)
      .map(s => (new Date(s.completed_at).getTime() - new Date(s.created_at).getTime()) / (1000 * 60));

    const averageResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;

    return {
      totalInvoices,
      totalValue,
      totalVAT,
      firsSubmissions,
      approvalRate: Math.round(approvalRate * 10) / 10,
      rejectionRate: Math.round(rejectionRate * 10) / 10,
      averageResponseTime: Math.round(averageResponseTime * 10) / 10
    };
  }

  /**
   * Get submission details
   */
  private async getSubmissionDetails(
    submissions: any[]
  ): Promise<RegulatoryReport['submissions']> {
    const details = [];

    for (const sub of submissions) {
      // Get invoice details
      const invoice = await invoiceRepository.findById(sub.invoice_id);
      
      details.push({
        invoiceNumber: invoice?.invoice_number || 'Unknown',
        submissionDate: new Date(sub.created_at),
        status: sub.status,
        irn: sub.irn,
        responseTime: sub.processing_time_ms ? sub.processing_time_ms / (1000 * 60) : undefined,
        errors: sub.validation_errors?.map((e: any) => e.message)
      });
    }

    return details;
  }

  /**
   * Calculate compliance score
   */
  private async calculateComplianceScore(
    businessId: string,
    invoices: any[],
    submissions: any[]
  ): Promise<RegulatoryReport['compliance']> {
    let score = 100;
    const issues: RegulatoryReport['compliance']['issues'] = [];

    // Check submission rate
    const submittedInvoices = new Set(submissions.map(s => s.invoice_id));
    const submissionRate = (submittedInvoices.size / invoices.length) * 100;

    if (submissionRate < 90) {
      score -= 20;
      issues.push({
        type: 'submission_rate',
        severity: 'high',
        description: `Only ${Math.round(submissionRate)}% of invoices submitted to FIRS`
      });
    } else if (submissionRate < 100) {
      score -= 10;
      issues.push({
        type: 'submission_rate',
        severity: 'medium',
        description: `${100 - Math.round(submissionRate)}% of invoices not submitted to FIRS`
      });
    }

    // Check approval rate
    const approved = submissions.filter(s => s.status === 'approved').length;
    const approvalRate = submissions.length > 0 ? (approved / submissions.length) * 100 : 0;

    if (approvalRate < 95) {
      score -= 15;
      issues.push({
        type: 'approval_rate',
        severity: 'high',
        description: `Approval rate is ${Math.round(approvalRate)}%`
      });
    }

    // Check response time
    const slowResponses = submissions.filter(s => {
      if (!s.completed_at || !s.created_at) return false;
      const responseTime = new Date(s.completed_at).getTime() - new Date(s.created_at).getTime();
      return responseTime > 5 * 60 * 1000; // > 5 minutes
    }).length;

    if (slowResponses > 10) {
      score -= 10;
      issues.push({
        type: 'response_time',
        severity: 'medium',
        description: `${slowResponses} submissions took more than 5 minutes to process`
      });
    }

    // Check CSID status
    const business = await businessRepository.findById(businessId);
    if (business?.csid_expires_at) {
      const daysUntilExpiry = differenceInDays(business.csid_expires_at, new Date());
      
      if (daysUntilExpiry < 0) {
        score -= 30;
        issues.push({
          type: 'csid_expired',
          severity: 'high',
          description: 'CSID has expired - immediate action required'
        });
      } else if (daysUntilExpiry < 30) {
        score -= 10;
        issues.push({
          type: 'csid_expiring',
          severity: 'medium',
          description: `CSID expires in ${daysUntilExpiry} days`
        });
      }
    }

    return {
      score: Math.max(0, score),
      issues
    };
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    summary: RegulatoryReport['summary'],
    compliance: RegulatoryReport['compliance']
  ): string[] {
    const recommendations: string[] = [];

    if (summary.approvalRate < 90) {
      recommendations.push('Review rejected invoices and fix common errors to improve approval rate');
    }

    if (compliance.issues.some(i => i.type === 'csid_expiring')) {
      recommendations.push('Renew CSID before expiry to avoid service interruption');
    }

    if (summary.averageResponseTime > 5) {
      recommendations.push('Consider optimizing invoice data to reduce FIRS response time');
    }

    if (summary.firsSubmissions < summary.totalInvoices) {
      recommendations.push(`Submit ${summary.totalInvoices - summary.firsSubmissions} pending invoices to FIRS`);
    }

    return recommendations;
  }

  /**
   * Store report reference
   */
  private async storeReport(report: RegulatoryReport): Promise<void> {
    // In production, store in database
    logger.info(`Report generated for business ${report.businessId}`);
  }

  /**
   * Get report history
   */
  async getReportHistory(
    businessId: string,
    limit: number = 12
  ): Promise<Array<{
    id: string;
    period: string;
    type: string;
    generatedAt: Date;
    summary: RegulatoryReport['summary'];
  }>> {
    // In production, fetch from database
    // Placeholder implementation
    const history = [];

    for (let i = 0; i < limit; i++) {
      const date = subMonths(new Date(), i);
      const from = startOfMonth(date);
      const to = endOfMonth(date);

      history.push({
        id: `report-${i}`,
        period: format(date, 'yyyy-MM'),
        type: 'monthly',
        generatedAt: new Date(),
        summary: {
          totalInvoices: Math.floor(Math.random() * 100),
          totalValue: Math.floor(Math.random() * 1000000),
          totalVAT: Math.floor(Math.random() * 75000),
          firsSubmissions: Math.floor(Math.random() * 100),
          approvalRate: 90 + Math.random() * 10,
          rejectionRate: Math.random() * 10,
          averageResponseTime: 1 + Math.random() * 4
        }
      });
    }

    return history;
  }

  /**
   * Export report to file
   */
  async exportReport(
    reportId: string,
    format: 'pdf' | 'csv' | 'json' = 'csv'
  ): Promise<Buffer> {
    // In production, fetch report and convert
    // Placeholder implementation
    switch (format) {
      case 'csv':
        return Buffer.from('CSV report data');
      case 'json':
        return Buffer.from(JSON.stringify({ report: 'data' }));
      case 'pdf':
        return Buffer.from('PDF report data');
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Schedule regulatory reports
   */
  async scheduleReports(businessId: string): Promise<void> {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Schedule monthly report
    await notificationDigestModel.createDigest({
      business_id: businessId,
      type: 'regulatory',
      title: 'Monthly Regulatory Report',
      summary: 'Your monthly regulatory compliance report is ready',
      priority: 'medium',
      scheduled_for: nextMonth,
      items: [{
        id: `scheduled-report-${Date.now()}`,
        type: 'report',
        title: 'Monthly Compliance Report',
        description: `Report for ${format(now, 'MMMM yyyy')}`,
        action_url: '/dashboard/compliance/reports',
        action_label: 'View Report',
        metadata: {
          period: format(now, 'yyyy-MM'),
          type: 'monthly'
        },
        created_at: new Date()
      }]
    });
  }

  /**
   * Generate annual summary
   */
  async generateAnnualSummary(businessId: string, year: number): Promise<any> {
    const from = new Date(year, 0, 1);
    const to = new Date(year, 11, 31);

    const monthlyReports = [];
    for (let month = 0; month < 12; month++) {
      const monthFrom = new Date(year, month, 1);
      const monthTo = new Date(year, month + 1, 0);
      
      const report = await this.generateReport(businessId, {
        from: monthFrom,
        to: monthTo
      }, 'monthly');

      monthlyReports.push(report);
    }

    // Aggregate data
    const summary = {
      year,
      totalInvoices: monthlyReports.reduce((sum, r) => sum + r.summary.totalInvoices, 0),
      totalValue: monthlyReports.reduce((sum, r) => sum + r.summary.totalValue, 0),
      totalVAT: monthlyReports.reduce((sum, r) => sum + r.summary.totalVAT, 0),
      averageApprovalRate: monthlyReports.reduce((sum, r) => sum + r.summary.approvalRate, 0) / 12,
      bestMonth: monthlyReports.reduce((best, r) => 
        r.summary.approvalRate > best.approvalRate ? r : best
      ),
      worstMonth: monthlyReports.reduce((worst, r) => 
        r.summary.approvalRate < worst.approvalRate ? r : worst
      )
    };

    return summary;
  }
}

export const regulatoryReportingService = new RegulatoryReportingService();
