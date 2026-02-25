import { Request, Response, NextFunction } from 'express';
import { auditLogRepository } from '../repositories/AuditLogRepository';
import { logger } from '../config/logger';
import { v4 as uuidv4 } from 'uuid';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      startTime: number;
    }
  }
}

export interface AuditLogOptions {
  action: string;
  entityType?: string;
  entityId?: string | (() => string);
  getEntityId?: (req: Request, res: Response) => string;
  metadata?: Record<string, any> | ((req: Request, res: Response) => Record<string, any>);
  skip?: (req: Request, res: Response) => boolean;
}

/**
 * Audit logging middleware
 */
export const auditLog = (options: AuditLogOptions) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip if specified
    if (options.skip && options.skip(req, res)) {
      return next();
    }

    // Store original end function
    const originalEnd = res.end;
    const chunks: Buffer[] = [];

    // Override write to capture response
    const originalWrite = res.write;
    res.write = function(chunk: any) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
      return originalWrite.apply(this, arguments as any);
    };

    // Override end to capture response and log
    res.end = function(chunk?: any) {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }

      // Restore original functions
      res.write = originalWrite;
      res.end = originalEnd;

      // Prepare audit log
      const responseBody = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;
      
      let responseData = null;
      try {
        if (responseBody && responseBody.trim().startsWith('{')) {
          responseData = JSON.parse(responseBody);
        }
      } catch (e) {
        // Ignore parsing errors
      }

      // Determine if action was successful
      const success = res.statusCode < 400;

      // Get entity ID
      let entityId: string | undefined;
      if (typeof options.entityId === 'function') {
        entityId = options.entityId();
      } else if (options.entityId) {
        entityId = options.entityId;
      } else if (options.getEntityId) {
        entityId = options.getEntityId(req, res);
      }

      // Get metadata
      let metadata: Record<string, any> = {};
      if (typeof options.metadata === 'function') {
        metadata = options.metadata(req, res);
      } else if (options.metadata) {
        metadata = { ...options.metadata };
      }

      // Add request/response metadata
      metadata = {
        ...metadata,
        requestId: req.requestId,
        statusCode: res.statusCode,
        duration: Date.now() - req.startTime,
        method: req.method,
        path: req.path,
        query: req.query,
        success
      };

      // Log to audit repository (async, don't await)
      auditLogRepository.log({
        user_id: req.user?.id,
        business_id: req.user?.business_id,
        action: options.action,
        entity_type: options.entityType || 'api',
        entity_id: entityId,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        session_id: req.sessionId,
        request_id: req.requestId,
        request_path: req.path,
        request_method: req.method,
        response_status: res.statusCode,
        response_time_ms: Date.now() - req.startTime,
        metadata
      }).catch(err => {
        logger.error('Failed to save audit log:', err);
      });

      // Call original end
      return originalEnd.apply(this, arguments as any);
    };

    next();
  };
};

/**
 * Generate request ID middleware
 */
export const requestId = (req: Request, res: Response, next: NextFunction) => {
  req.requestId = req.headers['x-request-id'] as string || uuidv4();
  res.setHeader('X-Request-ID', req.requestId);
  next();
};

/**
 * Request timer middleware
 */
export const requestTimer = (req: Request, res: Response, next: NextFunction) => {
  req.startTime = Date.now();
  next();
};

/**
 * Log all requests (for debugging)
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  logger.http(`${req.method} ${req.path}`, {
    requestId: req.requestId,
    ip: req.ip,
    userAgent: req.headers['user-agent']
  });
  next();
};

/**
 * Simple audit middleware for common actions
 */
export const audit = {
  /**
   * Log user action
   */
  userAction: (action: string, entityType?: string) => auditLog({
    action,
    entityType,
    metadata: (req) => ({
      userEmail: req.user?.email,
      userName: `${req.user?.first_name} ${req.user?.last_name}`.trim()
    })
  }),

  /**
   * Log resource creation
   */
  create: (entityType: string, getId?: (req: Request) => string) => auditLog({
    action: 'CREATE',
    entityType,
    entityId: getId,
    metadata: (req) => ({
      data: req.body
    })
  }),

  /**
   * Log resource update
   */
  update: (entityType: string, getId?: (req: Request) => string) => auditLog({
    action: 'UPDATE',
    entityType,
    entityId: getId,
    metadata: (req) => ({
      updates: req.body,
      id: req.params.id
    })
  }),

  /**
   * Log resource deletion
   */
  delete: (entityType: string, getId?: (req: Request) => string) => auditLog({
    action: 'DELETE',
    entityType,
    entityId: getId,
    metadata: (req) => ({
      id: req.params.id
    })
  }),

  /**
   * Log resource view
   */
  view: (entityType: string, getId?: (req: Request) => string) => auditLog({
    action: 'VIEW',
    entityType,
    entityId: getId,
    skip: (req) => req.method === 'OPTIONS'
  }),

  /**
   * Log export action
   */
  export: (entityType: string) => auditLog({
    action: 'EXPORT',
    entityType,
    metadata: (req) => ({
      format: req.query.format,
      filters: req.query
    })
  })
};
