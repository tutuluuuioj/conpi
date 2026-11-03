# Conpi Phala Intel TDX TEE Confidential Proxy Container
# Reproducible build for Phala dstack CVM

FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Production runtime stage
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DSTACK_SOCKET_PATH=/var/run/tappd.sock
ENV IS_ENCLAVE=true

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

EXPOSE 8080

CMD ["node", "dist/index.js"]
