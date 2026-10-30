# API + staff panel in one image. The panel is built in the first stage and served by Caddy;
# the API runs TypeScript directly (Node 22 type stripping), production dependencies only.

FROM node:22.11.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/admin apps/admin
RUN npm run build --workspace apps/admin

FROM node:22.11.0-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /srv
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --no-audit --no-fund --workspace apps/api --workspace packages/shared && npm cache clean --force
COPY packages/shared packages/shared
COPY apps/api/src apps/api/src
COPY db db
COPY --from=build /src/apps/admin/dist /srv/admin
# Never run as root; uploaded document photos live on a volume owned by this user.
RUN mkdir -p /data/files /srv/admin-out && chown -R node:node /data /srv/admin-out
USER node
WORKDIR /srv/apps/api
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
