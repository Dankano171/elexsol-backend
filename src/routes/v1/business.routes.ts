import { Router } from 'express';
import { businessController } from '../../controllers/v1/BusinessController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import Joi from 'joi';

const router = Router();

// Validation schemas
const updateBusinessSchema = Joi.object({
  name: Joi.string(),
  legal_name: Joi.string(),
  email: Joi.string().email(),
  phone: Joi.string().pattern(/^\+?[\d\s-]{10,}$/),
  address: Joi.string(),
  city: Joi.string(),
  state: Joi.string(),
  country: Joi.string().length(2),
  postal_code: Joi.string(),
  website: Joi.string().uri(),
  logo: Joi.string().uri()
});

const updateSettingsSchema = Joi.object({
  tax_settings: Joi.object({
    vat_rate: Joi.number().min(0).max(100),
    vat_filing_frequency: Joi.string().valid('monthly', 'quarterly', 'annual'),
    witholding_tax_rate: Joi.number().min(0).max(100),
    excise_duty_rates: Joi.object().pattern(Joi.string(), Joi.number())
  }),
  integration_settings: Joi.object({
    zoho: Joi.object(),
    whatsapp: Joi.object(),
    quickbooks: Joi.object()
  }),
  settings: Joi.object({
    language: Joi.string().length(2),
    timezone: Joi.string(),
    date_format: Joi.string(),
    currency: Joi.string().length(3)
  })
});

const bankDetailsSchema = Joi.object({
  bank_name: Joi.string().required(),
  bank_code: Joi.string().required(),
  account_name: Joi.string().required(),
  account_number: Joi.string().pattern(/^\d{10}$/).required(),
  account_type: Joi.string().valid('savings', 'current').required()
});

/**
 * @swagger
 * /business:
 *   get:
 *     summary: Get current business
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Business details
 */
router.get('/',
  authenticate,
  businessController.getCurrentBusiness
);

/**
 * @swagger
 * /business:
 *   put:
 *     summary: Update business
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               legal_name:
 *                 type: string
 *               email:
 *                 type: string
 *               phone:
 *                 type: string
 *               address:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               country:
 *                 type: string
 *               postal_code:
 *                 type: string
 *               website:
 *                 type: string
 *               logo:
 *                 type: string
 *     responses:
 *       200:
 *         description: Business updated
 */
router.put('/',
  authenticate,
  authorize('business:write'),
  validate(updateBusinessSchema),
  businessController.updateBusiness
);

/**
 * @swagger
 * /business/settings:
 *   get:
 *     summary: Get business settings
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Business settings
 */
router.get('/settings',
  authenticate,
  businessController.getSettings
);

/**
 * @swagger
 * /business/settings:
 *   put:
 *     summary: Update business settings
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tax_settings:
 *                 type: object
 *               integration_settings:
 *                 type: object
 *               settings:
 *                 type: object
 *     responses:
 *       200:
 *         description: Settings updated
 */
router.put('/settings',
  authenticate,
  authorize('business:write'),
  validate(updateSettingsSchema),
  businessController.updateSettings
);

/**
 * @swagger
 * /business/users:
 *   get:
 *     summary: Get business users
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [admin, manager, staff]
 *     responses:
 *       200:
 *         description: List of business users
 */
router.get('/users',
  authenticate,
  authorize('business:read'),
  businessController.getUsers
);

/**
 * @swagger
 * /business/stats:
 *   get:
 *     summary: Get business statistics
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Business statistics
 */
router.get('/stats',
  authenticate,
  authorize('business:read'),
  businessController.getStatistics
);

/**
 * @swagger
 * /business/firs-status:
 *   get:
 *     summary: Get FIRS status
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: FIRS registration status
 */
router.get('/firs-status',
  authenticate,
  businessController.getFIRSStatus
);

/**
 * @swagger
 * /business/subscription:
 *   get:
 *     summary: Get subscription info
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription details
 */
router.get('/subscription',
  authenticate,
  businessController.getSubscription
);

/**
 * @swagger
 * /business/bank-details:
 *   get:
 *     summary: Get bank details
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bank details
 */
router.get('/bank-details',
  authenticate,
  businessController.getBankDetails
);

/**
 * @swagger
 * /business/bank-details:
 *   post:
 *     summary: Add bank details
 *     tags: [Business]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - bank_name
 *               - bank_code
 *               - account_name
 *               - account_number
 *               - account_type
 *             properties:
 *               bank_name:
 *                 type: string
 *               bank_code:
 *                 type: string
 *               account_name:
 *                 type: string
 *               account_number:
 *                 type: string
 *               account_type:
 *                 type: string
 *                 enum: [savings, current]
 *     responses:
 *       201:
 *         description: Bank details added
 */
router.post('/bank-details',
  authenticate,
  authorize('business:write'),
  validate(bankDetailsSchema),
  businessController.addBankDetails
);

export default router;
