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

# Playwright browsers are already installed in this image
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD tells postinstall not to re-download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=8080

COPY package*.json ./
RUN npm install --omit=dev && echo "npm install done"

COPY --from=builder /build/dist ./dist

# Verify
RUN node -e "const pw = require('playwright'); console.log('Playwright OK, browsers at', pw.chromium.executablePath())"

EXPOSE 8080
CMD ["node", "dist/boot.js"]
# redeploy Tue Mar 31 13:26:47 PDT 2026
