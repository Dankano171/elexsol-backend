import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../../src/app';
import { db } from '../../../src/config/database';
import { redis } from '../../../src/config/redis';
import { userRepository } from '../../../src/repositories/UserRepository';
import { businessRepository } from '../../../src/repositories/BusinessRepository';
import { accountIntegrationRepository } from '../../../src/repositories/AccountIntegrationRepository';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';

describe('Integration API Integration Tests', () => {
  let server: any;
  let authToken: string;
  let businessId: string;
  let userId: string;
  let testIntegrationId: string;

  beforeAll(async () => {
    server = app.listen(0);
  });

  afterAll(async () => {
    await server.close();
    await db.close();
    await redis.quit();
  });

  beforeEach(async () => {
    // Clean database
    await db.query('DELETE FROM account_integrations WHERE business_id IN (SELECT id FROM businesses WHERE email LIKE $1)', ['%@test.com%']);
    await db.query('DELETE FROM users WHERE email LIKE $1', ['%@test.com%']);
    await db.query('DELETE FROM businesses WHERE email LIKE $1', ['%@test.com%']);

    // Create test business and user
    const businessData = {
      name: 'Test Business',
      legal_name: 'Test Business Ltd',
      tin: '1234567890',
      email: `business-${uuidv4()}@test.com`,
      phone: '+2348012345678',
      address: '123 Test Street',
      city: 'Lagos',
      state: 'Lagos',
      country: 'NG'
    };

    const business = await businessRepository.createBusiness(businessData, 'system');
    businessId = business.id;

    // Create user
    const hashedPassword = await bcrypt.hash('Password123!', 10);
    const user = await userRepository.create({
      email: `user-${uuidv4()}@test.com`,
      password_hash: hashedPassword,
      first_name: 'Test',
      last_name: 'User',
      business_id: businessId,
      role: 'admin'
    });
    userId = user.id;

    // Login to get token
    const loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: user.email,
        password: 'Password123!'
      });

    authToken = loginResponse.body.data.tokens.accessToken;

    // Create test integration
    const integration = await accountIntegrationRepository.createIntegration({
      business_id: businessId,
      provider: 'zoho',
      account_email: 'test@zoho.com',
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      scopes: ['ZohoBooks.fullaccess.all'],
      settings: { syncContacts: true }
    }, userId);

    testIntegrationId = integration.id;
  });

  describe('GET /api/v1/integrations', () => {
    it('should get all integrations', async () => {
      const response = await request(app)
        .get('/api/v1/integrations')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('should filter integrations by provider', async () => {
      const response = await request(app)
        .get('/api/v1/integrations')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ provider: 'zoho' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.every((i: any) => i.provider === 'zoho')).toBe(true);
    });
  });

  describe('GET /api/v1/integrations/:id', () => {
    it('should get integration by ID', async () => {
      const response = await request(app)
        .get(`/api/v1/integrations/${testIntegrationId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testIntegrationId);
      expect(response.body.data.provider).toBe('zoho');
    });

    it('should return 404 for non-existent integration', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .get(`/api/v1/integrations/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Integration not found');
    });
  });

  describe('POST /api/v1/integrations', () => {
    it('should connect Zoho integration', async () => {
      const integrationData = {
        provider: 'zoho',
        accountEmail: `new-${uuidv4()}@zoho.com`,
        accessToken: 'new-zoho-token',
        refreshToken: 'new-zoho-refresh',
        scopes: ['ZohoBooks.fullaccess.all'],
        settings: { syncContacts: true }
      };

      const response = await request(app)
        .post('/api/v1/integrations')
        .set('Authorization', `Bearer ${authToken}`)
        .send(integrationData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.provider).toBe('zoho');
      expect(response.body.data.account_email).toBe(integrationData.accountEmail);
    });

    it('should return 400 for invalid provider', async () => {
      const integrationData = {
        provider: 'invalid',
        accountEmail: 'test@invalid.com',
        accessToken: 'token'
      };

      const response = await request(app)
        .post('/api/v1/integrations')
        .set('Authorization', `Bearer ${authToken}`)
        .send(integrationData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid provider');
    });

    it('should return 409 for duplicate integration', async () => {
      const integrationData = {
        provider: 'zoho',
        accountEmail: 'test@zoho.com', // Already exists
        accessToken: 'another-token',
        scopes: ['ZohoBooks.fullaccess.all']
      };

      const response = await request(app)
        .post('/api/v1/integrations')
        .set('Authorization', `Bearer ${authToken}`)
        .send(integrationData)
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('already exists');
    });
  });

  describe('POST /api/v1/integrations/:id/sync', () => {
    it('should queue integration sync', async () => {
      const response = await request(app)
        .post(`/api/v1/integrations/${testIntegrationId}/sync`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Sync queued successfully');
    });

    it('should return 404 for non-existent integration', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .post(`/api/v1/integrations/${fakeId}/sync`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Integration not found');
    });
  });

  describe('PUT /api/v1/integrations/:id/settings', () => {
    it('should update integration settings', async () => {
      const settings = {
        syncContacts: false,
        syncInvoices: true,
        autoSync: true,
        syncInterval: 120
      };

      const response = await request(app)
        .put(`/api/v1/integrations/${testIntegrationId}/settings`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(settings)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.settings.syncContacts).toBe(false);
      expect(response.body.data.settings.syncInvoices).toBe(true);
      expect(response.body.data.settings.autoSync).toBe(true);
    });

    it('should return 400 for invalid settings', async () => {
      const settings = {
        syncInterval: -10
      };

      const response = await request(app)
        .put(`/api/v1/integrations/${testIntegrationId}/settings`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(settings)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('GET /api/v1/integrations/:id/status', () => {
    it('should get integration status', async () => {
      const response = await request(app)
        .get(`/api/v1/integrations/${testIntegrationId}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('status');
      expect(response.body.data).toHaveProperty('syncStatus');
      expect(response.body.data).toHaveProperty('health');
    });
  });

  describe('GET /api/v1/integrations/stats', () => {
    it('should get provider statistics', async () => {
      const response = await request(app)
        .get('/api/v1/integrations/stats')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/integrations/webhooks', () => {
    it('should get webhook endpoints', async () => {
      const response = await request(app)
        .get('/api/v1/integrations/webhooks')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('POST /api/v1/integrations/:id/test', () => {
    it('should test integration connection', async () => {
      const response = await request(app)
        .post(`/api/v1/integrations/${testIntegrationId}/test`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('DELETE /api/v1/integrations/:id', () => {
    it('should disconnect integration', async () => {
      const response = await request(app)
        .delete(`/api/v1/integrations/${testIntegrationId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Integration disconnected successfully');
    });

    it('should return 404 for non-existent integration', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .delete(`/api/v1/integrations/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Integration not found');
    });
  });

  describe('GET /api/v1/integrations/oauth/:provider', () => {
    it('should get OAuth URL for Zoho', async () => {
      const response = await request(app)
        .get('/api/v1/integrations/oauth/zoho')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('url');
      expect(response.body.data.url).toContain('accounts.zoho.com');
    });

    it('should return 400 for unsupported provider', async () => {
      const response = await request(app)
        .get('/api/v1/integrations/oauth/invalid')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Provider does not support OAuth');
    });
  });
});
