import { Router } from 'express';
import { transactionController } from '../../controllers/v1/TransactionController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import Joi from 'joi';

const router = Router();

// Validation schemas
const createTransactionSchema = Joi.object({
  invoice_id: Joi.string().uuid(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).default('NGN'),
  payment_method: Joi.string().valid(
    'cash', 'transfer', 'cheque', 'card', 'pos', 'direct_debit', 'other'
  ).required(),
  payment_provider: Joi.string(),
  transaction_date: Joi.date().iso().default(() => new Date()),
  payer_name: Joi.string().required(),
  payer_email: Joi.string().email(),
  payer_phone: Joi.string().pattern(/^\+?[\d\s-]{10,}$/),
  payer_account: Joi.string(),
  external_reference: Joi.string(),
  metadata: Joi.object()
});

const updateTransactionSchema = Joi.object({
  status: Joi.string().valid('pending', 'completed', 'failed', 'refunded', 'cancelled'),
  failure_reason: Joi.string().when('status', {
    is: 'failed',
    then: Joi.required()
  })
}).min(1);

const completeTransactionSchema = Joi.object({
  settledDate: Joi.date().iso()
});

const refundTransactionSchema = Joi.object({
  reason: Joi.string().required()
});

const failTransactionSchema = Joi.object({
  reason: Joi.string().required()
});

const reconcileTransactionsSchema = Joi.object({
  transactionIds: Joi.array().items(Joi.string().uuid()).min(1).required()
});

const transactionIdParamSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const invoiceIdParamSchema = Joi.object({
  invoiceId: Joi.string().uuid().required()
});

const referenceParamSchema = Joi.object({
  reference: Joi.string().required()
});

const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('pending', 'completed', 'failed', 'refunded', 'cancelled'),
  fromDate: Joi.date().iso(),
  toDate: Joi.date().iso(),
  paymentMethod: Joi.string().valid('cash', 'transfer', 'cheque', 'card', 'pos', 'direct_debit', 'other')
});

const dateRangeSchema = Joi.object({
  fromDate: Joi.date().iso().required(),
  toDate: Joi.date().iso().required()
});

const yearMonthSchema = Joi.object({
  year: Joi.number().integer().min(2000).max(2100).required(),
  month: Joi.number().integer().min(1).max(12).required()
});

/**
 * @swagger
 * /transactions:
 *   get:
 *     summary: Get all transactions
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, completed, failed, refunded, cancelled]
 *       - in: query
 *         name: fromDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: toDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: paymentMethod
 *         schema:
 *           type: string
 *           enum: [cash, transfer, cheque, card, pos, direct_debit, other]
 *     responses:
 *       200:
 *         description: List of transactions
 */
router.get('/',
  authenticate,
  authorize('transaction:read'),
  validate(paginationSchema, 'query'),
  transactionController.getAllTransactions
);

/**
 * @swagger
 * /transactions/unreconciled:
 *   get:
 *     summary: Get unreconciled transactions
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Unreconciled transactions
 */
router.get('/unreconciled',
  authenticate,
  authorize('transaction:read'),
  transactionController.getUnreconciled
);

/**
 * @swagger
 * /transactions/summary/daily:
 *   get:
 *     summary: Get daily summary
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Daily summary
 */
router.get('/summary/daily',
  authenticate,
  authorize('transaction:read'),
  transactionController.getDailySummary
);

/**
 * @swagger
 * /transactions/summary/monthly:
 *   get:
 *     summary: Get monthly summary
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: month
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Monthly summary
 */
router.get('/summary/monthly',
  authenticate,
  authorize('transaction:read'),
  validate(yearMonthSchema, 'query'),
  transactionController.getMonthlySummary
);

/**
 * @swagger
 * /transactions/reconciliation:
 *   get:
 *     summary: Get reconciliation report
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: fromDate
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: toDate
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Reconciliation report
 */
router.get('/reconciliation',
  authenticate,
  authorize('transaction:read'),
  validate(dateRangeSchema, 'query'),
  transactionController.getReconciliationReport
);

/**
 * @swagger
 * /transactions/payment-methods/stats:
 *   get:
 *     summary: Get payment method statistics
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: fromDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: toDate
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Payment method stats
 */
router.get('/payment-methods/stats',
  authenticate,
  authorize('transaction:read'),
  transactionController.getPaymentMethodStats
);

/**
 * @swagger
 * /transactions/reference/{reference}:
 *   get:
 *     summary: Get transaction by reference
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transaction details
 */
router.get('/reference/:reference',
  authenticate,
  authorize('transaction:read'),
  validate(referenceParamSchema, 'params'),
  transactionController.getByReference
);

/**
 * @swagger
 * /transactions/invoice/{invoiceId}:
 *   get:
 *     summary: Get transactions by invoice
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of transactions for invoice
 */
router.get('/invoice/:invoiceId',
  authenticate,
  authorize('transaction:read'),
  validate(invoiceIdParamSchema, 'params'),
  transactionController.getTransactionsByInvoice
);

/**
 * @swagger
 * /transactions/{id}:
 *   get:
 *     summary: Get transaction by ID
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transaction details
 */
router.get('/:id',
  authenticate,
  authorize('transaction:read'),
  validate(transactionIdParamSchema, 'params'),
  transactionController.getTransactionById
);

/**
 * @swagger
 * /transactions:
 *   post:
 *     summary: Create transaction
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *               - payment_method
 *               - payer_name
 *             properties:
 *               invoice_id:
 *                 type: string
 *               amount:
 *                 type: number
 *               currency:
 *                 type: string
 *               payment_method:
 *                 type: string
 *                 enum: [cash, transfer, cheque, card, pos, direct_debit, other]
 *               payment_provider:
 *                 type: string
 *               transaction_date:
 *                 type: string
 *                 format: date
 *               payer_name:
 *                 type: string
 *               payer_email:
 *                 type: string
 *               payer_phone:
 *                 type: string
 *               payer_account:
 *                 type: string
 *               external_reference:
 *                 type: string
 *     responses:
 *       201:
 *         description: Transaction created
 */
router.post('/',
  authenticate,
  authorize('transaction:create'),
  validate(createTransactionSchema),
  transactionController.createTransaction
);

/**
 * @swagger
 * /transactions/{id}/complete:
 *   post:
 *     summary: Complete transaction
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               settledDate:
 *                 type: string
 *                 format: date
 *     responses:
 *       200:
 *         description: Transaction completed
 */
router.post('/:id/complete',
  authenticate,
  authorize('transaction:update'),
  validate(transactionIdParamSchema, 'params'),
  validate(completeTransactionSchema),
  transactionController.completeTransaction
);

/**
 * @swagger
 * /transactions/{id}/fail:
 *   post:
 *     summary: Fail transaction
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Transaction failed
 */
router.post('/:id/fail',
  authenticate,
  authorize('transaction:update'),
  validate(transactionIdParamSchema, 'params'),
  validate(failTransactionSchema),
  transactionController.failTransaction
);

/**
 * @swagger
 * /transactions/{id}/refund:
 *   post:
 *     summary: Refund transaction
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Transaction refunded
 */
router.post('/:id/refund',
  authenticate,
  authorize('transaction:update'),
  validate(transactionIdParamSchema, 'params'),
  validate(refundTransactionSchema),
  transactionController.refundTransaction
);

/**
 * @swagger
 * /transactions/reconcile:
 *   post:
 *     summary: Reconcile transactions
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - transactionIds
 *             properties:
 *               transactionIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Transactions reconciled
 */
router.post('/reconcile',
  authenticate,
  authorize('transaction:update'),
  validate(reconcileTransactionsSchema),
  transactionController.reconcileTransactions
);

export default router;
