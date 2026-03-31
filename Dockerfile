# Stage 1: Build TypeScript
FROM node:20-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && ls -la dist/

# Stage 2: Runtime
FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app

# Show what browsers are pre-installed in the image
RUN echo "=== Pre-installed browsers ===" && ls -la /ms-playwright/ && find /ms-playwright -maxdepth 2 -type d

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=8080

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /build/dist ./dist

# Verify browser path at build time
RUN node -e "\
  const pw = require('playwright');\
  const path = pw.chromium.executablePath();\
  const fs = require('fs');\
  console.log('Browser executable:', path);\
  console.log('Exists:', fs.existsSync(path));\
  if (!fs.existsSync(path)) {\
    console.log('Looking for alternatives...');\
    const { execSync } = require('child_process');\
    console.log(execSync('find /ms-playwright -name chrome-headless-shell -o -name chromium 2>/dev/null || echo NONE FOUND').toString());\
  }\
"

EXPOSE 8080
CMD ["node", "dist/boot.js"]
