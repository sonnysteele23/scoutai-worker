# Stage 1: Build TypeScript with Node 20
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && ls -la dist/

# Stage 2: Runtime with Playwright + Chromium
FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app

# Copy built app and production deps
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Verify everything is in place
RUN ls -la dist/index.js && node -e "console.log('Node', process.version, 'OK')"

EXPOSE 8080
ENV PORT=8080

CMD ["node", "dist/index.js"]
