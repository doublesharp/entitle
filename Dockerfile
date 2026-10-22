FROM node:26.12.0-bookworm-slim AS build
RUN npm install --global pnpm@12.14.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN pnpm install --frozen-lockfile --filter @entitle/server...
COPY tsconfig.json ./
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY src ./src
COPY packages/shared ./packages/shared
COPY scripts/build-server.ts ./scripts/build-server.ts
ENV BUILD_DIR=/build
RUN node scripts/build-server.ts
RUN pnpm --filter @entitle/server deploy --legacy --prod /runtime

FROM node:26.12.0-bookworm-slim
ENV NODE_ENV=production PORT=3211 WEB_DIR=/app/web DATA_DIR=/data
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /build/server/package.json ./package.json
COPY --from=build --chown=node:node /build/server/src ./src
COPY --from=build --chown=node:node /build/server/packages ./packages
COPY LICENSE ADDITIONAL-PERMISSION.md NOTICE ./
USER node
EXPOSE 3211
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3211') + '/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
