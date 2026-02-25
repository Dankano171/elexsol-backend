import { Request, Response } from 'express';
import { transactionRepository } from '../../repositories/TransactionRepository';
import { invoiceRepository } from '../../repositories/InvoiceRepository';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { logger } from '../../config/logger';
import { permissionService } from '../../services/auth/PermissionService';

export class TransactionController {
  /**
   * Create transaction
   */
  async createTransaction(req: Request, res: Response): Promise<void> {
    try {
      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'transaction:create'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const transactionData = {
        ...req.body,
        business_id: req.user.business_id
      };

      // Validate invoice if provided
      if (transactionData.invoice_id) {
        const invoice = await invoiceRepository.findOne({
          id: transactionData.invoice_id,
          business_id: req.user.business_id
        });

        if (!invoice) {
          res.status(404).json({
            success: false,
            error: 'Invoice not found'
          });
          return;
        }
      }

      const transaction = await transactionRepository.createTransaction(
        transactionData,
        req.user.id
      );

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'TRANSACTION_CREATE',
        entity_type: 'transaction',
        entity_id: transaction.id,
        metadata: {
          amount: transaction.amount,
          reference: transaction.transaction_reference
        }
      });

      res.status(201).json({
        success: true,
        data: transaction
      });
    } catch (error) {
      logger.error('Create transaction error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get transaction by ID
   */
  async getTransactionById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'transaction:read',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const transaction = await transactionRepository.findOne({
        id,
        business_id: req.user.business_id
      });

      if (!transaction) {
        res.status(404).json({
          success: false,
          error: 'Transaction not found'
        });
        return;
      }

      res.json({
        success: true,
        data: transaction
      });
    } catch (error) {
      logger.error('Get transaction error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get all transactions
   */
  async getAllTransactions(req: Request, res: Response): Promise<void> {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        fromDate,
        toDate,
        paymentMethod
      } = req.query;

      const result = await transactionRepository.findByBusiness(
        req.user.business_id,
        {
          status: status as any,
          fromDate: fromDate ? new Date(fromDate as string) : undefined,
          toDate: toDate ? new Date(toDate as string) : undefined,
          paymentMethod: paymentMethod as any,
          limit: Number(limit),
          offset: (Number(page) - 1) * Number(limit)
        }
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Get all transactions error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get transactions by invoice
   */
  async getTransactionsByInvoice(req: Request, res: Response): Promise<void> {
    try {
      const { invoiceId } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'transaction:read'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const transactions = await transactionRepository.getByInvoice(invoiceId);

      res.json({
        success: true,
        data: transactions
      });
    } catch (error) {
      logger.error('Get transactions by invoice error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Complete transaction
   */
  async completeTransaction(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'transaction:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const transaction = await transactionRepository.completeTransaction(id);

      if (!transaction) {
        res.status(404).json({
          success: false,
          error: 'Transaction not found'
        });
        return;
      }

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'TRANSACTION_COMPLETE',
        entity_type: 'transaction',
        entity_id: id,
        metadata: {
          amount: transaction.amount,
          reference: transaction.transaction_reference
        }
      });

      res.json({
        success: true,
        data: transaction
      });
    } catch (error) {
      logger.error('Complete transaction error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Fail transaction
   */
  async failTransaction(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'transaction:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const transaction = await transactionRepository.failTransaction(id, reason);

      if (!transaction) {
        res.status(404).json({
          success: false,
          error: 'Transaction not found'
        });
        return;
      }

      res.json({
        success: true,
        data: transaction
      });
    } catch (error) {
      logger.error('Fail transaction error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Refund transaction
   */
  async refundTransaction(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'transaction:update',
        id
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      const transaction = await transactionRepository.refundTransaction(
        id,
        reason,
        req.user.id
      );

      if (!transaction) {
        res.status(404).json({
          success: false,
          error: 'Transaction not found'
        });
        return;
      }

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'TRANSACTION_REFUND',
        entity_type: 'transaction',
        entity_id: id,
        metadata: { reason }
      });

      res.json({
        success: true,
        data: transaction
      });
    } catch (error) {
      logger.error('Refund transaction error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get transaction by reference
   */
  async getByReference(req: Request, res: Response): Promise<void> {
    try {
      const { reference } = req.params;

      const transaction = await transactionRepository.findByReference(reference);

      if (!transaction || transaction.business_id !== req.user.business_id) {
        res.status(404).json({
          success: false,
          error: 'Transaction not found'
        });
        return;
      }

      res.json({
        success: true,
        data: transaction
      });
    } catch (error) {
      logger.error('Get by reference error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Reconcile transactions
   */
  async reconcileTransactions(req: Request, res: Response): Promise<void> {
    try {
      const { transactionIds } = req.body;

      const hasPermission = await permissionService.hasPermission(
        req.user.id,
        'transaction:update'
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
        return;
      }

      // Verify all transactions belong to business
      for (const id of transactionIds) {
        const transaction = await transactionRepository.findOne({
          id,
          business_id: req.user.business_id
        });

        if (!transaction) {
          res.status(404).json({
            success: false,
            error: `Transaction ${id} not found`
          });
          return;
        }
      }

      const count = await transactionRepository.reconcile(transactionIds, req.user.id);

      // Log audit
      await auditLogRepository.log({
        user_id: req.user.id,
        business_id: req.user.business_id,
        action: 'TRANSACTION_RECONCILE',
        entity_type: 'transaction',
        metadata: { count, transactionIds }
      });

      res.json({
        success: true,
        data: { reconciled: count }
      });
    } catch (error) {
      logger.error('Reconcile transactions error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get unreconciled transactions
   */
  async getUnreconciled(req: Request, res: Response): Promise<void> {
    try {
      const { days } = req.query;

      const transactions = await transactionRepository.getUnreconciled(
        req.user.business_id,
        days ? Number(days) : undefined
      );

      res.json({
        success: true,
        data: transactions
      });
    } catch (error) {
      logger.error('Get unreconciled error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get daily summary
   */
  async getDailySummary(req: Request, res: Response): Promise<void> {
    try {
      const { date } = req.query;

      const summary = await transactionRepository.getDailySummary(
        req.user.business_id,
        date ? new Date(date as string) : new Date()
      );

      res.json({
        success: true,
        data: summary
      });
    } catch (error) {
      logger.error('Get daily summary error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get monthly summary
   */
  async getMonthlySummary(req: Request, res: Response): Promise<void> {
    try {
      const { year, month } = req.query;

      const summary = await transactionRepository.getMonthlySummary(
        req.user.business_id,
        Number(year),
        Number(month)
      );

      res.json({
        success: true,
        data: summary
      });
    } catch (error) {
      logger.error('Get monthly summary error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get reconciliation report
   */
  async getReconciliationReport(req: Request, res: Response): Promise<void> {
    try {
      const { fromDate, toDate } = req.query;

      if (!fromDate || !toDate) {
        res.status(400).json({
          success: false,
          error: 'fromDate and toDate are required'
        });
        return;
      }

      const report = await transactionRepository.getReconciliationReport(
        req.user.business_id,
        new Date(fromDate as string),
        new Date(toDate as string)
      );

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('Get reconciliation report error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get payment method statistics
   */
  async getPaymentMethodStats(req: Request, res: Response): Promise<void> {
    try {
      const { fromDate, toDate } = req.query;

      const stats = await transactionRepository.getPaymentMethodStats(
        req.user.business_id,
        fromDate ? new Date(fromDate as string) : new Date(new Date().setMonth(new Date().getMonth() - 1)),
        toDate ? new Date(toDate as string) : new Date()
      );

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get payment method stats error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const transactionController = new TransactionController();
