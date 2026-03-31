# Cache bust: v4 — 2026-03-31
# Stage 1: Build TypeScript with Node 20
FROM node:20-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && ls -la dist/

# Stage 2: Runtime with Playwright + Chromium
FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app

# DO NOT install Node.js — the Playwright image already has it
RUN echo "Node: $(node --version) | npm: $(npm --version)"

# Tell Playwright to use the pre-installed browsers from the Docker image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install production deps — skip scripts to avoid re-downloading browsers
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

# Copy compiled JS from builder stage
COPY --from=builder /build/dist ./dist

# Verify everything loads
RUN node -e "require('express'); require('playwright'); console.log('All deps loaded OK')"

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/boot.js"]
