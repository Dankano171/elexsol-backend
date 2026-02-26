import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../../src/app';
import { db } from '../../../src/config/database';
import { redis } from '../../../src/config/redis';
import { userRepository } from '../../../src/repositories/UserRepository';
import { v4 as uuidv4 } from 'uuid';

describe('Auth API Integration Tests', () => {
  let server: any;

  beforeAll(async () => {
    // Start server on random port
    server = app.listen(0);
  });

  afterAll(async () => {
    await server.close();
    await db.close();
    await redis.quit();
  });

  beforeEach(async () => {
    // Clean database
    await db.query('DELETE FROM users WHERE email LIKE $1', ['%@test.com%']);
  });

  describe('POST /api/v1/auth/register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        email: `test-${uuidv4()}@test.com`,
        password: 'Password123!',
        first_name: 'Test',
        last_name: 'User',
        phone: '+2348012345678'
      };

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data.email).toBe(userData.email);
      expect(response.body.data).not.toHaveProperty('password');
    });

    it('should return 400 for invalid email', async () => {
      const userData = {
        email: 'invalid-email',
        password: 'Password123!',
        first_name: 'Test',
        last_name: 'User'
      };

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 for weak password', async () => {
      const userData = {
        email: `test-${uuidv4()}@test.com`,
        password: 'weak',
        first_name: 'Test',
        last_name: 'User'
      };

      const response = await request(app)
        .post('/api/v1/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 409 for duplicate email', async () => {
      const email = `test-${uuidv4()}@test.com`;
      
      // First registration
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email,
          password: 'Password123!',
          first_name: 'Test',
          last_name: 'User'
        });

      // Duplicate registration
      const response = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email,
          password: 'Password123!',
          first_name: 'Test',
          last_name: 'User'
        })
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Email already registered');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      // First register a user
      const email = `test-${uuidv4()}@test.com`;
      const password = 'Password123!';

      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email,
          password,
          first_name: 'Test',
          last_name: 'User'
        });

      // Then login
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('tokens');
      expect(response.body.data.tokens).toHaveProperty('accessToken');
      expect(response.body.data.tokens).toHaveProperty('refreshToken');
      expect(response.body.data.user.email).toBe(email);
    });

    it('should return 401 for invalid password', async () => {
      const email = `test-${uuidv4()}@test.com`;

      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email,
          password: 'Password123!',
          first_name: 'Test',
          last_name: 'User'
        });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'WrongPassword!' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid email or password');
    });

    it('should return 401 for non-existent user', async () => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'nonexistent@test.com',
          password: 'Password123!'
        })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid email or password');
    });

    it('should return 429 after too many failed attempts', async () => {
      const email = `test-${uuidv4()}@test.com`;
      const password = 'Password123!';

      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email,
          password,
          first_name: 'Test',
          last_name: 'User'
        });

      // Make 5 failed attempts
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email, password: 'WrongPassword!' });
      }

      // 6th attempt should be rate limited
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'WrongPassword!' })
        .expect(429);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Too many requests');
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('should refresh token successfully', async () => {
      // First login to get tokens
      const email = `test-${uuidv4()}@test.com`;
      const password = 'Password123!';

      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email,
          password,
          first_name: 'Test',
          last_name: 'User'
        });

      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password });

      const { refreshToken } = loginResponse.body.data.tokens;

      // Then refresh
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('accessToken');
      expect(response.body.data).toHaveProperty('refreshToken');
    });

    it('should return 401 for invalid refresh token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid-token' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Invalid refresh token');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('should logout successfully', async () => {
      // First login
      const email = `test-${uuidv4()}@test.com`;
      const password = 'Password123!';

      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email,
          password,
          first_name: 'Test',
          last_name: 'User'
        });

      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password });

      const { accessToken } = loginResponse.body.data.tokens;

      // Then logout
      const response = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Logged out successfully');
    });

    it('should return 401 without token', async () => {
      const response = await request(app)
        .post('/api/v1/auth/logout')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('No authorization token provided');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('should get current user info', async () => {
      // First login
      const email = `test-${uuidv4()}@test.com`;
      const password = 'Password123!';

      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email,
          password,
          first_name: 'Test',
          last_name: 'User'
        });

      const loginResponse = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password });

      const { accessToken } = loginResponse.body.data.tokens;

      // Get user info
      const response = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe(email);
      expect(response.body.data.first_name).toBe('Test');
      expect(response.body.data.last_name).toBe('User');
    });
  });
});
