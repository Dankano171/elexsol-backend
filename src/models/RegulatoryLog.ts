import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';

export interface RegulatoryLog extends BaseEntity {
  business_id: string;
  invoice_id?: string;
  submission_type: 'invoice' | 'credit_note' | 'debit_note' | 'cancellation' | 'query';
  submission_id?: string; // FIRS submission ID
  
  // Request/Response
  request_payload: Record<string, any>;
  request_xml?: string;
  request_signature?: string;
  response_payload?: Record<string, any>;
  response_xml?: string;
  
  // Status
  status: 'pending' | 'submitted' | 'approved' | 'rejected' | 'failed' | 'cancelled';
  error_code?: string;
  error_message?: string;
  validation_errors?: Array<{
    field: string;
    message: string;
    code: string;
  }>;
  
  // FIRS Data
  irn?: string; // Invoice Reference Number
  csid?: string; // Communication Session ID
  qr_code?: string;
  digital_signature?: string;
  
  // Timing
  submitted_at?: Date;
  responded_at?: Date;
  completed_at?: Date;
  processing_time_ms?: number;
  
  // Retry
  attempts: number;
  max_attempts: number;
  next_retry_at?: Date;
  
  // Metadata
  metadata: Record<string, any>;
  created_by?: string;
}

export interface CreateRegulatoryLogDTO {
  business_id: string;
  invoice_id?: string;
  submission_type: RegulatoryLog['submission_type'];
  request_payload: Record<string, any>;
  request_xml?: string;
  request_signature?: string;
  metadata?: Record<string, any>;
  created_by?: string;
}

export class RegulatoryLogModel extends BaseModel<RegulatoryLog> {
  protected tableName = 'regulatory_logs';
  protected primaryKey = 'id';

  /**
   * Create a new regulatory log
   */
  async createLog(data: CreateRegulatoryLogDTO): Promise<RegulatoryLog> {
    return this.create({
      ...data,
      status: 'pending',
      attempts: 0,
      max_attempts: 3,
      metadata: data.metadata || {},
    });
  }

  /**
   * Get pending submissions
   */
  async getPendingSubmissions(limit: number = 10): Promise<RegulatoryLog[]> {
    const query = `
      SELECT * FROM regulatory_logs
      WHERE status IN ('pending', 'failed')
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        AND attempts < max_attempts
        AND deleted_at IS NULL
      ORDER BY 
        CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    const result = await db.query(query, [limit]);
    return result.rows;
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
    }

    if (data?.response_payload) {
      updates.processing_time_ms = now.getTime() - (await this.findById(id))?.created_at.getTime()!;
    }

    return this.update(id, updates);
  }

  /**
   * Mark as submitted to FIRS
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
    
    if (!log) {
      return null;
    }

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
   * Get logs by business
   */
  async getByBusiness(
    businessId: string,
    options?: {
      status?: RegulatoryLog['status'];
      submission_type?: RegulatoryLog['submission_type'];
      fromDate?: Date;
      toDate?: Date;
      invoiceId?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ logs: RegulatoryLog[]; total: number }> {
    let sql = 'SELECT * FROM regulatory_logs WHERE business_id = $1 AND deleted_at IS NULL';
    const countSql = 'SELECT COUNT(*) FROM regulatory_logs WHERE business_id = $1 AND deleted_at IS NULL';
    const conditions: string[] = [];
    const params: any[] = [businessId];
    let paramIndex = 2;

    if (options?.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(options.status);
      paramIndex++;
    }

    if (options?.submission_type) {
      conditions.push(`submission_type = $${paramIndex}`);
      params.push(options.submission_type);
      paramIndex++;
    }

    if (options?.fromDate) {
      conditions.push(`created_at >= $${paramIndex}`);
      params.push(options.fromDate);
      paramIndex++;
    }

    if (options?.toDate) {
      conditions.push(`created_at <= $${paramIndex}`);
      params.push(options.toDate);
      paramIndex++;
    }

    if (options?.invoiceId) {
      conditions.push(`invoice_id = $${paramIndex}`);
      params.push(options.invoiceId);
      paramIndex++;
    }

    if (conditions.length > 0) {
      const whereClause = ' AND ' + conditions.join(' AND ');
      sql += whereClause;
    }

    sql += ` ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const [logs, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, [businessId]),
    ]);

    return {
      logs: logs.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Get logs by invoice
   */
  async getByInvoice(invoiceId: string): Promise<RegulatoryLog[]> {
    return this.find({ invoice_id: invoiceId }, {
      orderBy: 'created_at',
      orderDir: 'DESC',
    });
  }

  /**
   * Get by IRN
   */
  async getByIRN(irn: string): Promise<RegulatoryLog | null> {
    return this.findOne({ irn });
  }

  /**
   * Get submission statistics
   */
  async getStatistics(
    businessId: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<any> {
    const dateFilter = fromDate && toDate ? 'AND created_at BETWEEN $2 AND $3' : '';
    const params: any[] = [businessId];
    
    if (fromDate && toDate) {
      params.push(fromDate, toDate);
    }

    const query = `
      SELECT
        submission_type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        AVG(CASE WHEN status IN ('approved', 'rejected') 
            THEN EXTRACT(EPOCH FROM (completed_at - created_at)) 
            ELSE NULL END) as avg_processing_time_seconds,
        MAX(attempts) as max_attempts
      FROM regulatory_logs
      WHERE business_id = $1
        AND deleted_at IS NULL
        ${dateFilter}
      GROUP BY submission_type
    `;

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Get failure analysis
   */
  async getFailureAnalysis(
    businessId: string,
    days: number = 30
  ): Promise<any> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const query = `
      SELECT
        error_code,
        COUNT(*) as occurrence_count,
        COUNT(DISTINCT invoice_id) as affected_invoices,
        MIN(created_at) as first_occurrence,
        MAX(created_at) as last_occurrence
      FROM regulatory_logs
      WHERE business_id = $1
        AND status IN ('rejected', 'failed')
        AND error_code IS NOT NULL
        AND created_at >= $2
        AND deleted_at IS NULL
      GROUP BY error_code
      ORDER BY occurrence_count DESC
    `;

    const result = await db.query(query, [businessId, cutoff]);
    return result.rows;
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
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)::float / 
        COUNT(*)::float * 100 as compliance_rate
      FROM regulatory_logs
      WHERE business_id = $1
        AND created_at BETWEEN $2 AND $3
        AND deleted_at IS NULL
    `;

    const result = await db.query(query, [businessId, fromDate, toDate]);
    return parseFloat(result.rows[0]?.compliance_rate) || 0;
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
}

export const regulatoryLogModel = new RegulatoryLogModel();
