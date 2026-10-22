FROM node:26.12.0-bookworm-slim AS build
RUN npm install --global pnpm@12.14.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json eslint.config.js ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY docs ./docs
COPY examples ./examples
COPY deploy ./deploy
COPY .github ./.github
COPY Dockerfile LICENSE ADDITIONAL-PERMISSION.md NOTICE README.md .env.example .node-version .gitignore .dockerignore ./
COPY web ./web
ENV BUILD_DIR=/build
RUN pnpm typecheck && pnpm lint && pnpm build && pnpm prune --prod

FROM node:26.12.0-bookworm-slim
ENV NODE_ENV=production PORT=3211 WEB_DIR=/app/dist/web DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/LICENSE /app/ADDITIONAL-PERMISSION.md /app/NOTICE ./
COPY --from=build --chown=node:node /build/src ./dist/src
COPY --from=build --chown=node:node /build/web ./dist/web
USER node
EXPOSE 3211
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3211') + '/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
