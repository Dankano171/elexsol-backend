import { BaseRepository } from './BaseRepository';
import { RegulatoryLog } from '../models/RegulatoryLog';
import { db } from '../config/database';
import { logger } from '../config/logger';

export class RegulatoryLogRepository extends BaseRepository<RegulatoryLog> {
  protected tableName = 'regulatory_logs';
  protected primaryKey = 'id';

  /**
   * Find by business
   */
  async findByBusiness(
    businessId: string,
    options?: {
      status?: RegulatoryLog['status'];
      submission_type?: RegulatoryLog['submission_type'];
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ logs: RegulatoryLog[]; total: number }> {
    const conditions: any = { business_id: businessId };

    if (options?.status) {
      conditions.status = options.status;
    }

    if (options?.submission_type) {
      conditions.submission_type = options.submission_type;
    }

    if (options?.fromDate || options?.toDate) {
      conditions.created_at = {};
      if (options.fromDate) {
        conditions.created_at.$gte = options.fromDate;
      }
      if (options.toDate) {
        conditions.created_at.$lte = options.toDate;
      }
    }

    const [logs, total] = await Promise.all([
      this.find(conditions, {
        orderBy: 'created_at',
        orderDir: 'DESC',
        limit: options?.limit,
        offset: options?.offset,
      }),
      this.count(conditions),
    ]);

    return { logs, total };
  }

  /**
   * Find by invoice
   */
  async findByInvoice(
    invoiceId: string,
    options?: { limit?: number }
  ): Promise<RegulatoryLog[]> {
    return this.find(
      { invoice_id: invoiceId },
      {
        orderBy: 'created_at',
        orderDir: 'DESC',
        limit: options?.limit,
      }
    );
  }

  /**
   * Find by IRN
   */
  async findByIRN(irn: string): Promise<RegulatoryLog | null> {
    return this.findOne({ irn });
  }

  /**
   * Find pending submissions
   */
  async findPendingSubmissions(limit: number = 10): Promise<RegulatoryLog[]> {
    const query = `
      SELECT * FROM regulatory_logs
      WHERE status IN ('pending', 'failed')
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        AND attempts < max_attempts
        AND deleted_at IS NULL
      ORDER BY 
        CASE 
          WHEN status = 'pending' THEN 0 
          ELSE 1 
        END,
        created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    return this.executeQuery<RegulatoryLog>(query, [limit]);
  }

  /**
   * Find failed needing retry
   */
  async findFailedForRetry(limit: number = 10): Promise<RegulatoryLog[]> {
    const query = `
      SELECT * FROM regulatory_logs
      WHERE status = 'failed'
        AND attempts < max_attempts
        AND next_retry_at <= NOW()
        AND deleted_at IS NULL
      ORDER BY next_retry_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    return this.executeQuery<RegulatoryLog>(query, [limit]);
  }

  /**
   * Update submission status
   */
  async updateStatus(
    id: string,
    status: RegulatoryLog['status'],
    data?: {
      response_payload?: Record<string, any>;
      response_xml?: string;
      irn?: string;
      qr_code?: string;
      digital_signature?: string;
      error_code?: string;
      error_message?: string;
      validation_errors?: RegulatoryLog['validation_errors'];
    }
  ): Promise<RegulatoryLog | null> {
    const now = new Date();
    const updates: Partial<RegulatoryLog> = {
      status,
      responded_at: now,
      ...data,
    };

    if (status === 'approved' || status === 'rejected') {
      updates.completed_at = now;
      
      // Calculate processing time
      const log = await this.findById(id);
      if (log) {
        updates.processing_time_ms = now.getTime() - log.created_at.getTime();
      }
    }

    return this.update(id, updates);
  }

  /**
   * Mark as submitted
   */
  async markSubmitted(
    id: string,
    submissionId: string,
    csid?: string
  ): Promise<RegulatoryLog | null> {
    return this.update(id, {
      status: 'submitted',
      submission_id: submissionId,
      csid,
      submitted_at: new Date(),
    });
  }

  /**
   * Mark as failed with retry
   */
  async markFailed(
    id: string,
    error: string,
    errorCode?: string,
    retryDelayMinutes: number = 5
  ): Promise<RegulatoryLog | null> {
    const log = await this.findById(id);
    if (!log) return null;

    const nextRetryAt = new Date();
    nextRetryAt.setMinutes(nextRetryAt.getMinutes() + retryDelayMinutes);

    const updates: Partial<RegulatoryLog> = {
      status: log.attempts >= log.max_attempts ? 'failed' : 'pending',
      error_message: error,
      error_code: errorCode,
      responded_at: new Date(),
    };

    if (log.attempts < log.max_attempts) {
      updates.next_retry_at = nextRetryAt;
    }

    return this.update(id, updates);
  }

  /**
   * Add validation errors
   */
  async addValidationErrors(
    id: string,
    errors: RegulatoryLog['validation_errors']
  ): Promise<RegulatoryLog | null> {
    return this.update(id, {
      validation_errors: errors,
      status: 'failed',
    });
  }

  /**
   * Get statistics
   */
  async getStatistics(
    businessId: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<any[]> {
    let sql = `
      SELECT
        submission_type,
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        AVG(CASE WHEN status IN ('approved', 'rejected') 
            THEN processing_time_ms / 1000.0
            ELSE NULL END) as avg_processing_seconds,
        MAX(attempts) as max_attempts,
        COUNT(DISTINCT invoice_id) as unique_invoices
      FROM regulatory_logs
      WHERE business_id = $1
        AND deleted_at IS NULL
    `;

    const params: any[] = [businessId];

    if (fromDate && toDate) {
      sql += ` AND created_at BETWEEN $2 AND $3`;
      params.push(fromDate, toDate);
    }

    sql += ` GROUP BY submission_type`;

    return this.executeQuery(sql, params);
  }

  /**
   * Get failure analysis
   */
  async getFailureAnalysis(
    businessId: string,
    days: number = 30
  ): Promise<any[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const query = `
      SELECT
        error_code,
        COUNT(*) as occurrence_count,
        COUNT(DISTINCT invoice_id) as affected_invoices,
        MIN(created_at) as first_occurrence,
        MAX(created_at) as last_occurrence,
        json_agg(DISTINCT error_message) as sample_errors
      FROM regulatory_logs
      WHERE business_id = $1
        AND status IN ('rejected', 'failed')
        AND error_code IS NOT NULL
        AND created_at >= $2
        AND deleted_at IS NULL
      GROUP BY error_code
      ORDER BY occurrence_count DESC
    `;

    return this.executeQuery(query, [businessId, cutoff]);
  }

  /**
   * Get compliance rate
   */
  async getComplianceRate(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<number> {
    const query = `
      SELECT
        COUNT(CASE WHEN status = 'approved' THEN 1 END)::float / 
        COUNT(*)::float * 100 as compliance_rate
      FROM regulatory_logs
      WHERE business_id = $1
        AND created_at BETWEEN $2 AND $3
        AND deleted_at IS NULL
    `;

    const result = await this.executeQuery<any>(query, [businessId, fromDate, toDate]);
    return result[0]?.compliance_rate || 0;
  }

  /**
   * Get response time trends
   */
  async getResponseTimeTrends(
    businessId: string,
    days: number = 30
  ): Promise<any[]> {
    const query = `
      SELECT
        DATE(created_at) as date,
        AVG(processing_time_ms / 1000.0) as avg_response_seconds,
        MIN(processing_time_ms / 1000.0) as min_response_seconds,
        MAX(processing_time_ms / 1000.0) as max_response_seconds,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_time_ms / 1000.0) as p95_response_seconds
      FROM regulatory_logs
      WHERE business_id = $1
        AND status IN ('approved', 'rejected')
        AND processing_time_ms IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${days} days'
        AND deleted_at IS NULL
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `;

    return this.executeQuery(query, [businessId]);
  }

  /**
   * Get submission timeline
   */
  async getSubmissionTimeline(
    businessId: string,
    limit: number = 50
  ): Promise<any[]> {
    const query = `
      SELECT
        id,
        submission_type,
        status,
        created_at,
        submitted_at,
        responded_at,
        completed_at,
        processing_time_ms,
        CASE
          WHEN status = 'approved' THEN EXTRACT(EPOCH FROM (responded_at - created_at))
          ELSE NULL
        END as response_time_seconds,
        error_code,
        error_message
      FROM regulatory_logs
      WHERE business_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2
    `;

    return this.executeQuery(query, [businessId, limit]);
  }

  /**
   * Get top errors
   */
  async getTopErrors(
    businessId: string,
    limit: number = 10
  ): Promise<any[]> {
    const query = `
      SELECT
        error_code,
        error_message,
        COUNT(*) as occurrence_count,
        COUNT(DISTINCT invoice_id) as unique_invoices,
        MAX(created_at) as last_occurrence
      FROM regulatory_logs
      WHERE business_id = $1
        AND status IN ('rejected', 'failed')
        AND error_code IS NOT NULL
        AND deleted_at IS NULL
      GROUP BY error_code, error_message
      ORDER BY occurrence_count DESC
      LIMIT $2
    `;

    return this.executeQuery(query, [businessId, limit]);
  }

  /**
   * Clean up old logs
   */
  async cleanupOldLogs(daysToKeep: number = 90): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);

    const query = `
      DELETE FROM regulatory_logs
      WHERE created_at < $1
        AND status IN ('approved', 'rejected', 'failed')
    `;

    const result = await db.query(query, [cutoff]);
    return result.rowCount || 0;
  }

  /**
   * Export for audit
   */
  async exportForAudit(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any[]> {
    const query = `
      SELECT
        created_at,
        submission_type,
        status,
        irn,
        csid,
        error_code,
        error_message,
        processing_time_ms,
        attempts,
        CASE
          WHEN status = 'approved' THEN 'Success'
          WHEN status = 'rejected' THEN 'Rejected - ' || COALESCE(error_message, 'Unknown reason')
          WHEN status = 'failed' THEN 'Failed - ' || COALESCE(error_message, 'System error')
          ELSE status
        END as outcome,
        jsonb_array_length(validation_errors) as validation_error_count
      FROM regulatory_logs
      WHERE business_id = $1
        AND created_at BETWEEN $2 AND $3
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;

    return this.executeQuery(query, [businessId, fromDate, toDate]);
  }
}

export const regulatoryLogRepository = new RegulatoryLogRepository();
