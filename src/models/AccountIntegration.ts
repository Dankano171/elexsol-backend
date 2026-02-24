// src/models/AccountIntegration.ts
import { PoolClient } from 'pg';
import { encrypt, decrypt } from '../lib/encryption/vault.service';
import { db } from '../config/database';

export interface IAccountIntegration {
  id: string;
  business_id: string;
  provider: 'zoho' | 'whatsapp' | 'quickbooks';
  account_email: string;
  account_id?: string;
  encrypted_access_token: Buffer;
  encrypted_refresh_token?: Buffer;
  token_expires_at?: Date;
  scopes: string[];
  webhook_secret?: string;
  webhook_url?: string;
  settings: Record<string, any>;
  status: 'active' | 'expired' | 'revoked' | 'pending';
  last_sync_at?: Date;
  sync_status?: 'idle' | 'syncing' | 'failed';
  sync_error?: string;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export class AccountIntegrationModel {
  static async create(
    data: Omit<IAccountIntegration, 'id' | 'created_at' | 'updated_at' | 'encrypted_access_token' | 'encrypted_refresh_token'> & {
      access_token: string;
      refresh_token?: string;
    },
    client?: PoolClient
  ): Promise<IAccountIntegration> {
    const query = `
      INSERT INTO account_integrations (
        id, business_id, provider, account_email, account_id,
        encrypted_access_token, encrypted_refresh_token, token_expires_at,
        scopes, webhook_secret, webhook_url, settings, status,
        metadata, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4,
        $5, $6, $7, $8, $9, $10, $11, $12,
        $13, NOW(), NOW()
      ) RETURNING *
    `;

    // Encrypt tokens before storage
    const encryptedAccessToken = encrypt(data.access_token);
    const encryptedRefreshToken = data.refresh_token ? encrypt(data.refresh_token) : null;

    const values = [
      data.business_id,
      data.provider,
      data.account_email,
      data.account_id || null,
      encryptedAccessToken,
      encryptedRefreshToken,
      data.token_expires_at || null,
      data.scopes,
      data.webhook_secret || null,
      data.webhook_url || null,
      data.settings || {},
      data.status || 'pending',
      data.metadata || {}
    ];

    const executor = client || db;
    const result = await executor.query(query, values);
    return result.rows[0];
  }

  static async findByBusiness(
    businessId: string,
    provider?: string
  ): Promise<IAccountIntegration[]> {
    let query = `
      SELECT * FROM account_integrations 
      WHERE business_id = $1
    `;
    const params: any[] = [businessId];

    if (provider) {
      query += ` AND provider = $2`;
      params.push(provider);
    }

    query += ` ORDER BY created_at DESC`;

    const result = await db.query(query, params);
    return result.rows;
  }

  static async getAccessToken(
    integrationId: string,
    businessId: string
  ): Promise<string | null> {
    const result = await db.query(
      `SELECT encrypted_access_token FROM account_integrations 
       WHERE id = $1 AND business_id = $2 AND status = 'active'`,
      [integrationId, businessId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return decrypt(result.rows[0].encrypted_access_token);
  }

  static async updateSyncStatus(
    id: string,
    status: 'idle' | 'syncing' | 'failed',
    error?: string
  ): Promise<void> {
    await db.query(
      `UPDATE account_integrations 
       SET sync_status = $1, sync_error = $2, last_sync_at = NOW()
       WHERE id = $3`,
      [status, error || null, id]
    );
  }
}
