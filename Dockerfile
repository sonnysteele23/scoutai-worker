FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Install Node.js 20
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL deps (including devDeps for build)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN rm -rf dist && node_modules/typescript/bin/tsc && ls -la dist/

# Remove devDeps to slim image
RUN npm prune --omit=dev

# Railway injects PORT — no HEALTHCHECK here, railway.toml handles it
CMD ["node", "dist/index.js"]
