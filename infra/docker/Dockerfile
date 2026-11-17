# syntax=docker/dockerfile:1.7
# One image for every MintRail Node service; docker-compose.yml picks the entrypoint.
FROM node:22.22.2-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# Dependency layer (cached until a manifest or the lockfile changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY ledger/package.json ledger/
COPY conductor/package.json conductor/
COPY junction/package.json junction/
COPY api/package.json api/
COPY depot/package.json depot/
COPY signal/package.json signal/
COPY sdk-node/package.json sdk-node/
COPY packages/web/package.json packages/web/
COPY dashboard/package.json dashboard/
COPY railyard/package.json railyard/
COPY tests/parity/package.json tests/parity/
COPY tools/eslint-plugin-mintrail tools/eslint-plugin-mintrail
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "!@mintrail/dashboard" --filter "!@mintrail/railyard" --filter "!@mintrail/web"

COPY packages packages
COPY ledger ledger
COPY conductor conductor
COPY junction junction
COPY signal signal
COPY api api
COPY depot depot
COPY drizzle drizzle
RUN pnpm --filter "./packages/**" --filter ./ledger --filter ./conductor --filter ./junction --filter ./signal --filter ./api --filter ./depot run build

FROM node:22.22.2-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8000 8100 8200 8300
CMD ["node", "api/dist/main-server.js"]
