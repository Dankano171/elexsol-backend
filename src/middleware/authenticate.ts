import { Request, Response, NextFunction } from 'express';
import { tokenService } from '../services/auth/TokenService';
import { sessionService } from '../services/auth/SessionService';
import { userRepository } from '../repositories/UserRepository';
import { logger } from '../config/logger';
import { redis } from '../config/redis';

declare global {
  namespace Express {
    interface Request {
      user: any;
      sessionId: string;
      businessId: string;
    }
  }
}

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'No authorization token provided'
      });
    }

    const parts = authHeader.split(' ');
    
    if (parts.length !== 2) {
      return res.status(401).json({
        success: false,
        error: 'Invalid authorization header format'
      });
    }

    const [scheme, token] = parts;

    if (!/^Bearer$/i.test(scheme)) {
      return res.status(401).json({
        success: false,
        error: 'Invalid authorization scheme'
      });
    }

    // Check if token is blacklisted
    const isBlacklisted = await tokenService.isTokenBlacklisted(token);
    if (isBlacklisted) {
      return res.status(401).json({
        success: false,
        error: 'Token has been revoked'
      });
    }

    // Verify token
    let decoded;
    try {
      decoded = tokenService.verifyAccessToken(token);
    } catch (error) {
      if (error.message.includes('expired')) {
        return res.status(401).json({
          success: false,
          error: 'Token expired',
          code: 'TOKEN_EXPIRED'
        });
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }

    // Check if session exists
    if (decoded.session_id) {
      const session = await sessionService.getSession(decoded.session_id);
      if (!session) {
        return res.status(401).json({
          success: false,
          error: 'Session not found or expired'
        });
      }

      // Update last activity
      await sessionService.updateActivity(decoded.session_id);
      
      req.sessionId = decoded.session_id;
    }

    // Get user details
    const user = await userRepository.findById(decoded.sub);
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if user is active
    if (user.deleted_at) {
      return res.status(401).json({
        success: false,
        error: 'User account has been deactivated'
      });
    }

    // Check if business is active (for non-admin users)
    if (user.role !== 'super_admin' && user.business_id) {
      const businessKey = `business:${user.business_id}`;
      let business = await redis.get(businessKey);
      
      if (!business) {
        // In production, fetch from database
        business = JSON.stringify({ status: 'active' }); // Placeholder
      }

      const businessData = JSON.parse(business);
      if (businessData.status === 'suspended') {
        return res.status(403).json({
          success: false,
          error: 'Business account has been suspended'
        });
      }
    }

    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      business_id: user.business_id,
      permissions: user.permissions || []
    };

    req.businessId = user.business_id;

    // Log authenticated request (optional)
    logger.debug('Authenticated request', {
      userId: user.id,
      path: req.path,
      method: req.method
    });

    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

/**
 * Optional authentication - doesn't error if no token
 * Useful for public endpoints that may have user context
 */
export const optionalAuthenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return next();
    }

    const parts = authHeader.split(' ');
    
    if (parts.length !== 2 || !/^Bearer$/i.test(parts[0])) {
      return next();
    }

    const token = parts[1];

    try {
      const decoded = tokenService.verifyAccessToken(token);
      
      const user = await userRepository.findById(decoded.sub);
      
      if (user && !user.deleted_at) {
        req.user = {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          business_id: user.business_id
        };
        req.businessId = user.business_id;
        
        if (decoded.session_id) {
          req.sessionId = decoded.session_id;
          await sessionService.updateActivity(decoded.session_id);
        }
      }
    } catch (error) {
      // Ignore token errors for optional auth
      logger.debug('Optional auth token invalid', { error: error.message });
    }

    next();
  } catch (error) {
    // Don't block request on error
    next();
  }
};
