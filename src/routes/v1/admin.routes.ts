import { Router } from 'express';
import { adminController } from '../../controllers/v1/AdminController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { rateLimit } from '../../middleware/rate-limit';
import { piiMask } from '../../middleware/pii-mask';
import Joi from 'joi';

const router = Router();

// Validation schemas
const userIdParamSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const businessIdParamSchema = Joi.object({
  businessId: Joi.string().uuid().required()
});

const featureNameParamSchema = Joi.object({
  name: Joi.string().required()
});

const configKeyParamSchema = Joi.object({
  key: Joi.string().required()
});

const alertIdParamSchema = Joi.object({
  alertId: Joi.string().required()
});

const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50),
  adminId: Joi.string().uuid(),
  action: Joi.string(),
  fromDate: Joi.date().iso(),
  toDate: Joi.date().iso()
});

const createAdminSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  name: Joi.string().required(),
  role: Joi.string().valid('admin', 'super_admin').required()
});

const updateAdminSchema = Joi.object({
  role: Joi.string().valid('admin', 'super_admin'),
  permissions: Joi.array().items(Joi.string())
});

const suspendBusinessSchema = Joi.object({
  reason: Joi.string().required()
});

const createFeatureFlagSchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string().required(),
  enabled: Joi.boolean().default(false),
  global: Joi.boolean().default(false),
  businessIds: Joi.array().items(Joi.string().uuid()),
  subscriptionTiers: Joi.array().items(Joi.string()),
  percentageRollout: Joi.number().min(0).max(100),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso(),
  maxUsage: Joi.number().integer().min(1),
  dependsOn: Joi.array().items(Joi.string()),
  settings: Joi.object()
});

const updateFeatureFlagSchema = Joi.object({
  description: Joi.string(),
  enabled: Joi.boolean(),
  global: Joi.boolean(),
  businessIds: Joi.array().items(Joi.string().uuid()),
  subscriptionTiers: Joi.array().items(Joi.string()),
  percentageRollout: Joi.number().min(0).max(100),
  startDate: Joi.date().iso(),
  endDate: Joi.date().iso(),
  maxUsage: Joi.number().integer().min(1),
  dependsOn: Joi.array().items(Joi.string()),
  settings: Joi.object()
}).min(1);

const updateConfigSchema = Joi.object({
  value: Joi.any().required(),
  type: Joi.string().valid('string', 'number', 'boolean', 'json', 'encrypted'),
  description: Joi.string(),
  category: Joi.string().valid('system', 'security', 'integrations', 'notifications', 'billing'),
  reason: Joi.string()
});

const blockIPSchema = Joi.object({
  ip: Joi.string().ip().required(),
  reason: Joi.string().required(),
  duration: Joi.number().integer().min(60).default(3600)
});

const deepQuerySchema = Joi.object({
  deep: Joi.boolean().default(false)
});

const categoryQuerySchema = Joi.object({
  category: Joi.string().valid('system', 'security', 'integrations', 'notifications', 'billing')
});

const daysQuerySchema = Joi.object({
  days: Joi.number().integer().min(1).max(365).default(30)
});

const intervalQuerySchema = Joi.object({
  interval: Joi.string().valid('minute', 'hour', 'day').default('hour')
});

const dateRangeSchema = Joi.object({
  from: Joi.date().iso().required(),
  to: Joi.date().iso().required()
});

const includeEncryptedSchema = Joi.object({
  includeEncrypted: Joi.boolean().default(false)
});

/**
 * @swagger
 * /admin/stats:
 *   get:
 *     summary: Get system statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System statistics
 */
router.get('/stats',
  authenticate,
  authorize('admin:read'),
  adminController.getSystemStats
);

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Get admin users
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of admin users
 */
router.get('/users',
  authenticate,
  authorize('admin:read'),
  adminController.getAdminUsers
);

/**
 * @swagger
 * /admin/users:
 *   post:
 *     summary: Create admin user
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - name
 *               - role
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               name:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [admin, super_admin]
 *     responses:
 *       201:
 *         description: Admin user created
 */
router.post('/users',
  authenticate,
  authorize('admin:write'),
  validate(createAdminSchema),
  adminController.createAdminUser
);

/**
 * @swagger
 * /admin/users/{id}:
 *   put:
 *     summary: Update admin user
 *     tags: [Admin]
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
 *               role:
 *                 type: string
 *                 enum: [admin, super_admin]
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Admin user updated
 */
router.put('/users/:id',
  authenticate,
  authorize('admin:write'),
  validate(userIdParamSchema, 'params'),
  validate(updateAdminSchema),
  adminController.updateAdminUser
);

/**
 * @swagger
 * /admin/users/{id}:
 *   delete:
 *     summary: Delete admin user
 *     tags: [Admin]
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
 *         description: Admin user deleted
 */
router.delete('/users/:id',
  authenticate,
  authorize('admin:write'),
  validate(userIdParamSchema, 'params'),
  adminController.deleteAdminUser
);

/**
 * @swagger
 * /admin/audit-logs:
 *   get:
 *     summary: Get audit logs
 *     tags: [Admin]
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
 *         name: adminId
 *         schema:
 *           type: string
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
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
 *         description: Audit logs
 */
router.get('/audit-logs',
  authenticate,
  authorize('admin:read'),
  validate(paginationSchema, 'query'),
  piiMask,
  adminController.getAuditLogs
);

/**
 * @swagger
 * /admin/businesses/{businessId}/suspend:
 *   post:
 *     summary: Suspend business
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: businessId
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
 *         description: Business suspended
 */
router.post('/businesses/:businessId/suspend',
  authenticate,
  authorize('admin:write'),
  validate(businessIdParamSchema, 'params'),
  validate(suspendBusinessSchema),
  adminController.suspendBusiness
);

/**
 * @swagger
 * /admin/businesses/{businessId}/reinstate:
 *   post:
 *     summary: Reinstate business
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: businessId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Business reinstated
 */
router.post('/businesses/:businessId/reinstate',
  authenticate,
  authorize('admin:write'),
  validate(businessIdParamSchema, 'params'),
  adminController.reinstateBusiness
);

/**
 * @swagger
 * /admin/features:
 *   get:
 *     summary: Get all feature flags
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Feature flags
 */
router.get('/features',
  authenticate,
  authorize('admin:read'),
  adminController.getAllFeatureFlags
);

/**
 * @swagger
 * /admin/features:
 *   post:
 *     summary: Create feature flag
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - description
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *               global:
 *                 type: boolean
 *               businessIds:
 *                 type: array
 *                 items:
 *                   type: string
 *               subscriptionTiers:
 *                 type: array
 *                 items:
 *                   type: string
 *               percentageRollout:
 *                 type: number
 *               startDate:
 *                 type: string
 *                 format: date
 *               endDate:
 *                 type: string
 *                 format: date
 *               maxUsage:
 *                 type: integer
 *               dependsOn:
 *                 type: array
 *                 items:
 *                   type: string
 *               settings:
 *                 type: object
 *     responses:
 *       201:
 *         description: Feature flag created
 */
router.post('/features',
  authenticate,
  authorize('admin:write'),
  validate(createFeatureFlagSchema),
  adminController.createFeatureFlag
);

/**
 * @swagger
 * /admin/features/{name}:
 *   put:
 *     summary: Update feature flag
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               description:
 *                 type: string
 *               enabled:
 *                 type: boolean
 *               global:
 *                 type: boolean
 *               businessIds:
 *                 type: array
 *                 items:
 *                   type: string
 *               subscriptionTiers:
 *                 type: array
 *                 items:
 *                   type: string
 *               percentageRollout:
 *                 type: number
 *               startDate:
 *                 type: string
 *                 format: date
 *               endDate:
 *                 type: string
 *                 format: date
 *               maxUsage:
 *                 type: integer
 *               dependsOn:
 *                 type: array
 *                 items:
 *                   type: string
 *               settings:
 *                 type: object
 *     responses:
 *       200:
 *         description: Feature flag updated
 */
router.put('/features/:name',
  authenticate,
  authorize('admin:write'),
  validate(featureNameParamSchema, 'params'),
  validate(updateFeatureFlagSchema),
  adminController.updateFeatureFlag
);

/**
 * @swagger
 * /admin/features/{name}:
 *   delete:
 *     summary: Delete feature flag
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Feature flag deleted
 */
router.delete('/features/:name',
  authenticate,
  authorize('admin:write'),
  validate(featureNameParamSchema, 'params'),
  adminController.deleteFeatureFlag
);

/**
 * @swagger
 * /admin/features/{name}/metrics:
 *   get:
 *     summary: Get feature flag metrics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Feature metrics
 */
router.get('/features/:name/metrics',
  authenticate,
  authorize('admin:read'),
  validate(featureNameParamSchema, 'params'),
  adminController.getFeatureFlagMetrics
);

/**
 * @swagger
 * /admin/config:
 *   get:
 *     summary: Get system configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [system, security, integrations, notifications, billing]
 *     responses:
 *       200:
 *         description: System configuration
 */
router.get('/config',
  authenticate,
  authorize('admin:read'),
  validate(categoryQuerySchema, 'query'),
  adminController.getSystemConfig
);

/**
 * @swagger
 * /admin/config/{key}:
 *   put:
 *     summary: Update system configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: key
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
 *               - value
 *             properties:
 *               value:
 *                 anyOf:
 *                   - type: string
 *                   - type: number
 *                   - type: boolean
 *                   - type: object
 *               type:
 *                 type: string
 *                 enum: [string, number, boolean, json, encrypted]
 *               description:
 *                 type: string
 *               category:
 *                 type: string
 *                 enum: [system, security, integrations, notifications, billing]
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Configuration updated
 */
router.put('/config/:key',
  authenticate,
  authorize('admin:write'),
  validate(configKeyParamSchema, 'params'),
  validate(updateConfigSchema),
  adminController.updateSystemConfig
);

/**
 * @swagger
 * /admin/config/export:
 *   get:
 *     summary: Export configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: includeEncrypted
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Configuration file
 */
router.get('/config/export',
  authenticate,
  authorize('admin:read'),
  validate(includeEncryptedSchema, 'query'),
  adminController.exportConfig
);

/**
 * @swagger
 * /admin/config/import:
 *   post:
 *     summary: Import configuration
 *     tags: [Admin]
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
 *         description: Configuration imported
 */
router.post('/config/import',
  authenticate,
  authorize('admin:write'),
  adminController.importConfig
);

/**
 * @swagger
 * /admin/health:
 *   get:
 *     summary: Get system health
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System health
 */
router.get('/health',
  authenticate,
  authorize('admin:read'),
  adminController.getSystemHealth
);

/**
 * @swagger
 * /admin/health/check:
 *   get:
 *     summary: Run health check
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: deep
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Health check results
 */
router.get('/health/check',
  authenticate,
  authorize('admin:read'),
  validate(deepQuerySchema, 'query'),
  adminController.runHealthCheck
);

/**
 * @swagger
 * /admin/diagnostic:
 *   get:
 *     summary: Run diagnostic
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: deep
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: Diagnostic report
 */
router.get('/diagnostic',
  authenticate,
  authorize('admin:read'),
  validate(deepQuerySchema, 'query'),
  adminController.runDiagnostic
);

/**
 * @swagger
 * /admin/performance/profiles:
 *   get:
 *     summary: Get performance profiles
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Performance profiles
 */
router.get('/performance/profiles',
  authenticate,
  authorize('admin:read'),
  adminController.getPerformanceProfiles
);

/**
 * @swagger
 * /admin/alerts:
 *   get:
 *     summary: Get active alerts
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active alerts
 */
router.get('/alerts',
  authenticate,
  authorize('admin:read'),
  adminController.getActiveAlerts
);

/**
 * @swagger
 * /admin/alerts/{alertId}/acknowledge:
 *   post:
 *     summary: Acknowledge alert
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: alertId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Alert acknowledged
 */
router.post('/alerts/:alertId/acknowledge',
  authenticate,
  authorize('admin:write'),
  validate(alertIdParamSchema, 'params'),
  adminController.acknowledgeAlert
);

/**
 * @swagger
 * /admin/metrics:
 *   get:
 *     summary: Get metrics history
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: to
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: interval
 *         schema:
 *           type: string
 *           enum: [minute, hour, day]
 *           default: hour
 *     responses:
 *       200:
 *         description: Metrics history
 */
router.get('/metrics',
  authenticate,
  authorize('admin:read'),
  validate(dateRangeSchema, 'query'),
  validate(intervalQuerySchema, 'query'),
  adminController.getMetricsHistory
);

/**
 * @swagger
 * /admin/security/whitelist:
 *   post:
 *     summary: Add IP to whitelist
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - provider
 *               - ip
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: [zoho, whatsapp, quickbooks]
 *               ip:
 *                 type: string
 *     responses:
 *       200:
 *         description: IP added to whitelist
 */
router.post('/security/whitelist',
  authenticate,
  authorize('admin:write'),
  webhookController.addToWhitelist
);

/**
 * @swagger
 * /admin/security/whitelist:
 *   delete:
 *     summary: Remove IP from whitelist
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - provider
 *               - ip
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: [zoho, whatsapp, quickbooks]
 *               ip:
 *                 type: string
 *     responses:
 *       200:
 *         description: IP removed from whitelist
 */
router.delete('/security/whitelist',
  authenticate,
  authorize('admin:write'),
  webhookController.removeFromWhitelist
);

/**
 * @swagger
 * /admin/security/block:
 *   post:
 *     summary: Block IP
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ip
 *               - reason
 *             properties:
 *               ip:
 *                 type: string
 *               reason:
 *                 type: string
 *               duration:
 *                 type: integer
 *                 default: 3600
 *     responses:
 *       200:
 *         description: IP blocked
 */
router.post('/security/block',
  authenticate,
  authorize('admin:write'),
  validate(blockIPSchema),
  webhookController.blockIP
);

/**
 * @swagger
 * /admin/security/block/{ip}:
 *   delete:
 *     summary: Unblock IP
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ip
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: IP unblocked
 */
router.delete('/security/block/:ip',
  authenticate,
  authorize('admin:write'),
  webhookController.unblockIP
);

/**
 * @swagger
 * /admin/security/report:
 *   get:
 *     summary: Generate security report
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Security report
 */
router.get('/security/report',
  authenticate,
  authorize('admin:read'),
  webhookController.generateSecurityReport
);

export default router;
