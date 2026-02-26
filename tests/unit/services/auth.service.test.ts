import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authService } from '../../../src/services/auth/AuthService';
import { userRepository } from '../../../src/repositories/UserRepository';
import { sessionService } from '../../../src/services/auth/SessionService';
import { tokenService } from '../../../src/services/auth/TokenService';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

// Mock dependencies
vi.mock('../../../src/repositories/UserRepository');
vi.mock('../../../src/services/auth/SessionService');
vi.mock('../../../src/services/auth/TokenService');
vi.mock('bcrypt');

describe('AuthService', () => {
  const mockUser = {
    id: uuidv4(),
    email: 'test@example.com',
    password_hash: 'hashed_password',
    first_name: 'Test',
    last_name: 'User',
    business_id: uuidv4(),
    role: 'staff',
    mfa_enabled: false,
    login_attempts: 0,
    locked_until: null,
    deleted_at: null
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('login', () => {
    it('should login successfully with valid credentials', async () => {
      // Arrange
      const credentials = {
        email: 'test@example.com',
        password: 'password123'
      };

      vi.mocked(userRepository.findByEmail).mockResolvedValue(mockUser);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(userRepository.resetLoginAttempts).mockResolvedValue();
      vi.mocked(sessionService.createSession).mockResolvedValue('session-id');
      vi.mocked(tokenService.generateAccessToken).mockReturnValue({
        token: 'access-token',
        expiresAt: new Date(),
        tokenType: 'Bearer'
      });

      // Act
      const result = await authService.login(credentials);

      // Assert
      expect(result.success).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.tokens).toBeDefined();
      expect(result.requiresMFA).toBe(false);
      expect(userRepository.findByEmail).toHaveBeenCalledWith('test@example.com');
      expect(bcrypt.compare).toHaveBeenCalledWith('password123', 'hashed_password');
    });

    it('should return requiresMFA when MFA is enabled', async () => {
      // Arrange
      const credentials = {
        email: 'test@example.com',
        password: 'password123'
      };

      const mfaUser = { ...mockUser, mfa_enabled: true };
      vi.mocked(userRepository.findByEmail).mockResolvedValue(mfaUser);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

      // Act
      const result = await authService.login(credentials);

      // Assert
      expect(result.requiresMFA).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.tokens).toBeUndefined();
    });

    it('should throw error for invalid email', async () => {
      // Arrange
      const credentials = {
        email: 'wrong@example.com',
        password: 'password123'
      };

      vi.mocked(userRepository.findByEmail).mockResolvedValue(null);

      // Act & Assert
      await expect(authService.login(credentials)).rejects.toThrow('Invalid email or password');
    });

    it('should throw error for invalid password', async () => {
      // Arrange
      const credentials = {
        email: 'test@example.com',
        password: 'wrongpassword'
      };

      vi.mocked(userRepository.findByEmail).mockResolvedValue(mockUser);
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
      vi.mocked(userRepository.incrementLoginAttempts).mockResolvedValue();

      // Act & Assert
      await expect(authService.login(credentials)).rejects.toThrow('Invalid email or password');
      expect(userRepository.incrementLoginAttempts).toHaveBeenCalledWith(mockUser.id);
    });

    it('should throw error when account is locked', async () => {
      // Arrange
      const credentials = {
        email: 'test@example.com',
        password: 'password123'
      };

      const lockedUser = {
        ...mockUser,
        locked_until: new Date(Date.now() + 3600000)
      };

      vi.mocked(userRepository.findByEmail).mockResolvedValue(lockedUser);

      // Act & Assert
      await expect(authService.login(credentials)).rejects.toThrow('Account locked');
    });

    it('should verify MFA code when provided', async () => {
      // Arrange
      const credentials = {
        email: 'test@example.com',
        password: 'password123',
        mfaCode: '123456'
      };

      const mfaUser = { ...mockUser, mfa_enabled: true, mfa_secret: 'secret' };
      vi.mocked(userRepository.findByEmail).mockResolvedValue(mfaUser);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      
      // Mock MFA verification
      const speakeasy = { totp: { verify: vi.fn().mockReturnValue(true) } };
      vi.mock('speakeasy', () => speakeasy);

      vi.mocked(userRepository.resetLoginAttempts).mockResolvedValue();
      vi.mocked(sessionService.createSession).mockResolvedValue('session-id');
      vi.mocked(tokenService.generateAccessToken).mockReturnValue({
        token: 'access-token',
        expiresAt: new Date(),
        tokenType: 'Bearer'
      });

      // Act
      const result = await authService.login(credentials);

      // Assert
      expect(result.requiresMFA).toBe(false);
      expect(result.success).toBe(true);
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      // Arrange
      const sessionId = 'test-session-id';
      vi.mocked(sessionService.destroyAllUserSessions).mockResolvedValue(1);

      // Act
      await authService.logout(sessionId);

      // Assert
      expect(sessionService.destroyAllUserSessions).toHaveBeenCalledWith(sessionId);
    });
  });

  describe('changePassword', () => {
    it('should change password successfully', async () => {
      // Arrange
      const userId = mockUser.id;
      const oldPassword = 'oldpass';
      const newPassword = 'newpass123';

      vi.mocked(userRepository.findById).mockResolvedValue(mockUser);
      vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);
      vi.mocked(userRepository.isPasswordReused).mockResolvedValue(false);
      vi.mocked(bcrypt.hash).mockResolvedValue('new_hashed' as never);
      vi.mocked(userRepository.updatePassword).mockResolvedValue();
      vi.mocked(userRepository.addToPasswordHistory).mockResolvedValue();

      // Act
      await authService.changePassword(userId, oldPassword, newPassword);

      // Assert
      expect(userRepository.findById).toHaveBeenCalledWith(userId);
      expect(bcrypt.compare).toHaveBeenCalledWith(oldPassword, mockUser.password_hash);
      expect(userRepository.updatePassword).toHaveBeenCalledWith(userId, 'new_hashed');
    });

    it('should throw error if old password is incorrect', async () => {
      // Arrange
      const userId = mockUser.id;
      const oldPassword = 'wrongpass';
      const newPassword = 'newpass123';

      vi.mocked(userRepository.findById).mockResolvedValue(mockUser);
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

      // Act & Assert
      await expect(authService.changePassword(userId, oldPassword, newPassword))
        .rejects.toThrow('Current password is incorrect');
    });

    it('should throw error if password is reused', async () => {
      // Arrange
      const userId = mockUser.id;
      const oldPassword = 'oldpass';
      const newPassword = 'reusedpass';

      vi.mocked(userRepository.findById).mockResolvedValue(mockUser);
      vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);
      vi.mocked(userRepository.isPasswordReused).mockResolvedValue(true);

      // Act & Assert
      await expect(authService.changePassword(userId, oldPassword, newPassword))
        .rejects.toThrow('Cannot reuse a recent password');
    });
  });

  describe('refreshToken', () => {
    it('should refresh token successfully', async () => {
      // Arrange
      const refreshToken = 'valid-refresh-token';
      const session = {
        user_id: mockUser.id,
        business_id: mockUser.business_id,
        session_token: 'session-id'
      };

      vi.mocked(sessionService.validateRefreshToken).mockResolvedValue(session);
      vi.mocked(tokenService.generateAccessToken).mockReturnValue({
        token: 'new-access-token',
        expiresAt: new Date(),
        tokenType: 'Bearer'
      });

      // Act
      const result = await authService.refreshToken(refreshToken);

      // Assert
      expect(result).toBeDefined();
      expect(result.accessToken).toBe('new-access-token');
      expect(sessionService.validateRefreshToken).toHaveBeenCalledWith(refreshToken);
    });

    it('should throw error for invalid refresh token', async () => {
      // Arrange
      const refreshToken = 'invalid-token';
      vi.mocked(sessionService.validateRefreshToken).mockResolvedValue(null);

      // Act & Assert
      await expect(authService.refreshToken(refreshToken))
        .rejects.toThrow('Invalid or expired refresh token');
    });
  });
});
