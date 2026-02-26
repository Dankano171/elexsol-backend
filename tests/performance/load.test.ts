import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { db } from '../../src/config/database';
import { redis } from '../../src/config/redis';
import { v4 as uuidv4 } from 'uuid';
import autocannon from 'autocannon';

describe('Load Testing', () => {
  let server: any;
  let baseURL: string;

  beforeAll(async () => {
    server = app.listen(0);
    const address = server.address();
    baseURL = `http://localhost:${address.port}`;
  });

  afterAll(async () => {
    await server.close();
    await db.close();
    await redis.quit();
  });

  describe('API Endpoint Performance', () => {
    it('should handle high load on health endpoint', async () => {
      const result = await autocannon({
        url: `${baseURL}/health`,
        connections: 100,
        duration: 10,
        requests: [
          {
            method: 'GET',
            path: '/health'
          }
        ]
      });

      expect(result.errors).toBe(0);
      expect(result.timeouts).toBe(0);
      expect(result.non2xx).toBe(0);
      expect(result.requests.total).toBeGreaterThan(1000);
      expect(result.latency.average).toBeLessThan(100); // Average latency < 100ms
    });

    it('should handle concurrent authentication requests', async () => {
      const result = await autocannon({
        url: baseURL,
        connections: 50,
        duration: 10,
        requests: [
          {
            method: 'POST',
            path: '/api/v1/auth/login',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              email: `load-test-${uuidv4()}@test.com`,
              password: 'Password123!'
            })
          }
        ]
      });

      expect(result.errors).toBeLessThan(result.requests.total * 0.01); // Less than 1% errors
      expect(result.timeouts).toBe(0);
    });

    it('should handle concurrent invoice creation', async () => {
      // First, create a test user and get token
      const userEmail = `load-test-${uuidv4()}@test.com`;
      
      // Register user
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: userEmail,
          password: 'Password123!',
          first_name: 'Load',
          last_name: 'Test'
        });

      // Login to get token
      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: userEmail,
          password: 'Password123!'
        });

      const token = loginResponse.body.data.tokens.accessToken;

      const result = await autocannon({
        url: baseURL,
        connections: 20,
        duration: 10,
        requests: [
          {
            method: 'POST',
            path: '/api/v1/invoices',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
              customer_tin: '0987654321',
              customer_name: 'Load Test Customer',
              issue_date: new Date().toISOString(),
              due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              line_items: [
                {
                  description: 'Load Test Product',
                  quantity: 1,
                  unit_price: 50000
                }
              ]
            })
          }
        ]
      });

      expect(result.errors).toBeLessThan(result.requests.total * 0.05); // Less than 5% errors
      expect(result.timeouts).toBe(0);
      expect(result.latency.average).toBeLessThan(500); // Average latency < 500ms
    });

    it('should handle concurrent webhook requests', async () => {
      const result = await autocannon({
        url: baseURL,
        connections: 50,
        duration: 10,
        requests: [
          {
            method: 'POST',
            path: '/webhook/zoho',
            headers: {
              'Content-Type': 'application/json',
              'x-zoho-signature': 'test-signature'
            },
            body: JSON.stringify({
              event: 'invoice.created',
              organization_id: 'test-org',
              data: {
                invoice_id: 'test-invoice'
              }
            })
          }
        ]
      });

      // Webhooks should always return 200
      expect(result.non2xx).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.timeouts).toBe(0);
    });

    it('should handle concurrent report generation', async () => {
      // Create test user and get token
      const userEmail = `load-test-${uuidv4()}@test.com`;
      
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: userEmail,
          password: 'Password123!',
          first_name: 'Load',
          last_name: 'Test'
        });

      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: userEmail,
          password: 'Password123!'
        });

      const token = loginResponse.body.data.tokens.accessToken;

      const result = await autocannon({
        url: baseURL,
        connections: 10,
        duration: 10,
        requests: [
          {
            method: 'GET',
            path: '/api/v1/analytics/dashboard',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          },
          {
            method: 'GET',
            path: '/api/v1/analytics/payment-velocity',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          },
          {
            method: 'GET',
            path: '/api/v1/analytics/cashflow',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        ]
      });

      expect(result.errors).toBeLessThan(result.requests.total * 0.02); // Less than 2% errors
      expect(result.timeouts).toBe(0);
    });

    it('should handle concurrent integration sync requests', async () => {
      // Create test user with integration
      const userEmail = `load-test-${uuidv4()}@test.com`;
      
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: userEmail,
          password: 'Password123!',
          first_name: 'Load',
          last_name: 'Test'
        });

      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: userEmail,
          password: 'Password123!'
        });

      const token = loginResponse.body.data.tokens.accessToken;

      // Create test integration
      const integrationResponse = await request(app)
        .post('/api/v1/integrations')
        .set('Authorization', `Bearer ${token}`)
        .send({
          provider: 'zoho',
          accountEmail: `load-${uuidv4()}@zoho.com`,
          accessToken: 'test-token',
          scopes: ['ZohoBooks.fullaccess.all']
        });

      const integrationId = integrationResponse.body.data.id;

      const result = await autocannon({
        url: baseURL,
        connections: 5,
        duration: 10,
        requests: [
          {
            method: 'POST',
            path: `/api/v1/integrations/${integrationId}/sync`,
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        ]
      });

      // Sync requests may fail if already syncing, but shouldn't error
      expect(result.timeouts).toBe(0);
    });
  });

  describe('Database Performance', () => {
    it('should handle concurrent database queries', async () => {
      const result = await autocannon({
        url: baseURL,
        connections: 100,
        duration: 10,
        requests: [
          {
            method: 'GET',
            path: '/health/db'
          }
        ]
      });

      expect(result.errors).toBe(0);
      expect(result.latency.average).toBeLessThan(50); // DB queries should be fast
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limits under load', async () => {
      const userEmail = `rate-test-${uuidv4()}@test.com`;
      
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: userEmail,
          password: 'Password123!',
          first_name: 'Rate',
          last_name: 'Test'
        });

      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: userEmail,
          password: 'Password123!'
        });

      const token = loginResponse.body.data.tokens.accessToken;

      // Send many rapid requests
      const results = await Promise.all(
        Array(100).fill(null).map(() => 
          request(app)
            .get('/api/v1/invoices')
            .set('Authorization', `Bearer ${token}`)
        )
      );

      // Some should be rate limited
      const rateLimited = results.filter(r => r.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  describe('Memory Usage', () => {
    it('should not leak memory under load', async () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // Run load test
      await autocannon({
        url: baseURL,
        connections: 50,
        duration: 30,
        requests: [
          {
            method: 'GET',
            path: '/health'
          },
          {
            method: 'GET',
            path: '/api/v1/invoices'
          }
        ]
      });

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = (finalMemory - initialMemory) / 1024 / 1024; // MB

      // Memory growth should be reasonable (less than 50MB)
      expect(memoryGrowth).toBeLessThan(50);
    });
  });
});

// Helper function to generate realistic load test data
function generateLoadTestData() {
  return {
    customers: Array(100).fill(null).map(() => ({
      tin: Math.floor(1000000000 + Math.random() * 9000000000).toString(),
      name: `Customer ${uuidv4().substring(0, 8)}`
    })),
    products: Array(50).fill(null).map(() => ({
      description: `Product ${uuidv4().substring(0, 8)}`,
      price: Math.floor(1000 + Math.random() * 99000)
    }))
  };
}
