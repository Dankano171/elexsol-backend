import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';

export interface Report extends BaseEntity {
  business_id: string;
  user_id?: string;
  name: string;
  description?: string;
  type: 'invoice' | 'payment' | 'tax' | 'customer' | 'integration' | 'custom';
  format: 'pdf' | 'excel' | 'csv' | 'json';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  
  // Report parameters
  parameters: {
    from_date?: Date;
    to_date?: Date;
    filters?: Record<string, any>;
    group_by?: string[];
    aggregates?: Array<{
      field: string;
      function: 'sum' | 'avg' | 'count' | 'min' | 'max';
    }>;
  };
  
  // File data
  file_url?: string;
  file_size?: number;
  file_hash?: string;
  
  // Schedule
  is_scheduled: boolean;
  schedule_config?: {
    frequency: 'daily' | 'weekly' | 'monthly';
    day_of_week?: number;
    day_of_month?: number;
    time: string;
    recipients: string[];
    last_sent_at?: Date;
    next_send_at?: Date;
  };
  
  // Progress
  progress: number; // 0-100
  error_message?: string;
  processing_time_ms?: number;
  started_at?: Date;
  completed_at?: Date;
  
  // Metadata
  metadata: Record<string, any>;
  created_by?: string;
}

export interface CreateReportDTO {
  business_id: string;
  user_id?: string;
  name: string;
  description?: string;
  type: Report['type'];
  format: Report['format'];
  parameters: Report['parameters'];
  is_scheduled?: boolean;
  schedule_config?: Report['schedule_config'];
  metadata?: Record<string, any>;
  created_by?: string;
}

export class ReportModel extends BaseModel<Report> {
  protected tableName = 'reports';
  protected primaryKey = 'id';

  /**
   * Create a new report
   */
  async createReport(data: CreateReportDTO): Promise<Report> {
    return this.create({
      ...data,
      status: 'pending',
      progress: 0,
      is_scheduled: data.is_scheduled || false,
      metadata: data.metadata || {},
    });
  }

  /**
   * Get pending reports for processing
   */
  async getPendingForProcessing(limit: number = 5): Promise<Report[]> {
    const query = `
      SELECT * FROM reports
      WHERE status = 'pending'
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    const result = await db.query(query, [limit]);
    return result.rows;
  }

  /**
   * Get scheduled reports due
   */
  async getScheduledDue(): Promise<Report[]> {
    const now = new Date();

    const query = `
      SELECT * FROM reports
      WHERE is_scheduled = true
        AND status IN ('completed', 'pending')
        AND schedule_config->>'next_send_at' <= $1::text
        AND deleted_at IS NULL
    `;

    const result = await db.query(query, [now.toISOString()]);
    return result.rows;
  }

  /**
   * Update report progress
   */
  async updateProgress(
    id: string,
    progress: number,
    status?: Report['status']
  ): Promise<void> {
    const updates: Partial<Report> = { progress };
    
    if (status) {
      updates.status = status;
    }

    if (progress === 100) {
      updates.status = 'completed';
      updates.completed_at = new Date();
    }

    if (status === 'processing' && !updates.started_at) {
      updates.started_at = new Date();
    }

    await this.update(id, updates);
  }

  /**
   * Mark as completed
   */
  async markCompleted(
    id: string,
    fileUrl: string,
    fileSize: number,
    fileHash: string
  ): Promise<Report | null> {
    const report = await this.findById(id);
    
    if (!report) {
      return null;
    }

    const processing_time_ms = Date.now() - report.created_at.getTime();

    return this.update(id, {
      status: 'completed',
      progress: 100,
      file_url: fileUrl,
      file_size: fileSize,
      file_hash: fileHash,
      processing_time_ms,
      completed_at: new Date(),
    });
  }

  /**
   * Mark as failed
   */
  async markFailed(id: string, error: string): Promise<Report | null> {
    return this.update(id, {
      status: 'failed',
      error_message: error,
      completed_at: new Date(),
    });
  }

  /**
   * Get reports by business
   */
  async getByBusiness(
    businessId: string,
    options?: {
      type?: Report['type'];
      status?: Report['status'];
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ reports: Report[]; total: number }> {
    let sql = 'SELECT * FROM reports WHERE business_id = $1 AND deleted_at IS NULL';
    const countSql = 'SELECT COUNT(*) FROM reports WHERE business_id = $1 AND deleted_at IS NULL';
    const conditions: string[] = [];
    const params: any[] = [businessId];
    let paramIndex = 2;

    if (options?.type) {
      conditions.push(`type = $${paramIndex}`);
      params.push(options.type);
      paramIndex++;
    }

    if (options?.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(options.status);
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

    if (conditions.length > 0) {
      const whereClause = ' AND ' + conditions.join(' AND ');
      sql += whereClause;
    }

    sql += ` ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const [reports, countResult] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, [businessId]),
    ]);

    return {
      reports: reports.rows,
      total: parseInt(countResult.rows[0].count),
    };
  }

  /**
   * Get reports by user
   */
  async getByUser(
    userId: string,
    options?: {
      limit?: number;
      offset?: number;
    }
  ): Promise<Report[]> {
    return this.find({ user_id: userId }, {
      limit: options?.limit,
      offset: options?.offset,
      orderBy: 'created_at',
      orderDir: 'DESC',
    });
  }

  /**
   * Update schedule
   */
  async updateSchedule(
    id: string,
    businessId: string,
    scheduleConfig: Report['schedule_config']
  ): Promise<Report | null> {
    const report = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!report) {
      return null;
    }

    return this.update(id, {
      is_scheduled: true,
      schedule_config: scheduleConfig,
    });
  }

  /**
   * Disable schedule
   */
  async disableSchedule(id: string, businessId: string): Promise<Report | null> {
    const report = await this.findOne({
      id,
      business_id: businessId,
    });

    if (!report) {
      return null;
    }

    return this.update(id, {
      is_scheduled: false,
    });
  }

  /**
   * Update last sent time
   */
  async updateLastSent(id: string): Promise<void> {
    const report = await this.findById(id);
    
    if (!report || !report.schedule_config) {
      return;
    }

    const scheduleConfig = {
      ...report.schedule_config,
      last_sent_at: new Date(),
      next_send_at: this.calculateNextSend(report.schedule_config),
    };

    await this.update(id, { schedule_config: scheduleConfig });
  }

  /**
   * Get report statistics
   */
  async getStatistics(businessId: string): Promise<any> {
    const query = `
      SELECT
        type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        AVG(CASE WHEN status = 'completed' 
            THEN processing_time_ms / 1000.0 
            ELSE NULL END) as avg_processing_seconds
      FROM reports
      WHERE business_id = $1
        AND deleted_at IS NULL
      GROUP BY type
    `;

    const result = await db.query(query, [businessId]);
    return result.rows;
  }

  /**
   * Clean up old reports
   */
  async cleanupOldReports(daysToKeep: number = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);

    const query = `
      UPDATE reports
      SET deleted_at = NOW()
      WHERE created_at < $1
        AND status IN ('completed', 'failed')
        AND NOT is_scheduled
    `;

    const result = await db.query(query, [cutoff]);
    return result.rowCount || 0;
  }

  /**
   * Calculate next send time for scheduled report
   */
  private calculateNextSend(config: Report['schedule_config']): Date {
    const now = new Date();
    const [hours, minutes] = config!.time.split(':').map(Number);
    
    const next = new Date(now);
    next.setHours(hours, minutes, 0, 0);

    if (config!.frequency === 'daily') {
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
    } else if (config!.frequency === 'weekly') {
      const dayOfWeek = config!.day_of_week || 1; // Default Monday
      while (next.getDay() !== dayOfWeek) {
        next.setDate(next.getDate() + 1);
      }
      if (next <= now) {
        next.setDate(next.getDate() + 7);
      }
    } else if (config!.frequency === 'monthly') {
      const dayOfMonth = config!.day_of_month || 1;
      next.setDate(dayOfMonth);
      if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
    }

    return next;
  }

  /**
   * Duplicate a report
   */
  async duplicate(id: string, newName: string, userId?: string): Promise<Report> {
    const report = await this.findById(id);
    
    if (!report) {
      throw new Error('Report not found');
    }

    // Create new report with same parameters
    return this.createReport({
      business_id: report.business_id,
      user_id: userId || report.user_id,
      name: newName,
      description: report.description,
      type: report.type,
      format: report.format,
      parameters: report.parameters,
      is_scheduled: false, // Don't duplicate schedule
      metadata: {
        ...report.metadata,
        duplicated_from: report.id,
        duplicated_at: new Date(),
      },
      created_by: userId,
    });
  }
}

export const reportModel = new ReportModel();
