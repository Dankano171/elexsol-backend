import { PoolClient } from 'pg';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { v4 as uuidv4 } from 'uuid';

export interface BaseEntity {
  id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at?: Date;
  version: number;
}

export interface FindOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: 'ASC' | 'DESC';
  fields?: string[];
}

export interface WhereCondition {
  [key: string]: any;
}

export abstract class BaseModel<T extends BaseEntity> {
  protected abstract tableName: string;
  protected abstract primaryKey: string = 'id';

  /**
   * Find by ID
   */
  async findById(id: string, options?: { includeDeleted?: boolean }): Promise<T | null> {
    try {
      const query = `
        SELECT * FROM ${this.tableName}
        WHERE ${this.primaryKey} = $1
        ${!options?.includeDeleted ? 'AND deleted_at IS NULL' : ''}
      `;
      
      const result = await db.query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.findById:`, error);
      throw error;
    }
  }

  /**
   * Find one by conditions
   */
  async findOne(where: WhereCondition, options?: { includeDeleted?: boolean }): Promise<T | null> {
    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      Object.entries(where).forEach(([key, value]) => {
        conditions.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      });

      if (!options?.includeDeleted) {
        conditions.push('deleted_at IS NULL');
      }

      const query = `
        SELECT * FROM ${this.tableName}
        WHERE ${conditions.join(' AND ')}
        LIMIT 1
      `;

      const result = await db.query(query, values);
      return result.rows[0] || null;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.findOne:`, error);
      throw error;
    }
  }

  /**
   * Find many by conditions
   */
  async find(where: WhereCondition = {}, options: FindOptions = {}): Promise<T[]> {
    try {
      const conditions: string[] = ['deleted_at IS NULL'];
      const values: any[] = [];
      let paramIndex = 1;

      Object.entries(where).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          conditions.push(`${key} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
      });

      const limit = options.limit || 100;
      const offset = options.offset || 0;
      const orderBy = options.orderBy || 'created_at';
      const orderDir = options.orderDir || 'DESC';
      const fields = options.fields ? options.fields.join(', ') : '*';

      const query = `
        SELECT ${fields} FROM ${this.tableName}
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy} ${orderDir}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      values.push(limit, offset);

      const result = await db.query(query, values);
      return result.rows;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.find:`, error);
      throw error;
    }
  }

  /**
   * Create new record
   */
  async create(data: Partial<T>, client?: PoolClient): Promise<T> {
    const executor = client || db;
    
    try {
      const id = uuidv4();
      const now = new Date();
      
      const insertData = {
        id,
        created_at: now,
        updated_at: now,
        version: 1,
        ...data,
      };

      const keys = Object.keys(insertData);
      const values = Object.values(insertData);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

      const query = `
        INSERT INTO ${this.tableName} (${keys.join(', ')})
        VALUES (${placeholders})
        RETURNING *
      `;

      const result = await executor.query(query, values);
      return result.rows[0];
    } catch (error) {
      logger.error(`Error in ${this.tableName}.create:`, error);
      throw error;
    }
  }

  /**
   * Update record
   */
  async update(id: string, data: Partial<T>, client?: PoolClient): Promise<T | null> {
    const executor = client || db;
    
    try {
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      Object.entries(data).forEach(([key, value]) => {
        if (key !== 'id' && key !== 'created_at' && key !== 'version') {
          updates.push(`${key} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
      });

      updates.push(`updated_at = NOW()`);
      updates.push(`version = version + 1`);

      values.push(id);

      const query = `
        UPDATE ${this.tableName}
        SET ${updates.join(', ')}
        WHERE ${this.primaryKey} = $${paramIndex}
          AND deleted_at IS NULL
        RETURNING *
      `;

      const result = await executor.query(query, values);
      return result.rows[0] || null;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.update:`, error);
      throw error;
    }
  }

  /**
   * Soft delete record
   */
  async softDelete(id: string, client?: PoolClient): Promise<boolean> {
    const executor = client || db;
    
    try {
      const query = `
        UPDATE ${this.tableName}
        SET deleted_at = NOW(), updated_at = NOW(), version = version + 1
        WHERE ${this.primaryKey} = $1
          AND deleted_at IS NULL
        RETURNING id
      `;

      const result = await executor.query(query, [id]);
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.softDelete:`, error);
      throw error;
    }
  }

  /**
   * Hard delete record
   */
  async hardDelete(id: string, client?: PoolClient): Promise<boolean> {
    const executor = client || db;
    
    try {
      const query = `
        DELETE FROM ${this.tableName}
        WHERE ${this.primaryKey} = $1
        RETURNING id
      `;

      const result = await executor.query(query, [id]);
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.hardDelete:`, error);
      throw error;
    }
  }

  /**
   * Count records
   */
  async count(where: WhereCondition = {}): Promise<number> {
    try {
      const conditions: string[] = ['deleted_at IS NULL'];
      const values: any[] = [];

      Object.entries(where).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          conditions.push(`${key} = $${values.length + 1}`);
          values.push(value);
        }
      });

      const query = `
        SELECT COUNT(*) as count FROM ${this.tableName}
        WHERE ${conditions.join(' AND ')}
      `;

      const result = await db.query(query, values);
      return parseInt(result.rows[0].count);
    } catch (error) {
      logger.error(`Error in ${this.tableName}.count:`, error);
      throw error;
    }
  }

  /**
   * Bulk create
   */
  async bulkCreate(data: Partial<T>[], client?: PoolClient): Promise<T[]> {
    const executor = client || db;
    
    try {
      const results: T[] = [];
      
      for (const item of data) {
        const result = await this.create(item, executor);
        results.push(result);
      }
      
      return results;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.bulkCreate:`, error);
      throw error;
    }
  }

  /**
   * Bulk update
   */
  async bulkUpdate(ids: string[], data: Partial<T>, client?: PoolClient): Promise<number> {
    const executor = client || db;
    
    try {
      const updates: string[] = [];
      const values: any[] = [ids];

      Object.entries(data).forEach(([key, value]) => {
        if (key !== 'id' && key !== 'created_at' && key !== 'version') {
          updates.push(`${key} = $${values.length + 1}`);
          values.push(value);
        }
      });

      updates.push(`updated_at = NOW()`);
      updates.push(`version = version + 1`);

      const query = `
        UPDATE ${this.tableName}
        SET ${updates.join(', ')}
        WHERE ${this.primaryKey} = ANY($1)
          AND deleted_at IS NULL
      `;

      const result = await executor.query(query, values);
      return result.rowCount || 0;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.bulkUpdate:`, error);
      throw error;
    }
  }

  /**
   * Find or create
   */
  async findOrCreate(where: WhereCondition, data: Partial<T>): Promise<{ record: T; created: boolean }> {
    try {
      const existing = await this.findOne(where);
      
      if (existing) {
        return { record: existing, created: false };
      }
      
      const record = await this.create({ ...where, ...data });
      return { record, created: true };
    } catch (error) {
      logger.error(`Error in ${this.tableName}.findOrCreate:`, error);
      throw error;
    }
  }

  /**
   * Update or create
   */
  async updateOrCreate(where: WhereCondition, data: Partial<T>): Promise<T> {
    try {
      const existing = await this.findOne(where);
      
      if (existing) {
        return await this.update(existing.id, data) as T;
      }
      
      return await this.create({ ...where, ...data });
    } catch (error) {
      logger.error(`Error in ${this.tableName}.updateOrCreate:`, error);
      throw error;
    }
  }

  /**
   * Restore soft-deleted record
   */
  async restore(id: string, client?: PoolClient): Promise<boolean> {
    const executor = client || db;
    
    try {
      const query = `
        UPDATE ${this.tableName}
        SET deleted_at = NULL, updated_at = NOW(), version = version + 1
        WHERE ${this.primaryKey} = $1
        RETURNING id
      `;

      const result = await executor.query(query, [id]);
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.restore:`, error);
      throw error;
    }
  }

  /**
   * Execute raw query
   */
  async rawQuery(query: string, params?: any[]): Promise<any[]> {
    try {
      const result = await db.query(query, params);
      return result.rows;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.rawQuery:`, error);
      throw error;
    }
  }

  /**
   * Begin transaction
   */
  async beginTransaction(): Promise<PoolClient> {
    const client = await db.getClient();
    await client.query('BEGIN');
    return client;
  }

  /**
   * Commit transaction
   */
  async commitTransaction(client: PoolClient): Promise<void> {
    await client.query('COMMIT');
    client.release();
  }

  /**
   * Rollback transaction
   */
  async rollbackTransaction(client: PoolClient): Promise<void> {
    await client.query('ROLLBACK');
    client.release();
  }

  /**
   * Check if record exists
   */
  async exists(where: WhereCondition): Promise<boolean> {
    try {
      const conditions: string[] = [];
      const values: any[] = [];

      Object.entries(where).forEach(([key, value]) => {
        conditions.push(`${key} = $${values.length + 1}`);
        values.push(value);
      });

      conditions.push('deleted_at IS NULL');

      const query = `
        SELECT EXISTS(
          SELECT 1 FROM ${this.tableName}
          WHERE ${conditions.join(' AND ')}
        ) as exists
      `;

      const result = await db.query(query, values);
      return result.rows[0].exists;
    } catch (error) {
      logger.error(`Error in ${this.tableName}.exists:`, error);
      throw error;
    }
  }
}
