FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# The Playwright image already ships Node.js — don't install another one
# Just verify it's available
RUN node --version && npm --version

# Copy package files and install ALL deps (including devDeps for build)
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN rm -rf dist && npx tsc && ls -la dist/

# Remove devDeps to slim image
RUN npm prune --omit=dev

# Wrap startup in a shell to catch crashes and print diagnostics
CMD node dist/index.js 2>&1 || (echo "[CRASH] Node exited with code $?" && exit 1)
