import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoiceRepository } from '../../../src/repositories/InvoiceRepository';
import { businessRepository } from '../../../src/repositories/BusinessRepository';
import { firsService } from '../../../src/services/regulatory/FIRSService';
import { invoiceQueue } from '../../../src/services/queue/InvoiceQueue';
import { v4 as uuidv4 } from 'uuid';

// Mock dependencies
vi.mock('../../../src/repositories/InvoiceRepository');
vi.mock('../../../src/repositories/BusinessRepository');
vi.mock('../../../src/services/regulatory/FIRSService');
vi.mock('../../../src/services/queue/InvoiceQueue');

describe('Invoice Service', () => {
  const mockBusinessId = uuidv4();
  const mockInvoiceId = uuidv4();
  const mockUserId = uuidv4();

  const mockBusiness = {
    id: mockBusinessId,
    tin: '1234567890',
    legal_name: 'Test Business Ltd',
    invoice_prefix: 'TBL',
    next_invoice_number: 1,
    default_currency: 'NGN'
  };

  const mockInvoice = {
    id: mockInvoiceId,
    business_id: mockBusinessId,
    invoice_number: 'TBL-2025-00001',
    customer_tin: '0987654321',
    customer_name: 'Test Customer',
    subtotal: 100000,
    vat_amount: 7500,
    total_amount: 107500,
    status: 'draft',
    firs_status: 'pending',
    line_items: [
      {
        description: 'Test Item',
        quantity: 1,
        unit_price: 100000,
        subtotal: 100000,
        vat_amount: 7500,
        total: 107500
      }
    ]
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('createInvoice', () => {
    it('should create invoice successfully', async () => {
      // Arrange
      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'Test Customer',
        issue_date: new Date(),
        due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        line_items: [
          {
            description: 'Test Item',
            quantity: 1,
            unit_price: 100000
          }
        ]
      };

      vi.mocked(businessRepository.findById).mockResolvedValue(mockBusiness);
      vi.mocked(businessRepository.getNextInvoiceNumber).mockResolvedValue('TBL-2025-00001');
      vi.mocked(invoiceRepository.createInvoice).mockResolvedValue(mockInvoice);
      vi.mocked(invoiceQueue.addToQueue).mockResolvedValue({} as any);

      // Act
      const result = await invoiceRepository.createInvoice({
        ...invoiceData,
        business_id: mockBusinessId
      }, mockUserId);

      // Assert
      expect(result).toBeDefined();
      expect(result.invoice_number).toBe('TBL-2025-00001');
      expect(businessRepository.findById).toHaveBeenCalledWith(mockBusinessId);
      expect(businessRepository.getNextInvoiceNumber).toHaveBeenCalled();
      expect(invoiceQueue.addToQueue).toHaveBeenCalled();
    });

    it('should calculate VAT correctly', async () => {
      // Arrange
      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'Test Customer',
        issue_date: new Date(),
        due_date: new Date(),
        line_items: [
          {
            description: 'Item 1',
            quantity: 2,
            unit_price: 50000,
            vat_rate: 7.5
          },
          {
            description: 'Item 2',
            quantity: 1,
            unit_price: 100000,
            vat_rate: 7.5,
            discount_rate: 10
          }
        ]
      };

      vi.mocked(businessRepository.findById).mockResolvedValue(mockBusiness);
      vi.mocked(businessRepository.getNextInvoiceNumber).mockResolvedValue('TBL-2025-00001');
      
      const expectedSubtotal = (2 * 50000) + 100000; // 200,000
      const expectedDiscount = 100000 * 0.1; // 10,000
      const expectedVAT = (expectedSubtotal - expectedDiscount) * 0.075; // 14,250
      const expectedTotal = expectedSubtotal - expectedDiscount + expectedVAT; // 204,250

      // Act
      const result = await invoiceRepository.createInvoice({
        ...invoiceData,
        business_id: mockBusinessId
      }, mockUserId);

      // Assert
      expect(result.subtotal).toBe(expectedSubtotal);
      expect(result.discount_amount).toBe(expectedDiscount);
      expect(result.vat_amount).toBeCloseTo(expectedVAT);
      expect(result.total_amount).toBeCloseTo(expectedTotal);
    });

    it('should throw error if business not found', async () => {
      // Arrange
      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'Test Customer',
        issue_date: new Date(),
        due_date: new Date(),
        line_items: []
      };

      vi.mocked(businessRepository.findById).mockResolvedValue(null);

      // Act & Assert
      await expect(invoiceRepository.createInvoice({
        ...invoiceData,
        business_id: mockBusinessId
      }, mockUserId)).rejects.toThrow('Business not found');
    });

    it('should throw error if no line items', async () => {
      // Arrange
      const invoiceData = {
        customer_tin: '0987654321',
        customer_name: 'Test Customer',
        issue_date: new Date(),
        due_date: new Date(),
        line_items: []
      };

      vi.mocked(businessRepository.findById).mockResolvedValue(mockBusiness);

      // Act & Assert
      await expect(invoiceRepository.createInvoice({
        ...invoiceData,
        business_id: mockBusinessId
      }, mockUserId)).rejects.toThrow('Invoice must have at least one line item');
    });
  });

  describe('submitToFIRS', () => {
    it('should submit invoice to FIRS successfully', async () => {
      // Arrange
      const mockSubmission = {
        id: uuidv4(),
        status: 'submitted',
        irn: 'FIRS123456789'
      };

      vi.mocked(invoiceRepository.findById).mockResolvedValue(mockInvoice);
      vi.mocked(firsService.submitInvoice).mockResolvedValue(mockSubmission);

      // Act
      const result = await firsService.submitInvoice(mockBusinessId, mockInvoiceId);

      // Assert
      expect(result).toBeDefined();
      expect(result.irn).toBe('FIRS123456789');
      expect(invoiceRepository.findById).toHaveBeenCalledWith(mockInvoiceId);
      expect(firsService.submitInvoice).toHaveBeenCalledWith(mockBusinessId, mockInvoiceId);
    });

    it('should throw error if invoice not found', async () => {
      // Arrange
      vi.mocked(invoiceRepository.findById).mockResolvedValue(null);

      // Act & Assert
      await expect(firsService.submitInvoice(mockBusinessId, mockInvoiceId))
        .rejects.toThrow('Invoice not found');
    });

    it('should throw error if invoice already submitted', async () => {
      // Arrange
      const submittedInvoice = { ...mockInvoice, firs_status: 'submitted' };
      vi.mocked(invoiceRepository.findById).mockResolvedValue(submittedInvoice);

      // Act & Assert
      await expect(firsService.submitInvoice(mockBusinessId, mockInvoiceId))
        .rejects.toThrow('Invoice already submitted');
    });
  });

  describe('updatePaymentStatus', () => {
    it('should update payment status to paid', async () => {
      // Arrange
      const paidInvoice = { ...mockInvoice, amount_paid: 107500, balance_due: 0 };
      vi.mocked(invoiceRepository.findById).mockResolvedValue(mockInvoice);
      vi.mocked(invoiceRepository.updatePaymentStatus).mockResolvedValue(paidInvoice);

      // Act
      const result = await invoiceRepository.updatePaymentStatus(mockInvoiceId, 107500, new Date());

      // Assert
      expect(result.payment_status).toBe('paid');
      expect(result.amount_paid).toBe(107500);
      expect(result.balance_due).toBe(0);
    });

    it('should update payment status to partial', async () => {
      // Arrange
      const partialInvoice = { ...mockInvoice, amount_paid: 50000, balance_due: 57500 };
      vi.mocked(invoiceRepository.findById).mockResolvedValue(mockInvoice);
      vi.mocked(invoiceRepository.updatePaymentStatus).mockResolvedValue(partialInvoice);

      // Act
      const result = await invoiceRepository.updatePaymentStatus(mockInvoiceId, 50000, new Date());

      // Assert
      expect(result.payment_status).toBe('partial');
      expect(result.amount_paid).toBe(50000);
      expect(result.balance_due).toBe(57500);
    });

    it('should throw error if invoice not found', async () => {
      // Arrange
      vi.mocked(invoiceRepository.findById).mockResolvedValue(null);

      // Act & Assert
      await expect(invoiceRepository.updatePaymentStatus(mockInvoiceId, 50000, new Date()))
        .rejects.toThrow('Invoice not found');
    });
  });

  describe('getStatistics', () => {
    it('should return correct invoice statistics', async () => {
      // Arrange
      const mockStats = {
        total_invoices: 10,
        paid_invoices: 5,
        overdue_invoices: 2,
        total_amount: 1000000,
        total_paid: 500000,
        total_outstanding: 500000,
        avg_days_to_payment: 15.5
      };

      vi.mocked(invoiceRepository.getStatistics).mockResolvedValue(mockStats);

      // Act
      const stats = await invoiceRepository.getStatistics(mockBusinessId);

      // Assert
      expect(stats).toEqual(mockStats);
      expect(invoiceRepository.getStatistics).toHaveBeenCalledWith(mockBusinessId);
    });
  });
});
