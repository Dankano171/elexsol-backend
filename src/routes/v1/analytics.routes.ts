import { Router } from 'express';
import { analyticsController } from '../../controllers/v1/AnalyticsController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import Joi from 'joi';

const router = Router();

// Validation schemas
const customerTinParamSchema = Joi.object({
  customerTin: Joi.string().length(10).required()
});

const daysQuerySchema = Joi.object({
  days: Joi.number().integer().min(1).max(365).default(90)
});

const monthsQuerySchema = Joi.object({
  months: Joi.number().integer().min(1).max(24).default(12)
});

const limitQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(10)
});

const dateRangeSchema = Joi.object({
  fromDate: Joi.date().iso().required(),
  toDate: Joi.date().iso().required(),
  format: Joi.string().valid('csv', 'pdf', 'excel').default('csv')
});

const recommendationUpdateSchema = Joi.object({
  status: Joi.string().valid('pending', 'in_progress', 'completed', 'dismissed').required(),
  notes: Joi.string()
});

const recommendationIdParamSchema = Joi.object({
  id: Joi.string().uuid().required()
});

/**
 * @swagger
 * /analytics/dashboard:
 *   get:
 *     summary: Get business metrics dashboard
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard metrics
 */
router.get('/dashboard',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getDashboard
);

/**
 * @swagger
 * /analytics/payment-velocity:
 *   get:
 *     summary: Get payment velocity
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 90
 *     responses:
 *       200:
 *         description: Payment velocity metrics
 */
router.get('/payment-velocity',
  authenticate,
  authorize('analytics:read'),
  validate(daysQuerySchema, 'query'),
  analyticsController.getPaymentVelocity
);

/**
 * @swagger
 * /analytics/cashflow:
 *   get:
 *     summary: Get cash flow metrics
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           default: 12
 *     responses:
 *       200:
 *         description: Cash flow metrics
 */
router.get('/cashflow',
  authenticate,
  authorize('analytics:read'),
  validate(monthsQuerySchema, 'query'),
  analyticsController.getCashFlow
);

/**
 * @swagger
 * /analytics/cashflow/forecast:
 *   get:
 *     summary: Get cash flow forecast
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cash flow forecast chart
 */
router.get('/cashflow/forecast',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getCashFlowForecast
);

/**
 * @swagger
 * /analytics/cashflow/alerts:
 *   get:
 *     summary: Get cash flow alerts
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cash flow alerts
 */
router.get('/cashflow/alerts',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getCashFlowAlerts
);

/**
 * @swagger
 * /analytics/customers/{customerTin}:
 *   get:
 *     summary: Get customer insights
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: customerTin
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Customer insights
 */
router.get('/customers/:customerTin',
  authenticate,
  authorize('analytics:read'),
  validate(customerTinParamSchema, 'params'),
  analyticsController.getCustomerInsights
);

/**
 * @swagger
 * /analytics/customers/segments:
 *   get:
 *     summary: Get customer segments
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Customer segments
 */
router.get('/customers/segments',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getCustomerSegments
);

/**
 * @swagger
 * /analytics/customers/churn:
 *   get:
 *     summary: Get churn predictions
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Churn predictions
 */
router.get('/customers/churn',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getChurnPredictions
);

/**
 * @swagger
 * /analytics/revenue/forecast:
 *   get:
 *     summary: Get revenue forecast
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: months
 *         schema:
 *           type: integer
 *           default: 6
 *     responses:
 *       200:
 *         description: Revenue forecast
 */
router.get('/revenue/forecast',
  authenticate,
  authorize('analytics:read'),
  validate(monthsQuerySchema, 'query'),
  analyticsController.getRevenueForecast
);

/**
 * @swagger
 * /analytics/revenue/by-customer:
 *   get:
 *     summary: Get revenue by customer
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Revenue by customer
 */
router.get('/revenue/by-customer',
  authenticate,
  authorize('analytics:read'),
  validate(limitQuerySchema, 'query'),
  analyticsController.getRevenueByCustomer
);

/**
 * @swagger
 * /analytics/health:
 *   get:
 *     summary: Get business health score
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Health score
 */
router.get('/health',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getHealthScore
);

/**
 * @swagger
 * /analytics/benchmarks:
 *   get:
 *     summary: Get benchmark comparisons
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Benchmark data
 */
router.get('/benchmarks',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getBenchmarks
);

/**
 * @swagger
 * /analytics/performance:
 *   get:
 *     summary: Get performance metrics
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [day, week, month, quarter, year]
 *           default: month
 *     responses:
 *       200:
 *         description: Performance metrics
 */
router.get('/performance',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getPerformanceMetrics
);

/**
 * @swagger
 * /analytics/kpis:
 *   get:
 *     summary: Get KPIs
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Key performance indicators
 */
router.get('/kpis',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getKPIs
);

/**
 * @swagger
 * /analytics/recommendations:
 *   get:
 *     summary: Get growth recommendations
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Growth recommendations
 */
router.get('/recommendations',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getRecommendations
);

/**
 * @swagger
 * /analytics/recommendations/{id}:
 *   put:
 *     summary: Track recommendation progress
 *     tags: [Analytics]
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
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, in_progress, completed, dismissed]
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Progress updated
 */
router.put('/recommendations/:id',
  authenticate,
  authorize('analytics:write'),
  validate(recommendationIdParamSchema, 'params'),
  validate(recommendationUpdateSchema),
  analyticsController.trackRecommendation
);

/**
 * @swagger
 * /analytics/opportunities:
 *   get:
 *     summary: Get growth opportunities
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Growth opportunities
 */
router.get('/opportunities',
  authenticate,
  authorize('analytics:read'),
  analyticsController.getOpportunities
);

/**
 * @swagger
 * /analytics/export:
 *   get:
 *     summary: Export analytics report
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [csv, pdf, excel]
 *           default: csv
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
 *         description: Exported file
 */
router.get('/export',
  authenticate,
  authorize('analytics:read'),
  validate(dateRangeSchema, 'query'),
  analyticsController.exportReport
);

export default router;
