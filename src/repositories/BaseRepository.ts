import { PoolClient } from 'pg';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { BaseEntity, FindOptions, WhereCondition } from '../models/BaseModel';

export interface RepositoryOptions {
  useMaster?: boolean; // For read/write splitting
  timeout?: number;
}

export abstract class BaseRepository<T extends BaseEntity> {
  protected abstract tableName: string;
  protected abstract primaryKey: string = 'id';

  /**
   * Execute query with options
   */
  protected async executeQuery<T>(
    query: string,
    params?: any[],
    options?: RepositoryOptions
  ): Promise<T[]> {
    try {
      // Add query timeout
      if (options?.timeout) {
        await db.query(`SET LOCAL statement_timeout = ${options.timeout}`);
      }

      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error(`Query execution error on ${this.tableName}:`, error);
      throw error;
    }
  }

  /**
   * Execute query and return first row
   */
  protected async executeQueryOne<T>(
    query: string,
    params?: any[],
    options?: RepositoryOptions
  ): Promise<T | null> {
    const rows = await this.executeQuery<T>(query, params, options);
    return rows[0] || null;
  }

  /**
   * Execute transaction
   */
  protected async transaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Build WHERE clause from conditions
   */
  protected buildWhereClause(
    conditions: WhereCondition,
    values: any[],
    startIndex: number = 1
  ): { clause: string; nextIndex: number } {
    const clauses: string[] = [];
    let index = startIndex;

    for (const [key, value] of Object.entries(conditions)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        // IN clause
        const placeholders = value.map((_, i) => `$${index + i}`).join(', ');
        clauses.push(`${key} IN (${placeholders})`);
        values.push(...value);
        index += value.length;
      } else if (typeof value === 'object' && value !== null) {
        // Operator like $gt, $lt, etc.
        for (const [op, opValue] of Object.entries(value)) {
          let operator: string;
          switch (op) {
            case '$gt':
              operator = '>';
              break;
            case '$gte':
              operator = '>=';
              break;
            case '$lt':
              operator = '<';
              break;
            case '$lte':
              operator = '<=';
              break;
            case '$ne':
              operator = '!=';
              break;
            case '$like':
              operator = 'LIKE';
              break;
            case '$ilike':
              operator = 'ILIKE';
              break;
            default:
              continue;
          }
          clauses.push(`${key} ${operator} $${index}`);
          values.push(opValue);
          index++;
        }
      } else {
        // Simple equality
        clauses.push(`${key} = $${index}`);
        values.push(value);
        index++;
      }
    }

    return {
      clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND )}` : '',
      nextIndex: index,
    };
  }

  /**
   * Build ORDER BY clause
   */
  protected buildOrderByClause(orderBy?: string, orderDir?: 'ASC' | 'DESC'): string {
    if (!orderBy) return '';
    return `ORDER BY ${orderBy} ${orderDir || 'ASC'}`;
  }

  /**
   * Build LIMIT and OFFSET clause
   */
  protected buildPaginationClause(limit?: number, offset?: number): string {
    const clauses: string[] = [];
    if (limit) {
      clauses.push(`LIMIT ${limit}`);
    }
    if (offset) {
      clauses.push(`OFFSET ${offset}`);
    }
    return clauses.join(' ');
  }

  /**
   * Find by ID
   */
  async findById(id: string, options?: RepositoryOptions): Promise<T | null> {
    const query = `
      SELECT * FROM ${this.tableName}
      WHERE ${this.primaryKey} = $1 AND deleted_at IS NULL
    `;
    return this.executeQueryOne<T>(query, [id], options);
  }

  /**
   * Find one by conditions
   */
  async findOne(
    conditions: WhereCondition,
    options?: RepositoryOptions
  ): Promise<T | null> {
    const values: any[] = [];
    const { clause } = this.buildWhereClause(conditions, values);
    
    const query = `
      SELECT * FROM ${this.tableName}
      ${clause} AND deleted_at IS NULL
      LIMIT 1
    `;

    return this.executeQueryOne<T>(query, values, options);
  }

  /**
   * Find many by conditions
   */
  async find(
    conditions: WhereCondition = {},
    findOptions: FindOptions = {},
    options?: RepositoryOptions
  ): Promise<T[]> {
    const values: any[] = [];
    const { clause } = this.buildWhereClause({ ...conditions, deleted_at: null }, values);
    
    const orderByClause = this.buildOrderByClause(
      findOptions.orderBy,
      findOptions.orderDir
    );
    
    const paginationClause = this.buildPaginationClause(
      findOptions.limit,
      findOptions.offset
    );

    const fields = findOptions.fields ? findOptions.fields.join(', ') : '*';

    const query = `
      SELECT ${fields} FROM ${this.tableName}
      ${clause}
      ${orderByClause}
      ${paginationClause}
    `;

    return this.executeQuery<T>(query, values, options);
  }

  /**
   * Count records
   */
  async count(conditions: WhereCondition = {}, options?: RepositoryOptions): Promise<number> {
    const values: any[] = [];
    const { clause } = this.buildWhereClause({ ...conditions, deleted_at: null }, values);

    const query = `
      SELECT COUNT(*) as count FROM ${this.tableName}
      ${clause}
    `;

    const result = await this.executeQueryOne<{ count: string }>(query, values, options);
    return parseInt(result?.count || '0');
  }

  /**
   * Create record
   */
  async create(data: Partial<T>, client?: PoolClient): Promise<T> {
    const executor = client || db;
    
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

    const query = `
      INSERT INTO ${this.tableName} (${keys.join(', ')})
      VALUES (${placeholders})
      RETURNING *
    `;

    const result = await executor.query(query, values);
    return result.rows[0];
  }

  /**
   * Update record
   */
  async update(
    id: string,
    data: Partial<T>,
    client?: PoolClient
  ): Promise<T | null> {
    const executor = client || db;

    const updates: string[] = [];
    const values: any[] = [];
    let index = 1;

    for (const [key, value] of Object.entries(data)) {
      if (key !== this.primaryKey && key !== 'created_at') {
        updates.push(`${key} = $${index}`);
        values.push(value);
        index++;
      }
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const query = `
      UPDATE ${this.tableName}
      SET ${updates.join(', ')}
      WHERE ${this.primaryKey} = $${index}
        AND deleted_at IS NULL
      RETURNING *
    `;

    const result = await executor.query(query, values);
    return result.rows[0] || null;
  }

  /**
   * Soft delete
   */
  async softDelete(id: string, client?: PoolClient): Promise<boolean> {
    const executor = client || db;

    const query = `
      UPDATE ${this.tableName}
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE ${this.primaryKey} = $1 AND deleted_at IS NULL
      RETURNING ${this.primaryKey}
    `;

    const result = await executor.query(query, [id]);
    return result.rowCount ? result.rowCount > 0 : false;
  }

  /**
   * Hard delete
   */
  async hardDelete(id: string, client?: PoolClient): Promise<boolean> {
    const executor = client || db;

    const query = `
      DELETE FROM ${this.tableName}
      WHERE ${this.primaryKey} = $1
      RETURNING ${this.primaryKey}
    `;

    const result = await executor.query(query, [id]);
    return result.rowCount ? result.rowCount > 0 : false;
  }

  /**
   * Bulk create
   */
  async bulkCreate(data: Partial<T>[], client?: PoolClient): Promise<T[]> {
    if (data.length === 0) return [];

    const executor = client || db;
    const results: T[] = [];

    for (const item of data) {
      const result = await this.create(item, executor);
      results.push(result);
    }

    return results;
  }

  /**
   * Bulk update
   */
  async bulkUpdate(
    ids: string[],
    data: Partial<T>,
    client?: PoolClient
  ): Promise<number> {
    if (ids.length === 0) return 0;

    const executor = client || db;

    const updates: string[] = [];
    const values: any[] = [ids];
    let index = 2;

    for (const [key, value] of Object.entries(data)) {
      if (key !== this.primaryKey && key !== 'created_at') {
        updates.push(`${key} = $${index}`);
        values.push(value);
        index++;
      }
    }

    updates.push(`updated_at = NOW()`);

    const query = `
      UPDATE ${this.tableName}
      SET ${updates.join(', ')}
      WHERE ${this.primaryKey} = ANY($1)
        AND deleted_at IS NULL
    `;

    const result = await executor.query(query, values);
    return result.rowCount || 0;
  }

  /**
   * Bulk soft delete
   */
  async bulkSoftDelete(ids: string[], client?: PoolClient): Promise<number> {
    if (ids.length === 0) return 0;

    const executor = client || db;

    const query = `
      UPDATE ${this.tableName}
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE ${this.primaryKey} = ANY($1)
        AND deleted_at IS NULL
    `;

    const result = await executor.query(query, [ids]);
    return result.rowCount || 0;
  }

  /**
   * Exists
   */
  async exists(conditions: WhereCondition, options?: RepositoryOptions): Promise<boolean> {
    const count = await this.count(conditions, options);
    return count > 0;
  }

  /**
   * Find or create
   */
  async findOrCreate(
    conditions: WhereCondition,
    data: Partial<T>,
    options?: RepositoryOptions
  ): Promise<{ record: T; created: boolean }> {
    const existing = await this.findOne(conditions, options);
    
    if (existing) {
      return { record: existing, created: false };
    }

    const record = await this.create({ ...conditions, ...data });
    return { record, created: true };
  }

  /**
   * Update or create
   */
  async updateOrCreate(
    conditions: WhereCondition,
    data: Partial<T>,
    options?: RepositoryOptions
  ): Promise<T> {
    const existing = await this.findOne(conditions, options);
    
    if (existing) {
      const updated = await this.update(existing[this.primaryKey as keyof T] as string, data);
      if (!updated) {
        throw new Error('Failed to update record');
      }
      return updated;
    }

    return this.create({ ...conditions, ...data });
  }

  /**
   * Paginate results
   */
  async paginate(
    conditions: WhereCondition = {},
    page: number = 1,
    limit: number = 20,
    orderBy?: string,
    orderDir?: 'ASC' | 'DESC',
    options?: RepositoryOptions
  ): Promise<{
    data: T[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.find(conditions, { limit, offset, orderBy, orderDir }, options),
      this.count(conditions, options),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get distinct values
   */
  async distinct(
    field: string,
    conditions: WhereCondition = {},
    options?: RepositoryOptions
  ): Promise<any[]> {
    const values: any[] = [];
    const { clause } = this.buildWhereClause({ ...conditions, deleted_at: null }, values);

    const query = `
      SELECT DISTINCT ${field} FROM ${this.tableName}
      ${clause}
      ORDER BY ${field}
    `;

    const result = await this.executeQuery<Record<string, any>>(query, values, options);
    return result.map(r => r[field]);
  }

  /**
   * Get min/max values
   */
  async aggregate(
    field: string,
    function: 'MIN' | 'MAX' | 'AVG' | 'SUM',
    conditions: WhereCondition = {},
    options?: RepositoryOptions
  ): Promise<number | null> {
    const values: any[] = [];
    const { clause } = this.buildWhereClause({ ...conditions, deleted_at: null }, values);

    const query = `
      SELECT ${function}(${field}) as value FROM ${this.tableName}
      ${clause}
    `;

    const result = await this.executeQueryOne<{ value: string }>(query, values, options);
    return result?.value ? parseFloat(result.value) : null;
  }

  /**
   * Get statistics
   */
  async getStatistics(
    groupBy: string,
    aggregates: Array<{
      alias: string;
      field: string;
      function: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
    }>,
    conditions: WhereCondition = {},
    options?: RepositoryOptions
  ): Promise<any[]> {
    const values: any[] = [];
    const { clause } = this.buildWhereClause({ ...conditions, deleted_at: null }, values);

    const aggregateFields = aggregates
      .map(a => `${a.function}(${a.field}) as ${a.alias}`)
      .join(', ');

    const query = `
      SELECT ${groupBy}, ${aggregateFields}
      FROM ${this.tableName}
      ${clause}
      GROUP BY ${groupBy}
      ORDER BY ${groupBy}
    `;

    return this.executeQuery(query, values, options);
  }

  /**
   * Raw query
   */
  async rawQuery(query: string, params?: any[]): Promise<any[]> {
    return this.executeQuery(query, params);
  }

  /**
   * Restore soft-deleted record
   */
  async restore(id: string, client?: PoolClient): Promise<boolean> {
    const executor = client || db;

    const query = `
      UPDATE ${this.tableName}
      SET deleted_at = NULL, updated_at = NOW()
      WHERE ${this.primaryKey} = $1
      RETURNING ${this.primaryKey}
    `;

    const result = await executor.query(query, [id]);
    return result.rowCount ? result.rowCount > 0 : false;
  }

  /**
   * Get deleted records
   */
  async getDeleted(options?: RepositoryOptions): Promise<T[]> {
    const query = `
      SELECT * FROM ${this.tableName}
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
    `;

    return this.executeQuery<T>(query, [], options);
  }

  /**
   * Clean up old deleted records
   */
  async cleanupDeleted(daysOld: number = 30, client?: PoolClient): Promise<number> {
    const executor = client || db;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    const query = `
      DELETE FROM ${this.tableName}
      WHERE deleted_at < $1
    `;

    const result = await executor.query(query, [cutoff]);
    return result.rowCount || 0;
  }
}
