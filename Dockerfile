# Multi-stage production container for @civicmerge/api (Node 24)
FROM node:24-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/web-admin/package.json apps/web-admin/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ai-vision/package.json packages/ai-vision/package.json
COPY packages/matching/package.json packages/matching/package.json
RUN npm ci --workspace=@civicmerge/api --include-workspace-root --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY packages/ai-vision ./packages/ai-vision
COPY packages/matching ./packages/matching
COPY apps/api ./apps/api
COPY supabase/migrations ./supabase/migrations
COPY mocks/fixtures ./mocks/fixtures

RUN mkdir -p /app/.runtime/uploads && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "tsx", "apps/api/src/server.ts"]
