import { BaseModel, BaseEntity } from './BaseModel';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { AuditAction } from '../config/constants/business-rules';

export interface AuditLog extends BaseEntity {
  business_id?: string;
  user_id?: string;
  action: AuditAction;
  entity_type: string;
  entity_id?: string;
  old_values?: Record<string, any>;
  new_values?: Record<string, any>;
  changes?: Array<{
    field: string;
    old_value: any;
    new_value: any;
  }>;
  ip_address?: string;
  user_agent?: string;
  session_id?: string;
  request_id?: string;
  request_path?: string;
  request_method?: string;
  response_status?: number;
  response_time_ms?: number;
  metadata: Record<string, any>;
}

export interface CreateAuditLogDTO {
  business_id?: string;
  user_id?: string;
  action: AuditAction;
  entity_type: string;
  entity_id?: string;
  old_values?: Record<string, any>;
  new_values?: Record<string, any>;
  ip_address?: string;
  user_agent?: string;
  session_id?: string;
  request_id?: string;
  request_path?: string;
  request_method?: string;
  response_status?: number;
  response_time_ms?: number;
  metadata?: Record<string, any>;
}

export class AuditLogModel extends BaseModel<AuditLog> {
  protected tableName = 'audit_logs';
  protected primaryKey = 'id';

  /**
   * Create audit log entry
   */
  async log(data: CreateAuditLogDTO): Promise<AuditLog> {
    // Calculate changes if both old and new values provided
    let changes: AuditLog['changes'] = [];

    if (data.old_values && data.new_values) {
      changes = this.calculateChanges(data.old_values, data.new_values);
    }

    return this.create({
      ...data,
      changes,
      metadata: data.metadata || {},
    });
  }

  /**
   * Log bulk operation
   */
  async logBulk(
    action: AuditAction,
    entityType: string,
    entityIds: string[],
    userId?: string,
    businessId?: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    for (const entityId of entityIds) {
      await this.log({
        business_id: businessId,
        user_id: userId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        metadata,
      });
    }
  }

  /**
   * Get audit logs for entity
   */
  async getForEntity(
    entityType: string,
    entityId: string,
    options?: {
      limit?: number;
      offset?: number;
      fromDate?: Date;
      toDate?: Date;
    }
  ): Promise<AuditLog[]> {
    let query = `
      SELECT * FROM audit_logs
      WHERE entity_type = $1
        AND entity_id = $2
        AND deleted_at IS NULL
    `;

    const params: any[] = [entityType, entityId];
    let paramIndex = 3;

    if (options?.fromDate) {
      query += ` AND created_at >= $${paramIndex}`;
      params.push(options.fromDate);
      paramIndex++;
    }

    if (options?.toDate) {
      query += ` AND created_at <= $${paramIndex}`;
      params.push(options.toDate);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC
               LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Get audit logs for business
   */
  async getForBusiness(
    businessId: string,
    options?: {
      action?: AuditAction;
      entityType?: string;
      userId?: string;
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ logs: AuditLog[]; total: number }> {
    let sql = 'SELECT * FROM audit_logs WHERE business_id = $1 AND deleted_at IS NULL';
    const countSql = 'SELECT COUNT(*) FROM audit_logs WHERE business_id = $1 AND deleted_at IS NULL';
    const conditions: string[] = [];
    const params: any[] = [businessId];
    let paramIndex = 2;

    if (options?.action) {
      conditions.push(`action = $${paramIndex}`);
      params.push(options.action);
      paramIndex++;
    }

    if (options?.entityType) {
      conditions.push(`entity_type = $${paramIndex}`);
      params.push(options.entityType);
      paramIndex++;
    }

    if (options?.userId) {
      conditions.push(`user_id = $${paramIndex}`);
      params.push(options.userId);
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
    
    const limit = options?.limit || 50;
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
   * Get audit logs for user
   */
  async getForUser(
    userId: string,
    options?: {
      limit?: number;
      offset?: number;
    }
  ): Promise<AuditLog[]> {
    return this.find({ user_id: userId }, {
      limit: options?.limit,
      offset: options?.offset,
      orderBy: 'created_at',
      orderDir: 'DESC',
    });
  }

  /**
   * Search audit logs
   */
  async search(
    query: string,
    businessId?: string,
    options?: {
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<AuditLog[]> {
    let sql = `
      SELECT * FROM audit_logs
      WHERE (
        entity_type ILIKE $1
        OR entity_id::text ILIKE $1
        OR action ILIKE $1
        OR ip_address ILIKE $1
        OR metadata::text ILIKE $1
      )
    `;

    const params: any[] = [`%${query}%`];
    let paramIndex = 2;

    if (businessId) {
      sql += ` AND business_id = $${paramIndex}`;
      params.push(businessId);
      paramIndex++;
    }

    if (options?.fromDate) {
      sql += ` AND created_at >= $${paramIndex}`;
      params.push(options.fromDate);
      paramIndex++;
    }

    if (options?.toDate) {
      sql += ` AND created_at <= $${paramIndex}`;
      params.push(options.toDate);
      paramIndex++;
    }

    sql += ` AND deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    params.push(limit, offset);

    const result = await db.query(sql, params);
    return result.rows;
  }

  /**
   * Get activity summary
   */
  async getActivitySummary(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any> {
    const query = `
      SELECT
        DATE(created_at) as date,
        action,
        COUNT(*) as count,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT entity_id) as unique_entities
      FROM audit_logs
      WHERE business_id = $1
        AND created_at BETWEEN $2 AND $3
        AND deleted_at IS NULL
      GROUP BY DATE(created_at), action
      ORDER BY date DESC, count DESC
    `;

    const result = await db.query(query, [businessId, fromDate, toDate]);
    return result.rows;
  }

  /**
   * Get user activity
   */
  async getUserActivity(
    userId: string,
    days: number = 30
  ): Promise<any> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const query = `
      SELECT
        action,
        COUNT(*) as count,
        COUNT(DISTINCT entity_type) as entity_types,
        MIN(created_at) as first_activity,
        MAX(created_at) as last_activity
      FROM audit_logs
      WHERE user_id = $1
        AND created_at >= $2
        AND deleted_at IS NULL
      GROUP BY action
      ORDER BY count DESC
    `;

    const result = await db.query(query, [userId, cutoff]);
    return result.rows;
  }

  /**
   * Get IP address analysis
   */
  async getIPAnalysis(
    businessId: string,
    days: number = 30
  ): Promise<any> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const query = `
      SELECT
        ip_address,
        COUNT(*) as request_count,
        COUNT(DISTINCT user_id) as unique_users,
        MIN(created_at) as first_seen,
        MAX(created_at) as last_seen,
        array_agg(DISTINCT action) as actions
      FROM audit_logs
      WHERE business_id = $1
        AND ip_address IS NOT NULL
        AND created_at >= $2
        AND deleted_at IS NULL
      GROUP BY ip_address
      ORDER BY request_count DESC
    `;

    const result = await db.query(query, [businessId, cutoff]);
    return result.rows;
  }

  /**
   * Clean up old audit logs
   */
  async cleanupOldLogs(daysToKeep: number = 365): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);

    const query = `
      DELETE FROM audit_logs
      WHERE created_at < $1
    `;

    const result = await db.query(query, [cutoff]);
    return result.rowCount || 0;
  }

  /**
   * Calculate changes between old and new values
   */
  private calculateChanges(
    oldValues: Record<string, any>,
    newValues: Record<string, any>
  ): AuditLog['changes'] {
    const changes: AuditLog['changes'] = [];

    const allKeys = new Set([
      ...Object.keys(oldValues),
      ...Object.keys(newValues),
    ]);

    for (const key of allKeys) {
      const oldValue = oldValues[key];
      const newValue = newValues[key];

      // Skip if values are the same
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
        continue;
      }

      changes.push({
        field: key,
        old_value: oldValue,
        new_value: newValue,
      });
    }

    return changes;
  }

  /**
   * Export audit logs for compliance
   */
  async exportForCompliance(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any[]> {
    const query = `
      SELECT
        created_at,
        action,
        entity_type,
        entity_id,
        user_id,
        ip_address,
        changes,
        metadata
      FROM audit_logs
      WHERE business_id = $1
        AND created_at BETWEEN $2 AND $3
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;

    const result = await db.query(query, [businessId, fromDate, toDate]);
    return result.rows;
  }
}

export const auditLogModel = new AuditLogModel();
