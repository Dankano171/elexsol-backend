import winston from 'winston';
import path from 'path';

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

// Add colors to winston
winston.addColors(colors);

// Define log format
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(
    (info) => {
      const { timestamp, level, message, stack, ...meta } = info;
      let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
      
      if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
      }
      
      if (stack) {
        log += `\n${stack}`;
      }
      
      return log;
    }
  )
);

// Define console format with colors
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.printf(
    (info) => {
      const { timestamp, level, message, stack, ...meta } = info;
      let log = `${timestamp} ${level}: ${message}`;
      
      if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
      }
      
      if (stack) {
        log += `\n${stack}`;
      }
      
      return log;
    }
  )
);

// Define transports
const transports = [
  // Console transport
  new winston.transports.Console({
    format: consoleFormat,
  }),
  
  // Error log file
  new winston.transports.File({
    filename: path.join('logs', 'error.log'),
    level: 'error',
    maxsize: 10485760, // 10MB
    maxFiles: 5,
    format,
  }),
  
  // Combined log file
  new winston.transports.File({
    filename: path.join('logs', 'combined.log'),
    maxsize: 10485760, // 10MB
    maxFiles: 5,
    format,
  }),
];

// Add HTTP log file in production
if (process.env.NODE_ENV === 'production') {
  transports.push(
    new winston.transports.File({
      filename: path.join('logs', 'http.log'),
      level: 'http',
      maxsize: 10485760,
      maxFiles: 5,
      format,
    })
  );
}

// Create the logger
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels,
  format,
  transports,
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join('logs', 'exceptions.log'),
      format,
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join('logs', 'rejections.log'),
      format,
    }),
  ],
});

// Stream for Morgan HTTP logger
export const stream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};

// Log uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Create child logger with context
export const createContextLogger = (context: string) => {
  return logger.child({ context });
};

// Performance logging
export const perfLogger = {
  start: (operation: string): (() => void) => {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      logger.debug(`PERF: ${operation} took ${duration}ms`);
    };
  },
  
  measure: async function<T>(
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      logger.debug(`PERF: ${operation} completed in ${duration}ms`);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      logger.error(`PERF: ${operation} failed after ${duration}ms:`, error);
      throw error;
    }
  },
};

export default logger;
