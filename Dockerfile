# One image, all three apps. They share a workspace and a build; which one runs is the
# command, not the image. Three near-identical Dockerfiles would drift.
#
# Deliberately not a distroless or alpine base: @livekit/rtc-node and sharp (via kokoro-js)
# ship glibc prebuilds, and musl would send both to a source build that needs a toolchain.

FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/dialer/package.json apps/dialer/
COPY apps/call-worker/package.json apps/call-worker/

RUN npm ci

COPY packages packages
COPY apps apps

RUN npm run build


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages packages
COPY --from=build /app/apps apps

# Read at runtime: the flow seed, and the migrations the seed expects to have been applied.
COPY db db

# The audio cache is written at boot by the pre-warm. Owned by `node` so the container does
# not need to run as root to fill it.
RUN mkdir -p /app/.cache/audio && chown -R node:node /app/.cache

USER node

# Overridden per service in docker-compose.yml.
CMD ["node", "apps/call-worker/dist/index.js"]
