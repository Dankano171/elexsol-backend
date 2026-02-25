import { Router } from 'express';
import { userController } from '../../controllers/v1/UserController';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { rateLimit } from '../../middleware/rate-limit';
import Joi from 'joi';

const router = Router();

// Validation schemas
const createUserSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  first_name: Joi.string().required(),
  last_name: Joi.string().required(),
  phone: Joi.string().pattern(/^\+?[\d\s-]{10,}$/),
  role: Joi.string().valid('admin', 'manager', 'staff').default('staff'),
  permissions: Joi.array().items(Joi.string())
});

const updateUserSchema = Joi.object({
  first_name: Joi.string(),
  last_name: Joi.string(),
  phone: Joi.string().pattern(/^\+?[\d\s-]{10,}$/),
  role: Joi.string().valid('admin', 'manager', 'staff'),
  permissions: Joi.array().items(Joi.string()),
  notification_preferences: Joi.object({
    email: Joi.boolean(),
    sms: Joi.boolean(),
    push: Joi.boolean(),
    digest: Joi.string().valid('daily', 'weekly', 'monthly', 'never'),
    types: Joi.array().items(Joi.string())
  })
});

const updatePermissionsSchema = Joi.object({
  permissions: Joi.array().items(Joi.string()).required()
});

const userIdParamSchema = Joi.object({
  id: Joi.string().uuid().required()
});

const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  role: Joi.string().valid('admin', 'manager', 'staff'),
  businessId: Joi.string().uuid()
});

const searchSchema = Joi.object({
  q: Joi.string().required().min(2)
});

/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get all users
 *     tags: [Users]
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
 *         name: role
 *         schema:
 *           type: string
 *           enum: [admin, manager, staff]
 *       - in: query
 *         name: businessId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of users
 */
router.get('/',
  authenticate,
  authorize('user:read'),
  validate(paginationSchema, 'query'),
  userController.getAllUsers
);

/**
 * @swagger
 * /users/search:
 *   get:
 *     summary: Search users
 *     tags: [Users]
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
  authorize('user:read'),
  validate(searchSchema, 'query'),
  userController.searchUsers
);

/**
 * @swagger
 * /users/stats:
 *   get:
 *     summary: Get user statistics
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User statistics
 */
router.get('/stats',
  authenticate,
  authorize('user:read'),
  userController.getUserStats
);

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get user by ID
 *     tags: [Users]
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
 *         description: User details
 */
router.get('/:id',
  authenticate,
  authorize('user:read'),
  validate(userIdParamSchema, 'params'),
  userController.getUserById
);

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Create user
 *     tags: [Users]
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
 *               - first_name
 *               - last_name
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               first_name:
 *                 type: string
 *               last_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [admin, manager, staff]
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: User created
 */
router.post('/',
  authenticate,
  authorize('user:create'),
  validate(createUserSchema),
  userController.createUser
);

/**
 * @swagger
 * /users/{id}:
 *   put:
 *     summary: Update user
 *     tags: [Users]
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
 *               first_name:
 *                 type: string
 *               last_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [admin, manager, staff]
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: User updated
 */
router.put('/:id',
  authenticate,
  authorize('user:update'),
  validate(userIdParamSchema, 'params'),
  validate(updateUserSchema),
  userController.updateUser
);

/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Delete user
 *     tags: [Users]
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
 *         description: User deleted
 */
router.delete('/:id',
  authenticate,
  authorize('user:delete'),
  validate(userIdParamSchema, 'params'),
  userController.deleteUser
);

/**
 * @swagger
 * /users/{id}/permissions:
 *   put:
 *     summary: Update user permissions
 *     tags: [Users]
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
 *               - permissions
 *             properties:
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Permissions updated
 */
router.put('/:id/permissions',
  authenticate,
  authorize('user:update'),
  validate(userIdParamSchema, 'params'),
  validate(updatePermissionsSchema),
  userController.updatePermissions
);

export default router;
