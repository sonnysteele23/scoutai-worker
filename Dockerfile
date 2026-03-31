# Stage 1: Build TypeScript
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Stage 2: Runtime
FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production deps — playwright is already in the base image
# but other deps (express, axios, etc.) need to be installed
RUN npm install --omit=dev --ignore-scripts 2>&1

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Verify
RUN node -e "require('express'); require('playwright'); console.log('All deps OK')" 2>&1

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/index.js"]
