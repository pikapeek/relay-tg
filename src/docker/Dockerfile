# ---------------------------------------------------------------------------
# RelayTG Docker runtime (task 11.2). Runs the same TypeScript core the Cloudflare
# worker uses, over node:sqlite. The image type-checks everything in the build
# stage, then runs the Docker app via tsx (the codebase is ESM + .ts imports;
# tsc runs with noEmit, so the container executes the source directly).
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Dependency layer: lockfile + manifests first, so rebuilds reuse the layer.
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY src/packages ./src/packages
COPY src/adapters ./src/adapters
COPY src/apps ./src/apps
COPY src/migrations ./src/migrations

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app

# The database lives on a mounted volume (see docker-compose.yml).
ENV DATABASE_PATH=/app/data/relaytg.db
ENV PORT=17575
EXPOSE 17575

CMD ["pnpm", "--filter", "@relaytg/app-docker", "start"]