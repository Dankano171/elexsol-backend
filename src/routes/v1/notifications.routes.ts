import { Router } from 'express';
import { notificationController } from '../../controllers/v1/NotificationController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import Joi from 'joi';

const router = Router();

// Validation schemas
const notificationIdParamSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  type: Joi.string().valid('success', 'action_required', 'integration', 'regulatory'),
  unreadOnly: Joi.boolean().default(false)
});

const preferencesSchema = Joi.object({
  email: Joi.boolean(),
  sms: Joi.boolean(),
  push: Joi.boolean(),
  inApp: Joi.boolean(),
  whatsapp: Joi.boolean(),
  digest: Joi.string().valid('immediate', 'daily', 'weekly', 'never'),
  types: Joi.object({
    success: Joi.boolean(),
    action_required: Joi.boolean(),
    integration: Joi.boolean(),
    regulatory: Joi.boolean()
  }),
  quietHours: Joi.object({
    enabled: Joi.boolean(),
    start: Joi.string().pattern(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/),
    end: Joi.string().pattern(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/),
    timezone: Joi.string()
  })
});

const scheduleNotificationSchema = Joi.object({
  type: Joi.string().valid('success', 'action_required', 'integration', 'regulatory').required(),
  title: Joi.string().required(),
  body: Joi.string().required(),
  channels: Joi.array().items(Joi.string().valid('email', 'sms', 'push', 'inapp', 'whatsapp')).min(1).required(),
  data: Joi.object(),
  priority: Joi.string().valid('low', 'medium', 'high', 'critical').default('medium'),
  sendAt: Joi.date().iso().greater('now').required()
});

const subscribePushSchema = Joi.object({
  token: Joi.string().required(),
  platform: Joi.string().valid('ios', 'android', 'web').required(),
  deviceId: Joi.string(),
  model: Joi.string(),
  appVersion: Joi.string()
});

const unsubscribePushSchema = Joi.object({
  token: Joi.string().required()
});

const inAppQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  unreadOnly: Joi.boolean().default(false)
});

const channelParamSchema = Joi.object({
  channel: Joi.string().valid('email', 'sms', 'push', 'inapp', 'whatsapp').required()
});

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: Get user notifications
 *     tags: [Notifications]
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
 *         name: type
 *         schema:
 *           type: string
 *           enum: [success, action_required, integration, regulatory]
 *       - in: query
 *         name: unreadOnly
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: List of notifications
 */
router.get('/',
  authenticate,
  validate(paginationSchema, 'query'),
  notificationController.getUserNotifications
);

/**
 * @swagger
 * /notifications/unread-count:
 *   get:
 *     summary: Get unread count
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unread count
 */
router.get('/unread-count',
  authenticate,
  notificationController.getUnreadCount
);

/**
 * @swagger
 * /notifications/preferences:
 *   get:
 *     summary: Get notification preferences
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User preferences
 */
router.get('/preferences',
  authenticate,
  notificationController.getPreferences
);

/**
 * @swagger
 * /notifications/preferences:
 *   put:
 *     summary: Update notification preferences
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: boolean
 *               sms:
 *                 type: boolean
 *               push:
 *                 type: boolean
 *               inApp:
 *                 type: boolean
 *               whatsapp:
 *                 type: boolean
 *               digest:
 *                 type: string
 *                 enum: [immediate, daily, weekly, never]
 *               types:
 *                 type: object
 *                 properties:
 *                   success:
 *                     type: boolean
 *                   action_required:
 *                     type: boolean
 *                   integration:
 *                     type: boolean
 *                   regulatory:
 *                     type: boolean
 *               quietHours:
 *                 type: object
 *                 properties:
 *                   enabled:
 *                     type: boolean
 *                   start:
 *                     type: string
 *                   end:
 *                     type: string
 *                   timezone:
 *                     type: string
 *     responses:
 *       200:
 *         description: Preferences updated
 */
router.put('/preferences',
  authenticate,
  validate(preferencesSchema),
  notificationController.updatePreferences
);

/**
 * @swagger
 * /notifications/{id}/read:
 *   post:
 *     summary: Mark notification as read
 *     tags: [Notifications]
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
 *         description: Marked as read
 */
router.post('/:id/read',
  authenticate,
  validate(notificationIdParamSchema, 'params'),
  notificationController.markAsRead
);

/**
 * @swagger
 * /notifications/read-all:
 *   post:
 *     summary: Mark all as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All marked as read
 */
router.post('/read-all',
  authenticate,
  notificationController.markAllAsRead
);

/**
 * @swagger
 * /notifications/{id}/dismiss:
 *   post:
 *     summary: Dismiss notification
 *     tags: [Notifications]
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
 *         description: Dismissed
 */
router.post('/:id/dismiss',
  authenticate,
  validate(notificationIdParamSchema, 'params'),
  notificationController.dismissNotification
);

/**
 * @swagger
 * /notifications/schedule:
 *   post:
 *     summary: Schedule notification
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - title
 *               - body
 *               - channels
 *               - sendAt
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [success, action_required, integration, regulatory]
 *               title:
 *                 type: string
 *               body:
 *                 type: string
 *               channels:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [email, sms, push, inapp, whatsapp]
 *               data:
 *                 type: object
 *               priority:
 *                 type: string
 *                 enum: [low, medium, high, critical]
 *               sendAt:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Notification scheduled
 */
router.post('/schedule',
  authenticate,
  authorize('notification:create'),
  validate(scheduleNotificationSchema),
  notificationController.scheduleNotification
);

/**
 * @swagger
 * /notifications/schedule/{id}:
 *   delete:
 *     summary: Cancel scheduled notification
 *     tags: [Notifications]
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
 *         description: Scheduled notification cancelled
 */
router.delete('/schedule/:id',
  authenticate,
  authorize('notification:delete'),
  validate(notificationIdParamSchema, 'params'),
  notificationController.cancelScheduled
);

/**
 * @swagger
 * /notifications/test/{channel}:
 *   post:
 *     summary: Send test notification
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: channel
 *         required: true
 *         schema:
 *           type: string
 *           enum: [email, sms, push, inapp, whatsapp]
 *     responses:
 *       200:
 *         description: Test notification sent
 */
router.post('/test/:channel',
  authenticate,
  validate(channelParamSchema, 'params'),
  notificationController.sendTestNotification
);

/**
 * @swagger
 * /notifications/push/subscribe:
 *   post:
 *     summary: Subscribe to push notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - platform
 *             properties:
 *               token:
 *                 type: string
 *               platform:
 *                 type: string
 *                 enum: [ios, android, web]
 *               deviceId:
 *                 type: string
 *               model:
 *                 type: string
 *               appVersion:
 *                 type: string
 *     responses:
 *       200:
 *         description: Push subscription successful
 */
router.post('/push/subscribe',
  authenticate,
  validate(subscribePushSchema),
  notificationController.subscribePush
);

/**
 * @swagger
 * /notifications/push/unsubscribe:
 *   post:
 *     summary: Unsubscribe from push notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Push unsubscription successful
 */
router.post('/push/unsubscribe',
  authenticate,
  validate(unsubscribePushSchema),
  notificationController.unsubscribePush
);

/**
 * @swagger
 * /notifications/inapp:
 *   get:
 *     summary: Get in-app notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: unreadOnly
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: In-app notifications
 */
router.get('/inapp',
  authenticate,
  validate(inAppQuerySchema, 'query'),
  notificationController.getInAppNotifications
);

/**
 * @swagger
 * /notifications/stats:
 *   get:
 *     summary: Get notification statistics (admin only)
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Notification statistics
 */
router.get('/stats',
  authenticate,
  authorize('admin:read'),
  notificationController.getStatistics
);

export default router;
