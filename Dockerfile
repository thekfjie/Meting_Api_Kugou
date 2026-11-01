# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS api-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS upstream-deps
WORKDIR /app
COPY KuGouMusicApi/package.json KuGouMusicApi/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS upstream
ENV NODE_ENV=production PORT=3100 HOST=0.0.0.0
WORKDIR /app
COPY --from=upstream-deps /app/node_modules ./node_modules
COPY KuGouMusicApi/package.json KuGouMusicApi/app.js KuGouMusicApi/server.js ./
COPY KuGouMusicApi/module ./module
COPY KuGouMusicApi/util ./util
COPY KuGouMusicApi/public ./public
COPY KuGouMusicApi/docs ./docs
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "app.js"]

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production HTTP_PORT=3000
WORKDIR /app
COPY --from=api-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p cookie data && chown node:node cookie data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.HTTP_PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/index.js"]
