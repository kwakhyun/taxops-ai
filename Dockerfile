# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS contract-test
COPY . .
CMD ["npm", "run", "test:db-contract"]

FROM dependencies AS migrator
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY src/lib/db ./src/lib/db
CMD ["npm", "run", "db:migrate"]

FROM base AS worker
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs worker
COPY --chown=worker:nodejs src/worker ./src/worker
COPY --chown=worker:nodejs src/lib/jobs ./src/lib/jobs
COPY --chown=worker:nodejs src/lib/security ./src/lib/security
COPY --chown=worker:nodejs src/lib/runtime ./src/lib/runtime
COPY --chown=worker:nodejs src/lib/files ./src/lib/files
COPY --chown=worker:nodejs src/lib/documents ./src/lib/documents
COPY --chown=worker:nodejs src/lib/ai/guardrails.ts ./src/lib/ai/guardrails.ts
USER worker
CMD ["node", "--experimental-strip-types", "src/worker/index.ts"]

FROM base AS reviewer
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs reviewer
COPY --chown=reviewer:nodejs src/reviewer ./src/reviewer
COPY --chown=reviewer:nodejs src/lib/auth/token-policy.ts ./src/lib/auth/token-policy.ts
COPY --chown=reviewer:nodejs src/lib/documents/evidence-manifest.ts ./src/lib/documents/evidence-manifest.ts
COPY --chown=reviewer:nodejs src/lib/review/service-crypto.ts ./src/lib/review/service-crypto.ts
COPY --chown=reviewer:nodejs src/lib/security/approval-token.ts ./src/lib/security/approval-token.ts
COPY --chown=reviewer:nodejs src/lib/workpapers/artifact.ts ./src/lib/workpapers/artifact.ts
USER reviewer
EXPOSE 3100
ENV PORT=3100
CMD ["node", "--experimental-strip-types", "src/reviewer/index.ts"]

FROM dependencies AS builder
COPY . .
RUN npm run eval && npm run build

FROM base AS web
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
