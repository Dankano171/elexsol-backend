import { Router } from 'express';
import { invoiceController } from '../../controllers/v1/InvoiceController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { rateLimit } from '../../middleware/rate-limit';
import Joi from 'joi';

const router = Router();

// Validation schemas
const createInvoiceSchema = Joi.object({
  customer_tin: Joi.string().length(10).required(),
  customer_name: Joi.string().required(),
  customer_email: Joi.string().email(),
  customer_phone: Joi.string().pattern(/^\+?[\d\s-]{10,}$/),
  customer_address: Joi.string(),
  issue_date: Joi.date().iso().required(),
  due_date: Joi.date().iso().required(),
  supply_date: Joi.date().iso(),
  line_items: Joi.array().items(Joi.object({
    description: Joi.string().required(),
    quantity: Joi.number().positive().required(),
    unit_price: Joi.number().positive().required(),
    discount_rate: Joi.number().min(0).max(100),
    vat_rate: Joi.number().min(0).max(100),
    excise_rate: Joi.number().min(0).max(100)
  })).min(1).required(),
  notes: Joi.string(),
  terms: Joi.string(),
  metadata: Joi.object()
});

const updateInvoiceSchema = Joi.object({
  customer_name: Joi.string(),
  customer_email: Joi.string().email(),
  customer_phone: Joi.string().pattern(/^\+?[\d\s-]{10,}$/),
  customer_address: Joi.string(),
  due_date: Joi.date().iso(),
  notes: Joi.string(),
  terms: Joi.string(),
  metadata: Joi.object()
}).min(1);

const invoiceIdParamSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('draft', 'sent', 'paid', 'overdue', 'cancelled'),
  payment_status: Joi.string().valid('unpaid', 'partial', 'paid', 'overdue'),
  fromDate: Joi.date().iso(),
  toDate: Joi.date().iso(),
  customerTin: Joi.string().length(10)
});

const searchSchema = Joi.object({
  q: Joi.string().required().min(2)
});

const cancelSchema = Joi.object({
  reason: Joi.string().required()
});

/**
 * @swagger
 * /invoices:
 *   get:
 *     summary: Get all invoices
 *     tags: [Invoices]
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
 *           enum: [draft, sent, paid, overdue, cancelled]
 *       - in: query
 *         name: payment_status
 *         schema:
 *           type: string
 *           enum: [unpaid, partial, paid, overdue]
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
 *         name: customerTin
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of invoices
 */
router.get('/',
  authenticate,
  authorize('invoice:read'),
  validate(paginationSchema, 'query'),
  invoiceController.getAllInvoices
);

/**
 * @swagger
 * /invoices/search:
 *   get:
 *     summary: Search invoices
 *     tags: [Invoices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Search results
 */
router.get('/search',
  authenticate,
  authorize('invoice:read'),
  validate(searchSchema, 'query'),
  invoiceController.searchInvoices
);

/**
 * @swagger
 * /invoices/stats:
 *   get:
 *     summary: Get invoice statistics
 *     tags: [Invoices]
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
 *         description: Invoice statistics
 */
router.get('/stats',
  authenticate,
  authorize('invoice:read'),
  invoiceController.getStatistics
);

/**
 * @swagger
 * /invoices/aging:
 *   get:
 *     summary: Get aging report
 *     tags: [Invoices]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Aging report
 */
router.get('/aging',
  authenticate,
  authorize('invoice:read'),
  invoiceController.getAgingReport
);

/**
 * @swagger
 * /invoices/{id}:
 *   get:
 *     summary: Get invoice by ID
 *     tags: [Invoices]
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
 *         description: Invoice details
 */
router.get('/:id',
  authenticate,
  authorize('invoice:read'),
  validate(invoiceIdParamSchema, 'params'),
  invoiceController.getInvoiceById
);

/**
 * @swagger
 * /invoices:
 *   post:
 *     summary: Create invoice
 *     tags: [Invoices]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - customer_tin
 *               - customer_name
 *               - issue_date
 *               - due_date
 *               - line_items
 *             properties:
 *               customer_tin:
 *                 type: string
 *               customer_name:
 *                 type: string
 *               customer_email:
 *                 type: string
 *               customer_phone:
 *                 type: string
 *               customer_address:
 *                 type: string
 *               issue_date:
 *                 type: string
 *                 format: date
 *               due_date:
 *                 type: string
 *                 format: date
 *               supply_date:
 *                 type: string
 *                 format: date
 *               line_items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - description
 *                     - quantity
 *                     - unit_price
 *                   properties:
 *                     description:
 *                       type: string
 *                     quantity:
 *                       type: number
 *                     unit_price:
 *                       type: number
 *                     discount_rate:
 *                       type: number
 *                     vat_rate:
 *                       type: number
 *                     excise_rate:
 *                       type: number
 *               notes:
 *                 type: string
 *               terms:
 *                 type: string
 *     responses:
 *       201:
 *         description: Invoice created
 */
router.post('/',
  authenticate,
  authorize('invoice:create'),
  validate(createInvoiceSchema),
  invoiceController.createInvoice
);

/**
 * @swagger
 * /invoices/{id}:
 *   put:
 *     summary: Update invoice
 *     tags: [Invoices]
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
 *               customer_name:
 *                 type: string
 *               customer_email:
 *                 type: string
 *               customer_phone:
 *                 type: string
 *               customer_address:
 *                 type: string
 *               due_date:
 *                 type: string
 *                 format: date
 *               notes:
 *                 type: string
 *               terms:
 *                 type: string
 *     responses:
 *       200:
 *         description: Invoice updated
 */
router.put('/:id',
  authenticate,
  authorize('invoice:update'),
  validate(invoiceIdParamSchema, 'params'),
  validate(updateInvoiceSchema),
  invoiceController.updateInvoice
);

/**
 * @swagger
 * /invoices/{id}:
 *   delete:
 *     summary: Delete invoice
 *     tags: [Invoices]
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
 *         description: Invoice deleted
 */
router.delete('/:id',
  authenticate,
  authorize('invoice:delete'),
  validate(invoiceIdParamSchema, 'params'),
  invoiceController.deleteInvoice
);

/**
 * @swagger
 * /invoices/{id}/firs/submit:
 *   post:
 *     summary: Submit invoice to FIRS
 *     tags: [Invoices]
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
 *         description: Submitted to FIRS
 */
router.post('/:id/firs/submit',
  authenticate,
  authorize('invoice:update'),
  validate(invoiceIdParamSchema, 'params'),
  rateLimit({ window: 60 * 60, max: 10 }), // 10 submissions per hour
  invoiceController.submitToFIRS
);

/**
 * @swagger
 * /invoices/{id}/firs/status:
 *   get:
 *     summary: Check FIRS status
 *     tags: [Invoices]
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
 *         description: FIRS status
 */
router.get('/:id/firs/status',
  authenticate,
  authorize('invoice:read'),
  validate(invoiceIdParamSchema, 'params'),
  invoiceController.checkFIRSStatus
);

/**
 * @swagger
 * /invoices/{id}/cancel:
 *   post:
 *     summary: Cancel invoice
 *     tags: [Invoices]
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
 *         description: Invoice cancelled
 */
router.post('/:id/cancel',
  authenticate,
  authorize('invoice:update'),
  validate(invoiceIdParamSchema, 'params'),
  validate(cancelSchema),
  invoiceController.cancelInvoice
);

/**
 * @swagger
 * /invoices/{id}/pdf:
 *   get:
 *     summary: Download invoice PDF
 *     tags: [Invoices]
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
 *         description: PDF file
 */
router.get('/:id/pdf',
  authenticate,
  authorize('invoice:read'),
  validate(invoiceIdParamSchema, 'params'),
  invoiceController.downloadPDF
);

export default router;
