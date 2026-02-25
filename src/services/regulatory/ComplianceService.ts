import { businessRepository } from '../../repositories/BusinessRepository';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { regulatoryLogRepository } from '../../repositories/RegulatoryLogRepository';
import { notificationDigestModel } from '../../models/NotificationDigest';
import { redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { addDays, format, differenceInDays, isAfter } from 'date-fns';

export interface ComplianceStatus {
  overall: {
    score: number;
    status: 'compliant' | 'warning' | 'non_compliant';
    lastAssessment: Date;
  };
  firs: {
    registered: boolean;
    csidStatus: 'active' | 'expiring' | 'expired' | 'none';
    csidExpiresAt?: Date;
    submissionRate: number;
    approvalRate: number;
    lastSubmission?: Date;
  };
  documents: {
    total: number;
    complete: number;
    incomplete: number;
    missingFields: string[];
    lastAudit?: Date;
  };
  deadlines: ComplianceDeadline[];
  history: ComplianceHistoryEntry[];
}

export interface ComplianceDeadline {
  id: string;
  type: 'firs_filing' | 'csid_renewal' | 'audit' | 'report';
  title: string;
  description: string;
  dueDate: Date;
  status: 'pending' | 'completed' | 'overdue';
  priority: 'high' | 'medium' | 'low';
  completedAt?: Date;
}

export interface ComplianceHistoryEntry {
  date: Date;
  type: string;
  description: string;
  status: 'success' | 'warning' | 'error';
  metadata?: any;
}

export class ComplianceService {
  private readonly csidRenewalDays = 30;

  /**
   * Get compliance status for business
   */
  async getComplianceStatus(businessId: string): Promise<ComplianceStatus> {
    try {
      const [business, submissions, invoices] = await Promise.all([
        businessRepository.findById(businessId),
        regulatoryLogRepository.findByBusiness(businessId, { limit: 100 }),
        invoiceRepository.findByBusiness(businessId, { limit: 100 })
      ]);

      if (!business) {
        throw new Error('Business not found');
      }

      // Calculate FIRS compliance
      const firsStatus = this.calculateFIRSStatus(business, submissions);

      // Calculate document compliance
      const documentStatus = this.calculateDocumentCompliance(invoices);

      // Get upcoming deadlines
      const deadlines = await this.getUpcomingDeadlines(businessId, business, firsStatus);

      // Get compliance history
      const history = this.getComplianceHistory(submissions);

      // Calculate overall score
      const overallScore = this.calculateOverallScore(firsStatus, documentStatus, deadlines);
      const overallStatus = this.getOverallStatus(overallScore);

      return {
        overall: {
          score: overallScore,
          status: overallStatus,
          lastAssessment: new Date()
        },
        firs: firsStatus,
        documents: documentStatus,
        deadlines,
        history
      };
    } catch (error) {
      logger.error('Error getting compliance status:', error);
      throw error;
    }
  }

  /**
   * Calculate FIRS compliance status
   */
  private calculateFIRSStatus(business: any, submissions: any[]): ComplianceStatus['firs'] {
    const csidStatus = this.getCSIDStatus(business);
    
    // Calculate submission rate (last 30 days)
    const thirtyDaysAgo = addDays(new Date(), -30);
    const recentSubmissions = submissions.filter(s => 
      isAfter(new Date(s.created_at), thirtyDaysAgo)
    );

    const submissionRate = recentSubmissions.length;

    // Calculate approval rate
    const approved = submissions.filter(s => s.status === 'approved').length;
    const total = submissions.length;
    const approvalRate = total > 0 ? (approved / total) * 100 : 0;

    return {
      registered: business.firs_status === 'active',
      csidStatus,
      csidExpiresAt: business.csid_expires_at,
      submissionRate,
      approvalRate: Math.round(approvalRate * 10) / 10,
      lastSubmission: submissions[0]?.created_at
    };
  }

  /**
   * Get CSID status
   */
  private getCSIDStatus(business: any): 'active' | 'expiring' | 'expired' | 'none' {
    if (!business.csid) return 'none';
    if (!business.csid_expires_at) return 'active';

    const daysUntilExpiry = differenceInDays(business.csid_expires_at, new Date());

    if (daysUntilExpiry < 0) return 'expired';
    if (daysUntilExpiry <= this.csidRenewalDays) return 'expiring';
    return 'active';
  }

  /**
   * Calculate document compliance
   */
  private calculateDocumentStatus(
    invoices: any[]
  ): ComplianceStatus['documents'] {
    const total = invoices.length;
    let complete = 0;
    const missingFields = new Set<string>();

    invoices.forEach(inv => {
      let isComplete = true;

      // Check required fields
      const requiredFields = [
        'customer_tin', 'customer_name', 'issue_date', 'due_date',
        'line_items', 'subtotal', 'vat_amount', 'total_amount'
      ];

      requiredFields.forEach(field => {
        if (!inv[field]) {
          isComplete = false;
          missingFields.add(field);
        }
      });

      // Check line items
      if (inv.line_items?.length === 0) {
        isComplete = false;
        missingFields.add('line_items');
      }

      if (isComplete) {
        complete++;
      }
    });

    return {
      total,
      complete,
      incomplete: total - complete,
      missingFields: Array.from(missingFields),
      lastAudit: new Date()
    };
  }

  /**
   * Get upcoming deadlines
   */
  private async getUpcomingDeadlines(
    businessId: string,
    business: any,
    firsStatus: ComplianceStatus['firs']
  ): Promise<ComplianceDeadline[]> {
    const deadlines: ComplianceDeadline[] = [];

    // CSID renewal deadline
    if (firsStatus.csidStatus === 'expiring' && business.csid_expires_at) {
      deadlines.push({
        id: `csid-${business.csid}`,
        type: 'csid_renewal',
        title: 'CSID Renewal Required',
        description: 'Your Communication Session ID is about to expire',
        dueDate: business.csid_expires_at,
        status: 'pending',
        priority: 'high'
      });
    }

    // Monthly FIRS filing deadline (assuming 21st of each month)
    const nextFilingDate = this.getNextFilingDate();
    deadlines.push({
      id: `firs-${format(nextFilingDate, 'yyyy-MM')}`,
      type: 'firs_filing',
      title: 'Monthly FIRS Filing',
      description: 'Submit all invoices for the month to FIRS',
      dueDate: nextFilingDate,
      status: 'pending',
      priority: 'medium'
    });

    // Quarterly audit deadline (if applicable)
    const nextAuditDate = this.getNextAuditDate();
    if (business.turnover_band !== 'micro') {
      deadlines.push({
        id: `audit-${format(nextAuditDate, 'yyyy-QQ')}`,
        type: 'audit',
        title: 'Quarterly Audit Preparation',
        description: 'Prepare documents for quarterly audit',
        dueDate: nextAuditDate,
        status: 'pending',
        priority: 'low'
      });
    }

    return deadlines;
  }

  /**
   * Get compliance history
   */
  private getComplianceHistory(submissions: any[]): ComplianceHistoryEntry[] {
    return submissions.slice(0, 20).map(s => ({
      date: new Date(s.created_at),
      type: 'firs_submission',
      description: `Invoice ${s.submission_type} ${s.status}`,
      status: s.status === 'approved' ? 'success' : 
              s.status === 'rejected' ? 'error' : 'warning',
      metadata: {
        irn: s.irn,
        errors: s.error_message
      }
    }));
  }

  /**
   * Calculate overall compliance score
   */
  private calculateOverallScore(
    firsStatus: ComplianceStatus['firs'],
    documentStatus: ComplianceStatus['documents'],
    deadlines: ComplianceDeadline[]
  ): number {
    let score = 100;

    // FIRS registration (20 points)
    if (!firsStatus.registered) score -= 20;
    
    // CSID status (15 points)
    if (firsStatus.csidStatus === 'expired') score -= 15;
    else if (firsStatus.csidStatus === 'none') score -= 10;
    
    // Approval rate (15 points)
    if (firsStatus.approvalRate < 90) score -= 10;
    else if (firsStatus.approvalRate < 95) score -= 5;
    
    // Document completeness (25 points)
    const completenessRatio = documentStatus.complete / documentStatus.total || 1;
    score -= (1 - completenessRatio) * 25;
    
    // Deadlines (25 points)
    const overdueCount = deadlines.filter(d => d.status === 'overdue').length;
    score -= overdueCount * 10;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Get overall status based on score
   */
  private getOverallStatus(score: number): 'compliant' | 'warning' | 'non_compliant' {
    if (score >= 80) return 'compliant';
    if (score >= 50) return 'warning';
    return 'non_compliant';
  }

  /**
   * Get next filing date (21st of current month)
   */
  private getNextFilingDate(): Date {
    const now = new Date();
    const filingDate = new Date(now.getFullYear(), now.getMonth(), 21);
    
    if (now > filingDate) {
      filingDate.setMonth(filingDate.getMonth() + 1);
    }
    
    return filingDate;
  }

  /**
   * Get next audit date (end of quarter)
   */
  private getNextAuditDate(): Date {
    const now = new Date();
    const quarter = Math.floor(now.getMonth() / 3);
    const auditDate = new Date(now.getFullYear(), (quarter + 1) * 3, 0);
    
    if (now > auditDate) {
      auditDate.setMonth(auditDate.getMonth() + 3);
    }
    
    return auditDate;
  }

  /**
   * Run compliance check and generate alerts
   */
  async runComplianceCheck(businessId: string): Promise<void> {
    const status = await this.getComplianceStatus(businessId);
    
    // Check for critical issues
    if (status.overall.status === 'non_compliant') {
      await notificationDigestModel.createDigest({
        business_id: businessId,
        type: 'regulatory',
        title: '⚠️ Compliance Alert',
        summary: 'Your business is currently non-compliant with regulatory requirements',
        priority: 'high',
        items: [{
          id: `compliance-${Date.now()}`,
          type: 'alert',
          title: 'Immediate Action Required',
          description: 'Review compliance status and take corrective action',
          action_url: '/dashboard/compliance',
          action_label: 'View Details',
          metadata: {
            score: status.overall.score,
            issues: status.deadlines.filter(d => d.status === 'overdue')
          },
          created_at: new Date()
        }]
      });
    }

    // Check for expiring CSID
    if (status.firs.csidStatus === 'expiring' && status.firs.csidExpiresAt) {
      const daysUntil = differenceInDays(status.firs.csidExpiresAt, new Date());
      
      await notificationDigestModel.createDigest({
        business_id: businessId,
        type: 'regulatory',
        title: '🔑 CSID Expiring Soon',
        summary: `Your CSID will expire in ${daysUntil} days`,
        priority: 'medium',
        items: [{
          id: `csid-${Date.now()}`,
          type: 'renewal',
          title: 'Renew CSID',
          description: 'Submit CSID renewal application to FIRS',
          action_url: '/dashboard/compliance/csid',
          action_label: 'Renew Now',
          metadata: {
            expiresAt: status.firs.csidExpiresAt
          },
          created_at: new Date()
        }]
      });
    }
  }

  /**
   * Generate compliance report
   */
  async generateReport(
    businessId: string,
    format: 'pdf' | 'csv' = 'csv'
  ): Promise<Buffer> {
    const status = await this.getComplianceStatus(businessId);

    switch (format) {
      case 'csv':
        return this.generateCSVReport(status);
      case 'pdf':
        return this.generatePDFReport(status);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Generate CSV report
   */
  private generateCSVReport(status: ComplianceStatus): Buffer {
    const lines = ['Compliance Report'];
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    lines.push('Overall Status');
    lines.push(`Score,${status.overall.score}`);
    lines.push(`Status,${status.overall.status}`);
    lines.push('');

    lines.push('FIRS Compliance');
    lines.push(`Registered,${status.firs.registered ? 'Yes' : 'No'}`);
    lines.push(`CSID Status,${status.firs.csidStatus}`);
    lines.push(`Approval Rate,${status.firs.approvalRate}%`);
    lines.push('');

    lines.push('Document Compliance');
    lines.push(`Total Documents,${status.documents.total}`);
    lines.push(`Complete,${status.documents.complete}`);
    lines.push(`Incomplete,${status.documents.incomplete}`);
    lines.push('');

    lines.push('Upcoming Deadlines');
    lines.push('Type,Title,Due Date,Priority,Status');
    
    status.deadlines.forEach(d => {
      lines.push(
        `${d.type},${d.title},${format(d.dueDate, 'yyyy-MM-dd')},${d.priority},${d.status}`
      );
    });

    return Buffer.from(lines.join('\n'));
  }

  /**
   * Generate PDF report
   */
  private async generatePDFReport(status: ComplianceStatus): Promise<Buffer> {
    // Placeholder for PDF generation
    return Buffer.from('PDF report placeholder');
  }
}

export const complianceService = new ComplianceService();
