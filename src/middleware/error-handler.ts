import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';
import { getErrorCode, ERROR_CODES } from '../config/constants/error-codes';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: any;
  isOperational?: boolean;
}

export class ErrorHandler {
  /**
   * Handle 404 Not Found
   */
  static notFound(req: Request, res: Response, next: NextFunction) {
    const error: AppError = new Error(`Not Found - ${req.originalUrl}`);
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    error.isOperational = true;
    next(error);
  }

  /**
   * Global error handler
   */
  static handle(err: AppError, req: Request, res: Response, next: NextFunction) {
    // Set default values
    const statusCode = err.statusCode || 500;
    const errorCode = err.code || getErrorCode(statusCode).code;
    const message = err.message || 'Internal server error';
    const isOperational = err.isOperational !== false;

    // Log error
    const logLevel = statusCode >= 500 ? 'error' : 'warn';
    logger[logLevel]({
      message: err.message,
      stack: err.stack,
      statusCode,
      code: errorCode,
      path: req.path,
      method: req.method,
      ip: req.ip,
      userId: req.user?.id,
      details: err.details
    });

    // Don't leak stack traces in production
    const stack = process.env.NODE_ENV === 'production' ? undefined : err.stack;

    // Send response
    res.status(statusCode).json({
      success: false,
      error: {
        code: errorCode,
        message,
        details: err.details,
        ...(stack && { stack })
      }
    });
  }

  /**
   * Handle async errors
   */
  static asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
    return (req: Request, res: Response, next: NextFunction) => {
      fn(req, res, next).catch(next);
    };
  }
}

/**
 * Custom error classes
 */
export class ValidationError extends Error {
  statusCode = 400;
  code = 'VALIDATION_ERROR';
  details: any;
  isOperational = true;

  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}

export class AuthenticationError extends Error {
  statusCode = 401;
  code = 'AUTHENTICATION_ERROR';
  isOperational = true;

  constructor(message: string = 'Authentication failed') {
    super(message);
  }
}

export class AuthorizationError extends Error {
  statusCode = 403;
  code = 'AUTHORIZATION_ERROR';
  isOperational = true;

  constructor(message: string = 'Insufficient permissions') {
    super(message);
  }
}

export class NotFoundError extends Error {
  statusCode = 404;
  code = 'NOT_FOUND';
  isOperational = true;

  constructor(resource: string = 'Resource') {
    super(`${resource} not found`);
  }
}

export class ConflictError extends Error {
  statusCode = 409;
  code = 'CONFLICT';
  isOperational = true;

  constructor(message: string = 'Resource already exists') {
    super(message);
  }
}

export class RateLimitError extends Error {
  statusCode = 429;
  code = 'RATE_LIMIT_EXCEEDED';
  isOperational = true;

  constructor(message: string = 'Too many requests') {
    super(message);
  }
}

export class BusinessError extends Error {
  statusCode = 400;
  code = 'BUSINESS_ERROR';
  details: any;
  isOperational = true;

  constructor(message: string, code?: string, details?: any) {
    super(message);
    if (code) this.code = code;
    if (details) this.details = details;
  }
}

export class IntegrationError extends Error {
  statusCode = 502;
  code = 'INTEGRATION_ERROR';
  details: any;
  isOperational = true;

  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}

export class FIRSError extends Error {
  statusCode = 502;
  code = 'FIRS_ERROR';
  details: any;
  isOperational = true;

  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}
