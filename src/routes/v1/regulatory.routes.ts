import { Router } from 'express';
import { regulatoryController } from '../../controllers/v1/RegulatoryController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { rateLimit } from '../../middleware/rate-limit';
import Joi from 'joi';

const router = Router();

// Validation schemas
const invoiceIdParamSchema = Joi.object({
  invoiceId: Joi.string().uuid().required()
});

const submissionIdParamSchema = Joi.object({
  submissionId: Joi.string().uuid().required()
});

const reportIdParamSchema = Joi.object({
  reportId: Joi.string().uuid().required()
});

const dateRangeSchema = Joi.object({
  fromDate: Joi.date().iso().required(),
  toDate: Joi.date().iso().required()
});

const yearMonthSchema = Joi.object({
  year: Joi.number().integer().min(2000).max(2100).required(),
  month: Joi.number().integer().min(1).max(12).required()
});

const cancelInvoiceSchema = Joi.object({
  reason: Joi.string().required()
});

const strictQuerySchema = Joi.object({
  strict: Joi.boolean().default(false)
});

const limitQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(12)
});

const typeQuerySchema = Joi.object({
  type: Joi.string().valid('monthly', 'quarterly', 'annual').default('monthly')
});

const formatParamSchema = Joi.object({
  format: Joi.string().valid('pdf', 'csv').required()
});

/**
 * @swagger
 * /regulatory/compliance:
 *   get:
 *     summary: Get compliance status
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Compliance status
 */
router.get('/compliance',
  authenticate,
  authorize('regulatory:read'),
  regulatoryController.getComplianceStatus
);

/**
 * @swagger
 * /regulatory/compliance/check:
 *   post:
 *     summary: Run compliance check
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Compliance check initiated
 */
router.post('/compliance/check',
  authenticate,
  authorize('regulatory:write'),
  regulatoryController.runComplianceCheck
);

/**
 * @swagger
 * /regulatory/csid:
 *   get:
 *     summary: Get CSID status
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: CSID status
 */
router.get('/csid',
  authenticate,
  authorize('regulatory:read'),
  regulatoryController.getCSIDStatus
);

/**
 * @swagger
 * /regulatory/firs/submit/{invoiceId}:
 *   post:
 *     summary: Submit invoice to FIRS
 *     tags: [Regulatory]
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
 *         description: Submitted to FIRS
 */
router.post('/firs/submit/:invoiceId',
  authenticate,
  authorize('regulatory:write'),
  validate(invoiceIdParamSchema, 'params'),
  rateLimit({ window: 60 * 60, max: 10 }),
  regulatoryController.submitToFIRS
);

/**
 * @swagger
 * /regulatory/firs/status/{submissionId}:
 *   get:
 *     summary: Check submission status
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: submissionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Submission status
 */
router.get('/firs/status/:submissionId',
  authenticate,
  authorize('regulatory:read'),
  validate(submissionIdParamSchema, 'params'),
  regulatoryController.checkSubmissionStatus
);

/**
 * @swagger
 * /regulatory/firs/cancel/{invoiceId}:
 *   post:
 *     summary: Cancel invoice in FIRS
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
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
router.post('/firs/cancel/:invoiceId',
  authenticate,
  authorize('regulatory:write'),
  validate(invoiceIdParamSchema, 'params'),
  validate(cancelInvoiceSchema),
  regulatoryController.cancelInvoice
);

/**
 * @swagger
 * /regulatory/validate/invoice/{invoiceId}:
 *   get:
 *     summary: Validate invoice document
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: strict
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: Validation results
 */
router.get('/validate/invoice/:invoiceId',
  authenticate,
  authorize('regulatory:read'),
  validate(invoiceIdParamSchema, 'params'),
  validate(strictQuerySchema, 'query'),
  regulatoryController.validateInvoice
);

/**
 * @swagger
 * /regulatory/validate/business:
 *   get:
 *     summary: Validate business registration
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Validation results
 */
router.get('/validate/business',
  authenticate,
  authorize('regulatory:read'),
  regulatoryController.validateBusiness
);

/**
 * @swagger
 * /regulatory/tax/calculate:
 *   post:
 *     summary: Calculate tax for invoice
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               line_items:
 *                 type: array
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Tax breakdown
 */
router.post('/tax/calculate',
  authenticate,
  authorize('regulatory:read'),
  regulatoryController.calculateTax
);

/**
 * @swagger
 * /regulatory/tax/report:
 *   get:
 *     summary: Generate tax report
 *     tags: [Regulatory]
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
 *         description: Tax report
 */
router.get('/tax/report',
  authenticate,
  authorize('regulatory:read'),
  validate(dateRangeSchema, 'query'),
  regulatoryController.generateTaxReport
);

/**
 * @swagger
 * /regulatory/tax/liability:
 *   get:
 *     summary: Calculate VAT liability
 *     tags: [Regulatory]
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
 *         description: VAT liability
 */
router.get('/tax/liability',
  authenticate,
  authorize('regulatory:read'),
  validate(dateRangeSchema, 'query'),
  regulatoryController.calculateVATLiability
);

/**
 * @swagger
 * /regulatory/tax/return:
 *   get:
 *     summary: Generate VAT return
 *     tags: [Regulatory]
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
 *         description: VAT return file
 */
router.get('/tax/return',
  authenticate,
  authorize('regulatory:read'),
  validate(yearMonthSchema, 'query'),
  regulatoryController.generateVATReturn
);

/**
 * @swagger
 * /regulatory/reports:
 *   get:
 *     summary: Get report history
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 12
 *     responses:
 *       200:
 *         description: Report history
 */
router.get('/reports',
  authenticate,
  authorize('regulatory:read'),
  validate(limitQuerySchema, 'query'),
  regulatoryController.getReportHistory
);

/**
 * @swagger
 * /regulatory/reports/generate:
 *   get:
 *     summary: Generate regulatory report
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [monthly, quarterly, annual]
 *           default: monthly
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
 *         description: Regulatory report
 */
router.get('/reports/generate',
  authenticate,
  authorize('regulatory:read'),
  validate(typeQuerySchema, 'query'),
  validate(dateRangeSchema, 'query'),
  regulatoryController.generateReport
);

/**
 * @swagger
 * /regulatory/reports/{reportId}/export/{format}:
 *   get:
 *     summary: Export regulatory report
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: reportId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: format
 *         required: true
 *         schema:
 *           type: string
 *           enum: [pdf, csv]
 *     responses:
 *       200:
 *         description: Exported file
 */
router.get('/reports/:reportId/export/:format',
  authenticate,
  authorize('regulatory:read'),
  validate(reportIdParamSchema, 'params'),
  validate(formatParamSchema, 'params'),
  regulatoryController.exportReport
);

/**
 * @swagger
 * /regulatory/peppol/to-firs:
 *   post:
 *     summary: Convert Peppol to FIRS
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - xml
 *             properties:
 *               xml:
 *                 type: string
 *     responses:
 *       200:
 *         description: FIRS data
 */
router.post('/peppol/to-firs',
  authenticate,
  authorize('regulatory:read'),
  regulatoryController.convertPeppolToFIRS
);

/**
 * @swagger
 * /regulatory/peppol/from-firs:
 *   post:
 *     summary: Convert FIRS to Peppol
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Peppol XML
 */
router.post('/peppol/from-firs',
  authenticate,
  authorize('regulatory:read'),
  regulatoryController.convertFIRSToPeppol
);

/**
 * @swagger
 * /regulatory/peppol/validate:
 *   post:
 *     summary: Validate Peppol document
 *     tags: [Regulatory]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - xml
 *             properties:
 *               xml:
 *                 type: string
 *     responses:
 *       200:
 *         description: Validation results
 */
router.post('/peppol/validate',
  authenticate,
  authorize('regulatory:read'),
  regulatoryController.validatePeppolDocument
);

export default router;
