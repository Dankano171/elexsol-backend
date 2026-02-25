import { Router } from 'express';
import { integrationController } from '../../controllers/v1/IntegrationController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { rateLimit } from '../../middleware/rate-limit';
import Joi from 'joi';

const router = Router();

// Validation schemas
const connectIntegrationSchema = Joi.object({
  provider: Joi.string().valid('zoho', 'whatsapp', 'quickbooks').required(),
  accountEmail: Joi.string().email().required(),
  accessToken: Joi.string().required(),
  refreshToken: Joi.string(),
  expiresAt: Joi.date().iso(),
  scopes: Joi.array().items(Joi.string()).default([]),
  settings: Joi.object()
});

const updateSettingsSchema = Joi.object({
  syncContacts: Joi.boolean(),
  syncInvoices: Joi.boolean(),
  syncMessages: Joi.boolean(),
  webhook_events: Joi.array().items(Joi.string()),
  autoSync: Joi.boolean(),
  syncInterval: Joi.number().min(5).max(1440)
}).min(1);

const integrationIdParamSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const providerParamSchema = Joi.object({
  provider: Joi.string().valid('zoho', 'whatsapp', 'quickbooks').required()
});

/**
 * @swagger
 * /integrations:
 *   get:
 *     summary: Get all integrations
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: provider
 *         schema:
 *           type: string
 *           enum: [zoho, whatsapp, quickbooks]
 *     responses:
 *       200:
 *         description: List of integrations
 */
router.get('/',
  authenticate,
  authorize('integration:read'),
  integrationController.getAllIntegrations
);

/**
 * @swagger
 * /integrations/stats:
 *   get:
 *     summary: Get provider statistics
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Provider statistics
 */
router.get('/stats',
  authenticate,
  authorize('integration:read'),
  integrationController.getProviderStats
);

/**
 * @swagger
 * /integrations/webhooks:
 *   get:
 *     summary: Get webhook endpoints
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Webhook endpoints
 */
router.get('/webhooks',
  authenticate,
  authorize('integration:read'),
  integrationController.getWebhookEndpoints
);

/**
 * @swagger
 * /integrations/oauth/{provider}:
 *   get:
 *     summary: Get OAuth URL
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *           enum: [zoho, quickbooks]
 *     responses:
 *       200:
 *         description: OAuth URL
 */
router.get('/oauth/:provider',
  authenticate,
  authorize('integration:create'),
  validate(providerParamSchema, 'params'),
  integrationController.getOAuthURL
);

/**
 * @swagger
 * /integrations/oauth/{provider}/callback:
 *   get:
 *     summary: Handle OAuth callback
 *     tags: [Integrations]
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *           enum: [zoho, quickbooks]
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *       - in: query
 *         name: realmId
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirect to frontend
 */
router.get('/oauth/:provider/callback',
  integrationController.handleOAuthCallback
);

/**
 * @swagger
 * /integrations/{id}:
 *   get:
 *     summary: Get integration by ID
 *     tags: [Integrations]
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
 *         description: Integration details
 */
router.get('/:id',
  authenticate,
  authorize('integration:read'),
  validate(integrationIdParamSchema, 'params'),
  integrationController.getIntegrationById
);

/**
 * @swagger
 * /integrations:
 *   post:
 *     summary: Connect integration
 *     tags: [Integrations]
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
 *               - accountEmail
 *               - accessToken
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: [zoho, whatsapp, quickbooks]
 *               accountEmail:
 *                 type: string
 *               accessToken:
 *                 type: string
 *               refreshToken:
 *                 type: string
 *               expiresAt:
 *                 type: string
 *                 format: date
 *               scopes:
 *                 type: array
 *                 items:
 *                   type: string
 *               settings:
 *                 type: object
 *     responses:
 *       201:
 *         description: Integration connected
 */
router.post('/',
  authenticate,
  authorize('integration:create'),
  validate(connectIntegrationSchema),
  rateLimit({ window: 60 * 60, max: 5 }), // 5 connections per hour
  integrationController.connectIntegration
);

/**
 * @swagger
 * /integrations/{id}:
 *   delete:
 *     summary: Disconnect integration
 *     tags: [Integrations]
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
 *         description: Integration disconnected
 */
router.delete('/:id',
  authenticate,
  authorize('integration:delete'),
  validate(integrationIdParamSchema, 'params'),
  integrationController.disconnectIntegration
);

/**
 * @swagger
 * /integrations/{id}/sync:
 *   post:
 *     summary: Sync integration
 *     tags: [Integrations]
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
 *         description: Sync queued
 */
router.post('/:id/sync',
  authenticate,
  authorize('integration:update'),
  validate(integrationIdParamSchema, 'params'),
  rateLimit({ window: 60 * 5, max: 1 }), // 1 sync per 5 minutes
  integrationController.syncIntegration
);

/**
 * @swagger
 * /integrations/{id}/settings:
 *   put:
 *     summary: Update integration settings
 *     tags: [Integrations]
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
 *               syncContacts:
 *                 type: boolean
 *               syncInvoices:
 *                 type: boolean
 *               syncMessages:
 *                 type: boolean
 *               webhook_events:
 *                 type: array
 *                 items:
 *                   type: string
 *               autoSync:
 *                 type: boolean
 *               syncInterval:
 *                 type: number
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put('/:id/settings',
  authenticate,
  authorize('integration:update'),
  validate(integrationIdParamSchema, 'params'),
  validate(updateSettingsSchema),
  integrationController.updateSettings
);

/**
 * @swagger
 * /integrations/{id}/status:
 *   get:
 *     summary: Get integration status
 *     tags: [Integrations]
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
 *         description: Integration status
 */
router.get('/:id/status',
  authenticate,
  authorize('integration:read'),
  validate(integrationIdParamSchema, 'params'),
  integrationController.getIntegrationStatus
);

/**
 * @swagger
 * /integrations/{id}/test:
 *   post:
 *     summary: Test integration
 *     tags: [Integrations]
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
 *         description: Test result
 */
router.post('/:id/test',
  authenticate,
  authorize('integration:read'),
  validate(integrationIdParamSchema, 'params'),
  integrationController.testIntegration
);

export default router;
