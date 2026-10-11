# Pin a reviewed image digest in the release environment before publication.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /opt/homecare
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim
WORKDIR /opt/homecare
ENV NODE_ENV=production PORT=8080 DATA_DIR=/var/lib/homecare HOME_CARE_AUTH_MODE=portal HOME_CARE_REQUIRE_PERSISTENT_STORAGE=1
COPY --from=dependencies --chown=node:node /opt/homecare/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/check-runtime-readiness.mjs ./scripts/check-runtime-readiness.mjs
COPY --chown=node:node ops/container-start.mjs ops/container-healthcheck.mjs ./ops/
USER node
VOLUME ["/var/lib/homecare"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=3 CMD ["node", "ops/container-healthcheck.mjs"]
CMD ["node", "ops/container-start.mjs"]
