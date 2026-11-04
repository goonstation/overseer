# syntax=docker/dockerfile:1

FROM docker:29-cli AS docker-cli

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build \
    && npm prune --omit=dev --offline --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8564

# Overseer invokes Docker and the server's Compose wrapper against an external daemon.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN ln -s /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/

# Root supports configured artifact chown and the host Docker socket.
EXPOSE 8564
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/index.js"]
