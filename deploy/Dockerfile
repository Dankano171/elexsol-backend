# Multi-stage Dockerfile for Elexsol API

# ---- Build Stage ----
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN yarn build

# Prune dev dependencies
RUN yarn install --production --frozen-lockfile

# ---- Development Stage ----
FROM builder AS development

WORKDIR /app

# Install nodemon for hot reload
RUN yarn global add nodemon

# Expose port
EXPOSE 3000

# Start development server
CMD ["nodemon", "--exec", "ts-node", "src/index.ts"]

# ---- Production Stage ----
FROM node:18-alpine AS production

# Set working directory
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Install curl for healthcheck
RUN apk --no-cache add curl

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./
COPY --from=builder --chown=nodejs:nodejs /app/yarn.lock ./

# Create necessary directories
RUN mkdir -p logs certs uploads && \
    chown -R nodejs:nodejs logs certs uploads

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start application
CMD ["node", "dist/index.js"]

# ---- Test Stage ----
FROM builder AS test

WORKDIR /app

# Run tests
CMD ["yarn", "test"]

# ---- Lint Stage ----
FROM builder AS lint

WORKDIR /app

# Run linter
CMD ["yarn", "lint"]
