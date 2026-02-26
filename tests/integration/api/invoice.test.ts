import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../../src/app';
import { db } from '../../../src/config/database';
import { redis } from '../../../src/config/redis';
import { userRepository } from '../../../src/repositories/UserRepository';
import { businessRepository } from '../../../src/repositories/BusinessRepository';
import { invoiceRepository } from '../../../src/repositories/InvoiceRepository';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';

describe('Invoice API Integration Tests', () => {
  let server: any;
  let authToken: string;
  let businessId: string;
  let userId: string;
  let testInvoice: any;

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
    await db.query('DELETE FROM invoices WHERE business_id IN (SELECT id FROM businesses WHERE email LIKE $1)', ['%@test.com%']);
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

    // Create test invoice
    const invoiceData = {
      customer_tin: '0987654321',
      customer_name: 'Test Customer',
      customer_email: 'customer@test.com',
      customer_phone: '+2348098765432',
      issue_date: new Date().toISOString(),
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      line_items: [
        {
          description: 'Test Product 1',
          quantity: 2,
          unit_price: 50000,
          vat_rate: 7.5
        },
        {
          description: 'Test Product 2',
          quantity: 1,
          unit_price: 100000,
          discount_rate: 10
        }
      ],
      notes: 'Test invoice notes'
    };

    const createResponse = await request(app)
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${authToken}`)
      .send(invoiceData);

    testInvoice = createResponse.body.data;
  });

  describe('POST /api/v1/invoices', () => {
    it('should create invoice successfully', async () => {
      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'Another Customer',
        customer_email: 'another@test.com',
        issue_date: new Date().toISOString(),
        due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        line_items: [
          {
            description: 'New Product',
            quantity: 3,
            unit_price: 75000
          }
        ]
      };

      const response = await request(app)
        .post('/api/v1/invoices')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invoiceData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data.invoice_number).toBeDefined();
      expect(response.body.data.subtotal).toBe(225000);
      expect(response.body.data.vat_amount).toBe(16875);
      expect(response.body.data.total_amount).toBe(241875);
    });

    it('should return 400 for missing required fields', async () => {
      const invoiceData = {
        customer_name: 'Test Customer',
        line_items: []
      };

      const response = await request(app)
        .post('/api/v1/invoices')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invoiceData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 for negative quantities', async () => {
      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'Test Customer',
        issue_date: new Date().toISOString(),
        due_date: new Date().toISOString(),
        line_items: [
          {
            description: 'Test Product',
            quantity: -1,
            unit_price: 50000
          }
        ]
      };

      const response = await request(app)
        .post('/api/v1/invoices')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invoiceData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 403 without proper permissions', async () => {
      // Create staff user with limited permissions
      const staffUser = await userRepository.create({
        email: `staff-${uuidv4()}@test.com`,
        password_hash: await bcrypt.hash('Password123!', 10),
        first_name: 'Staff',
        last_name: 'User',
        business_id: businessId,
        role: 'staff',
        permissions: ['invoice:read'] // No create permission
      });

      const staffLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: staffUser.email,
          password: 'Password123!'
        });

      const staffToken = staffLogin.body.data.tokens.accessToken;

      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'Test Customer',
        issue_date: new Date().toISOString(),
        due_date: new Date().toISOString(),
        line_items: [
          {
            description: 'Test Product',
            quantity: 1,
            unit_price: 50000
          }
        ]
      };

      const response = await request(app)
        .post('/api/v1/invoices')
        .set('Authorization', `Bearer ${staffToken}`)
        .send(invoiceData)
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Insufficient permissions');
    });
  });

  describe('GET /api/v1/invoices', () => {
    it('should get all invoices with pagination', async () => {
      const response = await request(app)
        .get('/api/v1/invoices')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ page: 1, limit: 10 })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('invoices');
      expect(response.body.data).toHaveProperty('total');
      expect(Array.isArray(response.body.data.invoices)).toBe(true);
    });

    it('should filter invoices by status', async () => {
      const response = await request(app)
        .get('/api/v1/invoices')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ status: 'draft' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.invoices.every((inv: any) => inv.status === 'draft')).toBe(true);
    });

    it('should filter invoices by date range', async () => {
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 7);
      const toDate = new Date();

      const response = await request(app)
        .get('/api/v1/invoices')
        .set('Authorization', `Bearer ${authToken}`)
        .query({
          fromDate: fromDate.toISOString(),
          toDate: toDate.toISOString()
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('GET /api/v1/invoices/:id', () => {
    it('should get invoice by ID', async () => {
      const response = await request(app)
        .get(`/api/v1/invoices/${testInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(testInvoice.id);
      expect(response.body.data).toHaveProperty('line_items');
      expect(Array.isArray(response.body.data.line_items)).toBe(true);
    });

    it('should return 404 for non-existent invoice', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .get(`/api/v1/invoices/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invoice not found');
    });
  });

  describe('PUT /api/v1/invoices/:id', () => {
    it('should update invoice successfully', async () => {
      const updates = {
        notes: 'Updated notes',
        terms: 'Net 30'
      };

      const response = await request(app)
        .put(`/api/v1/invoices/${testInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updates)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.notes).toBe('Updated notes');
      expect(response.body.data.terms).toBe('Net 30');
    });

    it('should return 400 for invalid updates', async () => {
      const updates = {
        due_date: 'invalid-date'
      };

      const response = await request(app)
        .put(`/api/v1/invoices/${testInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updates)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 404 for non-existent invoice', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .put(`/api/v1/invoices/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ notes: 'Test' })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invoice not found');
    });
  });

  describe('POST /api/v1/invoices/:id/submit-to-firs', () => {
    it('should submit invoice to FIRS', async () => {
      const response = await request(app)
        .post(`/api/v1/invoices/${testInvoice.id}/firs/submit`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeDefined();
    });

    it('should return 400 for already submitted invoice', async () => {
      // First submission
      await request(app)
        .post(`/api/v1/invoices/${testInvoice.id}/firs/submit`)
        .set('Authorization', `Bearer ${authToken}`);

      // Second submission
      const response = await request(app)
        .post(`/api/v1/invoices/${testInvoice.id}/firs/submit`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('already');
    });
  });

  describe('GET /api/v1/invoices/aging', () => {
    it('should get aging report', async () => {
      const response = await request(app)
        .get('/api/v1/invoices/aging')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('current');
      expect(response.body.data).toHaveProperty('days_1_30');
      expect(response.body.data).toHaveProperty('days_31_60');
      expect(response.body.data).toHaveProperty('days_61_90');
      expect(response.body.data).toHaveProperty('days_90_plus');
    });
  });

  describe('GET /api/v1/invoices/stats', () => {
    it('should get invoice statistics', async () => {
      const response = await request(app)
        .get('/api/v1/invoices/stats')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('total_invoices');
      expect(response.body.data).toHaveProperty('paid_invoices');
      expect(response.body.data).toHaveProperty('overdue_invoices');
      expect(response.body.data).toHaveProperty('total_amount');
    });
  });

  describe('GET /api/v1/invoices/search', () => {
    it('should search invoices by customer name', async () => {
      const response = await request(app)
        .get('/api/v1/invoices/search')
        .set('Authorization', `Bearer ${authToken}`)
        .query({ q: 'Test Customer' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('should return 400 without search query', async () => {
      const response = await request(app)
        .get('/api/v1/invoices/search')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Search query required');
    });
  });

  describe('GET /api/v1/invoices/:id/pdf', () => {
    it('should download invoice PDF', async () => {
      const response = await request(app)
        .get(`/api/v1/invoices/${testInvoice.id}/pdf`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.headers['content-disposition']).toContain('attachment');
    });

    it('should return 404 for non-existent invoice', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .get(`/api/v1/invoices/${fakeId}/pdf`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invoice not found');
    });
  });

  describe('DELETE /api/v1/invoices/:id', () => {
    it('should delete draft invoice', async () => {
      const response = await request(app)
        .delete(`/api/v1/invoices/${testInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Invoice deleted successfully');
    });

    it('should return 404 for non-existent invoice', async () => {
      const fakeId = uuidv4();
      const response = await request(app)
        .delete(`/api/v1/invoices/${fakeId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invoice not found');
    });

    it('should return 400 for approved invoice', async () => {
      // Submit to FIRS first
      await request(app)
        .post(`/api/v1/invoices/${testInvoice.id}/firs/submit`)
        .set('Authorization', `Bearer ${authToken}`);

      // Try to delete
      const response = await request(app)
        .delete(`/api/v1/invoices/${testInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Cannot delete invoice already approved by FIRS');
    });
  });
});
