import { BaseRepository } from './BaseRepository';
import { AuditLog } from '../models/AuditLog';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { AuditAction } from '../config/constants/business-rules';

export class AuditLogRepository extends BaseRepository<AuditLog> {
  protected tableName = 'audit_logs';
  protected primaryKey = 'id';

  /**
   * Log an action
   */
  async log(data: Partial<AuditLog>): Promise<AuditLog> {
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
   * Find by business
   */
  async findByBusiness(
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
    const conditions: any = { business_id: businessId };

    if (options?.action) {
      conditions.action = options.action;
    }

    if (options?.entityType) {
      conditions.entity_type = options.entityType;
    }

    if (options?.userId) {
      conditions.user_id = options.userId;
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
   * Find by entity
   */
  async findByEntity(
    entityType: string,
    entityId: string,
    options?: {
      limit?: number;
      offset?: number;
      fromDate?: Date;
      toDate?: Date;
    }
  ): Promise<AuditLog[]> {
    const conditions: any = {
      entity_type: entityType,
      entity_id: entityId,
    };

    if (options?.fromDate || options?.toDate) {
      conditions.created_at = {};
      if (options.fromDate) {
        conditions.created_at.$gte = options.fromDate;
      }
      if (options.toDate) {
        conditions.created_at.$lte = options.toDate;
      }
    }

    return this.find(conditions, {
      orderBy: 'created_at',
      orderDir: 'DESC',
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  /**
   * Find by user
   */
  async findByUser(
    userId: string,
    options?: {
      limit?: number;
      offset?: number;
      fromDate?: Date;
      toDate?: Date;
    }
  ): Promise<AuditLog[]> {
    const conditions: any = { user_id: userId };

    if (options?.fromDate || options?.toDate) {
      conditions.created_at = {};
      if (options.fromDate) {
        conditions.created_at.$gte = options.fromDate;
      }
      if (options.toDate) {
        conditions.created_at.$lte = options.toDate;
      }
    }

    return this.find(conditions, {
      orderBy: 'created_at',
      orderDir: 'DESC',
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  /**
   * Find by action
   */
  async findByAction(
    action: AuditAction,
    options?: {
      businessId?: string;
      fromDate?: Date;
      toDate?: Date;
      limit?: number;
    }
  ): Promise<AuditLog[]> {
    const conditions: any = { action };

    if (options?.businessId) {
      conditions.business_id = options.businessId;
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

    return this.find(conditions, {
      orderBy: 'created_at',
      orderDir: 'DESC',
      limit: options?.limit,
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
        OR user_id::text ILIKE $1
        OR metadata::text ILIKE $1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(changes) as c
          WHERE c->>'field' ILIKE $1
          OR c->>'old_value'::text ILIKE $1
          OR c->>'new_value'::text ILIKE $1
        )
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

    return this.executeQuery<AuditLog>(sql, params);
  }

  /**
   * Get activity summary
   */
  async getActivitySummary(
    businessId: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any[]> {
    const query = `
      SELECT
        DATE(created_at) as date,
        action,
        COUNT(*) as count,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT entity_id) as unique_entities,
        json_agg(DISTINCT entity_type) as entity_types
      FROM audit_logs
      WHERE business_id = $1
        AND created_at BETWEEN $2 AND $3
        AND deleted_at IS NULL
      GROUP BY DATE(created_at), action
      ORDER BY date DESC, count DESC
    `;

    return this.executeQuery(query, [businessId, fromDate, toDate]);
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
        MAX(created_at) as last_activity,
        MODE() WITHIN GROUP (ORDER BY entity_type) as most_common_entity
      FROM audit_logs
      WHERE user_id = $1
        AND created_at >= $2
        AND deleted_at IS NULL
      GROUP BY action
      ORDER BY count DESC
    `;

    const result = await this.executeQuery<any>(query, [userId, cutoff]);
    return result;
  }

  /**
   * Get IP analysis
   */
  async getIPAnalysis(
    businessId: string,
    days: number = 30
  ): Promise<any[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const query = `
      SELECT
        ip_address,
        COUNT(*) as request_count,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT session_id) as unique_sessions,
        MIN(created_at) as first_seen,
        MAX(created_at) as last_seen,
        json_agg(DISTINCT action) as actions,
        json_agg(DISTINCT entity_type) as entity_types
      FROM audit_logs
      WHERE business_id = $1
        AND ip_address IS NOT NULL
        AND created_at >= $2
        AND deleted_at IS NULL
      GROUP BY ip_address
      HAVING COUNT(*) > 1
      ORDER BY request_count DESC
    `;

    return this.executeQuery(query, [businessId, cutoff]);
  }

  /**
   * Get entity history
   */
  async getEntityHistory(
    entityType: string,
    entityId: string
  ): Promise<{
    created: AuditLog | null;
    updated: AuditLog[];
    deleted: AuditLog | null;
    timeline: AuditLog[];
  }> {
    const logs = await this.findByEntity(entityType, entityId, {
      limit: 100,
    });

    return {
      created: logs.find(l => l.action === 'CREATE') || null,
      updated: logs.filter(l => l.action === 'UPDATE'),
      deleted: logs.find(l => l.action === 'DELETE') || null,
      timeline: logs,
    };
  }

  /**
   * Get changes summary
   */
  async getChangesSummary(
    businessId: string,
    entityType: string,
    fromDate: Date,
    toDate: Date
  ): Promise<any[]> {
    const query = `
      SELECT
        entity_id,
        COUNT(*) as change_count,
        COUNT(DISTINCT user_id) as changed_by_users,
        MIN(created_at) as first_change,
        MAX(created_at) as last_change,
        json_agg(DISTINCT 
          jsonb_build_object(
            'field', c->>'field',
            'count', COUNT(*)
          )
        ) as changed_fields
      FROM audit_logs,
           jsonb_array_elements(changes) as c
      WHERE business_id = $1
        AND entity_type = $2
        AND created_at BETWEEN $3 AND $4
        AND deleted_at IS NULL
      GROUP BY entity_id
      ORDER BY change_count DESC
      LIMIT 20
    `;

    return this.executeQuery(query, [businessId, entityType, fromDate, toDate]);
  }

  /**
   * Get peak activity times
   */
  async getPeakActivityTimes(
    businessId: string,
    days: number = 30
  ): Promise<any[]> {
    const query = `
      SELECT
        EXTRACT(HOUR FROM created_at) as hour_of_day,
        EXTRACT(DOW FROM created_at) as day_of_week,
        COUNT(*) as activity_count,
        COUNT(DISTINCT user_id) as active_users
      FROM audit_logs
      WHERE business_id = $1
        AND created_at >= NOW() - INTERVAL '${days} days'
        AND deleted_at IS NULL
      GROUP BY hour_of_day, day_of_week
      ORDER BY activity_count DESC
    `;

    return this.executeQuery(query, [businessId]);
  }

  /**
   * Clean up old logs
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
   * Export for compliance
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
        jsonb_pretty(changes) as changes,
        jsonb_pretty(metadata) as metadata
      FROM audit_logs
      WHERE business_id = $1
        AND created_at BETWEEN $2 AND $3
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;

    return this.executeQuery(query, [businessId, fromDate, toDate]);
  }

  /**
   * Get statistics
   */
  async getStatistics(
    businessId: string,
    fromDate?: Date,
    toDate?: Date
  ): Promise<any> {
    let sql = `
      SELECT
        COUNT(*) as total_events,
        COUNT(DISTINCT user_id) as active_users,
        COUNT(DISTINCT entity_type) as entity_types,
        AVG(jsonb_array_length(changes)) as avg_changes_per_event,
        MIN(created_at) as oldest_event,
        MAX(created_at) as newest_event,
        json_object_agg(action, action_count) as action_breakdown
      FROM (
        SELECT
          action,
          COUNT(*) as action_count
        FROM audit_logs
        WHERE business_id = $1
    `;

    const params: any[] = [businessId];

    if (fromDate && toDate) {
      sql += ` AND created_at BETWEEN $2 AND $3`;
      params.push(fromDate, toDate);
    }

    sql += ` GROUP BY action
      ) actions
    `;

    const result = await this.executeQuery<any>(sql, params);
    return result[0];
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
      ...Object.keys(oldValues || {}),
      ...Object.keys(newValues || {}),
    ]);

    for (const key of allKeys) {
      const oldValue = oldValues?.[key];
      const newValue = newValues?.[key];

      // Skip if values are the same
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) {
        continue;
      }

      // Skip sensitive fields
      if (['password_hash', 'mfa_secret', 'mfa_backup_codes', 'encrypted_access_token', 'encrypted_refresh_token'].includes(key)) {
        changes.push({
          field: key,
          old_value: '[REDACTED]',
          new_value: '[REDACTED]',
        });
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
}

export const auditLogRepository = new AuditLogRepository();
