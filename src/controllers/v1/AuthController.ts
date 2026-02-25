import { Request, Response } from 'express';
import { authService } from '../../services/auth/AuthService';
import { tokenService } from '../../services/auth/TokenService';
import { mfaService } from '../../services/auth/MFAService';
import { auditLogRepository } from '../../repositories/AuditLogRepository';
import { logger } from '../../config/logger';
import { validate } from '../../middleware/validate';
import Joi from 'joi';

export class AuthController {
  /**
   * Login user
   */
  async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, password, mfaCode, rememberMe } = req.body;

      const result = await authService.login(
        { email, password, mfaCode, rememberMe },
        req.ip,
        req.headers['user-agent']
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Login error:', error);
      res.status(401).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Logout user
   */
  async logout(req: Request, res: Response): Promise<void> {
    try {
      const sessionToken = req.headers['x-session-token'] as string;
      
      if (sessionToken) {
        await authService.logout(sessionToken);
      }

      res.json({
        success: true,
        message: 'Logged out successfully'
      });
    } catch (error) {
      logger.error('Logout error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Refresh token
   */
  async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      const { refreshToken } = req.body;

      const tokens = await authService.refreshToken(refreshToken);

      res.json({
        success: true,
        data: tokens
      });
    } catch (error) {
      logger.error('Token refresh error:', error);
      res.status(401).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Setup MFA
   */
  async setupMFA(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user.id;

      const config = await authService.setupMFA(userId);

      res.json({
        success: true,
        data: config
      });
    } catch (error) {
      logger.error('MFA setup error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Verify MFA
   */
  async verifyMFA(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user.id;
      const { code } = req.body;

      const isValid = await authService.verifyMFA(userId, code);

      if (!isValid) {
        res.status(400).json({
          success: false,
          error: 'Invalid MFA code'
        });
        return;
      }

      res.json({
        success: true,
        message: 'MFA verified successfully'
      });
    } catch (error) {
      logger.error('MFA verification error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Disable MFA
   */
  async disableMFA(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user.id;
      const { code } = req.body;

      await authService.disableMFA(userId, code);

      res.json({
        success: true,
        message: 'MFA disabled successfully'
      });
    } catch (error) {
      logger.error('MFA disable error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Change password
   */
  async changePassword(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user.id;
      const { oldPassword, newPassword } = req.body;

      await authService.changePassword(userId, oldPassword, newPassword);

      res.json({
        success: true,
        message: 'Password changed successfully'
      });
    } catch (error) {
      logger.error('Password change error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Request password reset
   */
  async requestPasswordReset(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      const resetToken = await authService.requestPasswordReset(email);

      // In production, send email with reset link
      // For now, return token for testing
      res.json({
        success: true,
        message: 'Password reset email sent',
        data: { resetToken } // Remove in production
      });
    } catch (error) {
      logger.error('Password reset request error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Reset password
   */
  async resetPassword(req: Request, res: Response): Promise<void> {
    try {
      const { token, newPassword } = req.body;

      await authService.resetPassword(token, newPassword);

      res.json({
        success: true,
        message: 'Password reset successfully'
      });
    } catch (error) {
      logger.error('Password reset error:', error);
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get current user
   */
  async getCurrentUser(req: Request, res: Response): Promise<void> {
    try {
      res.json({
        success: true,
        data: req.user
      });
    } catch (error) {
      logger.error('Get current user error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get active sessions
   */
  async getActiveSessions(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user.id;

      const sessions = await sessionService.getUserSessions(userId, req.sessionId);

      res.json({
        success: true,
        data: sessions
      });
    } catch (error) {
      logger.error('Get sessions error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Revoke session
   */
  async revokeSession(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user.id;
      const { sessionId } = req.params;

      if (sessionId === req.sessionId) {
        res.status(400).json({
          success: false,
          error: 'Cannot revoke current session'
        });
        return;
      }

      await sessionService.destroySession(sessionId);

      res.json({
        success: true,
        message: 'Session revoked successfully'
      });
    } catch (error) {
      logger.error('Revoke session error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Revoke all sessions
   */
  async revokeAllSessions(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user.id;

      await authService.logoutAll(userId, req.sessionId);

      res.json({
        success: true,
        message: 'All other sessions revoked'
      });
    } catch (error) {
      logger.error('Revoke all sessions error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export const authController = new AuthController();
