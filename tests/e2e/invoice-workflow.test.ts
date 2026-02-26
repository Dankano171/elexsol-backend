import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import { db } from '../../src/config/database';
import { redis } from '../../src/config/redis';
import { userRepository } from '../../src/repositories/UserRepository';
import { businessRepository } from '../../src/repositories/BusinessRepository';
import { invoiceRepository } from '../../src/repositories/InvoiceRepository';
import { transactionRepository } from '../../src/repositories/TransactionRepository';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';

describe('Invoice Full Workflow E2E Tests', () => {
  let server: any;
  let authToken: string;
  let businessId: string;
  let userId: string;
  let createdInvoice: any;
  let createdTransaction: any;

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
    await db.query('DELETE FROM transactions WHERE invoice_id IN (SELECT id FROM invoices WHERE business_id IN (SELECT id FROM businesses WHERE email LIKE $1))', ['%@test.com%']);
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
  });

  describe('Complete Invoice Lifecycle', () => {
    it('should complete full invoice workflow: create → view → update → record payment → reconcile', async () => {
      // 1. CREATE INVOICE
      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'E2E Test Customer',
        customer_email: 'e2e-customer@test.com',
        customer_phone: '+2348098765432',
        issue_date: new Date().toISOString(),
        due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        line_items: [
          {
            description: 'E2E Test Product',
            quantity: 5,
            unit_price: 100000,
            vat_rate: 7.5
          }
        ],
        notes: 'E2E test invoice'
      };

      const createResponse = await request(app)
        .post('/api/v1/invoices')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invoiceData)
        .expect(201);

      expect(createResponse.body.success).toBe(true);
      createdInvoice = createResponse.body.data;
      expect(createdInvoice.invoice_number).toBeDefined();
      expect(createdInvoice.subtotal).toBe(500000);
      expect(createdInvoice.vat_amount).toBe(37500);
      expect(createdInvoice.total_amount).toBe(537500);
      expect(createdInvoice.status).toBe('draft');

      // 2. VIEW INVOICE
      const viewResponse = await request(app)
        .get(`/api/v1/invoices/${createdInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(viewResponse.body.success).toBe(true);
      expect(viewResponse.body.data.id).toBe(createdInvoice.id);
      expect(viewResponse.body.data.line_items.length).toBe(1);

      // 3. UPDATE INVOICE (add discount)
      const updateData = {
        notes: 'Updated: Added 10% discount',
        line_items: [
          {
            ...invoiceData.line_items[0],
            discount_rate: 10
          }
        ]
      };

      const updateResponse = await request(app)
        .put(`/api/v1/invoices/${createdInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData)
        .expect(200);

      expect(updateResponse.body.success).toBe(true);
      expect(updateResponse.body.data.notes).toBe('Updated: Added 10% discount');
      
      // Recalculate with discount
      const discountedSubtotal = 500000 * 0.9; // 450,000
      const discountedVAT = discountedSubtotal * 0.075; // 33,750
      expect(updateResponse.body.data.subtotal).toBe(500000); // Original subtotal (before discount)
      expect(updateResponse.body.data.discount_amount).toBe(50000); // 10% of 500,000
      expect(updateResponse.body.data.vat_amount).toBeCloseTo(33750);
      expect(updateResponse.body.data.total_amount).toBeCloseTo(483750);

      // 4. SUBMIT TO FIRS
      const submitResponse = await request(app)
        .post(`/api/v1/invoices/${createdInvoice.id}/firs/submit`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(submitResponse.body.success).toBe(true);

      // Check invoice status after submission
      const afterSubmitResponse = await request(app)
        .get(`/api/v1/invoices/${createdInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(afterSubmitResponse.body.data.firs_status).toBe('submitted');

      // 5. RECORD PAYMENT (partial)
      const transactionData = {
        invoice_id: createdInvoice.id,
        amount: 200000,
        payment_method: 'transfer',
        payment_provider: 'paystack',
        payer_name: 'E2E Test Customer',
        payer_email: 'e2e-customer@test.com',
        metadata: {
          reference: `TXN-${uuidv4()}`
        }
      };

      const paymentResponse = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${authToken}`)
        .send(transactionData)
        .expect(201);

      expect(paymentResponse.body.success).toBe(true);
      createdTransaction = paymentResponse.body.data;

      // Complete the transaction
      const completeResponse = await request(app)
        .post(`/api/v1/transactions/${createdTransaction.id}/complete`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({})
        .expect(200);

      expect(completeResponse.body.success).toBe(true);

      // Check invoice after partial payment
      const afterPaymentResponse = await request(app)
        .get(`/api/v1/invoices/${createdInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(afterPaymentResponse.body.data.amount_paid).toBe(200000);
      expect(afterPaymentResponse.body.data.balance_due).toBeCloseTo(283750);
      expect(afterPaymentResponse.body.data.payment_status).toBe('partial');

      // 6. RECORD FINAL PAYMENT
      const finalPaymentData = {
        invoice_id: createdInvoice.id,
        amount: 283750,
        payment_method: 'transfer',
        payment_provider: 'paystack',
        payer_name: 'E2E Test Customer',
        payer_email: 'e2e-customer@test.com',
        metadata: {
          reference: `TXN-${uuidv4()}`
        }
      };

      const finalPaymentResponse = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${authToken}`)
        .send(finalPaymentData)
        .expect(201);

      const finalTransaction = finalPaymentResponse.body.data;

      await request(app)
        .post(`/api/v1/transactions/${finalTransaction.id}/complete`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({})
        .expect(200);

      // Check invoice after full payment
      const afterFullPaymentResponse = await request(app)
        .get(`/api/v1/invoices/${createdInvoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(afterFullPaymentResponse.body.data.amount_paid).toBe(483750);
      expect(afterFullPaymentResponse.body.data.balance_due).toBe(0);
      expect(afterFullPaymentResponse.body.data.payment_status).toBe('paid');
      expect(afterFullPaymentResponse.body.data.paid_at).toBeDefined();

      // 7. RECONCILE TRANSACTIONS
      const reconcileResponse = await request(app)
        .post('/api/v1/transactions/reconcile')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          transactionIds: [createdTransaction.id, finalTransaction.id]
        })
        .expect(200);

      expect(reconcileResponse.body.success).toBe(true);
      expect(reconcileResponse.body.data.reconciled).toBe(2);

      // 8. GENERATE INVOICE PDF
      const pdfResponse = await request(app)
        .get(`/api/v1/invoices/${createdInvoice.id}/pdf`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(pdfResponse.headers['content-type']).toBe('application/pdf');

      // 9. GET INVOICE STATISTICS
      const statsResponse = await request(app)
        .get('/api/v1/invoices/stats')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(statsResponse.body.success).toBe(true);
      expect(statsResponse.body.data.paid_invoices).toBe(1);
      expect(statsResponse.body.data.total_amount).toBe(483750);
      expect(statsResponse.body.data.total_paid).toBe(483750);

      // 10. GET AGING REPORT
      const agingResponse = await request(app)
        .get('/api/v1/invoices/aging')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(agingResponse.body.success).toBe(true);
      expect(agingResponse.body.data.current).toBe(0); // Invoice is paid
    }, 30000); // 30 second timeout for this long test

    it('should handle credit note workflow', async () => {
      // 1. CREATE INVOICE
      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'Credit Note Customer',
        issue_date: new Date().toISOString(),
        due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        line_items: [
          {
            description: 'Product to be returned',
            quantity: 2,
            unit_price: 50000
          }
        ]
      };

      const createResponse = await request(app)
        .post('/api/v1/invoices')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invoiceData)
        .expect(201);

      const invoice = createResponse.body.data;

      // 2. RECORD PAYMENT
      const paymentData = {
        invoice_id: invoice.id,
        amount: 107500, // 2 * 50000 + 7.5% VAT
        payment_method: 'transfer',
        payer_name: 'Credit Note Customer'
      };

      const paymentResponse = await request(app)
        .post('/api/v1/transactions')
        .set('Authorization', `Bearer ${authToken}`)
        .send(paymentData)
        .expect(201);

      const transaction = paymentResponse.body.data;

      await request(app)
        .post(`/api/v1/transactions/${transaction.id}/complete`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({})
        .expect(200);

      // 3. CREATE CREDIT NOTE (would be implemented as negative invoice)
      // This is a placeholder - actual credit note endpoint would be tested here

      // 4. PROCESS REFUND
      const refundResponse = await request(app)
        .post(`/api/v1/transactions/${transaction.id}/refund`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ reason: 'Customer returned products' })
        .expect(200);

      expect(refundResponse.body.success).toBe(true);
      expect(refundResponse.body.data.status).toBe('refunded');

      // 5. VERIFY INVOICE STATUS
      const invoiceResponse = await request(app)
        .get(`/api/v1/invoices/${invoice.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(invoiceResponse.body.data.payment_status).toBe('refunded');
    });
  });
});
