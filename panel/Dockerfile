# Build from the REPO ROOT so the image can carry deploy/wordpress-image
# (the panel builds wpl7-wordpress:* site images from it via the Docker API):
#   docker build -f panel/Dockerfile -t wpl7-panel .
# docker-compose.yml does this automatically (build.context: ..).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Toolchain for native modules (better-sqlite3/argon2) when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY panel/package.json panel/package-lock.json ./
RUN npm ci

FROM deps AS build
COPY panel/tsconfig.json panel/tsconfig.server.json ./
COPY panel/shared ./shared
COPY panel/src ./src
COPY panel/web ./web
RUN npm run build

FROM node:22-bookworm-slim AS proddeps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY panel/package.json panel/package-lock.json ./
RUN npm ci --omit=dev

# Runtime. Runs as root on purpose: it drives /var/run/docker.sock (root-equivalent
# anyway) and chowns site files to uid 33. tar/gzip/du ship with bookworm-slim.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY panel/package.json ./
# Bundled catalog (plugin recipes) - data, read at boot; see panel/catalog/README.md.
COPY panel/catalog /app/catalog
# The migration plugin an import hands out, zipped per import with its connection file.
COPY panel/migrate-plugin/wpl7-migrate /app/migrate-plugin/wpl7-migrate
# The plugin a site hosted elsewhere connects with, zipped per connection with its connection file.
COPY panel/connect-plugin/wpl7-connect /app/connect-plugin/wpl7-connect
COPY deploy/wordpress-image /app/wordpress-image
# The FTP image's recipe, for servers that build it rather than pull it (services/ftp.ts).
COPY deploy/sftpgo-image /app/sftpgo-image
# Provisioning bundle: the panel pushes this to blank VPSes and runs setup.sh over SSH
# ("Add server" with provisioning). Baked from the same revision as the panel itself,
# so worker stacks always match the panel's version.
COPY provision /app/bundle/provision
COPY deploy/docker-compose.yml deploy/docker-compose.worker.yml deploy/.env.example /app/bundle/deploy/
COPY deploy/wordpress-image /app/bundle/deploy/wordpress-image
# What this build is. Last, so changing it rebuilds one layer rather than the whole image.
# .dockerignore drops .git, so the panel cannot work out its own revision at runtime - the
# stamp has to arrive from whoever built it (release.yml, deploy.yml, provision/build.sh),
# and it is then the single record of what a box is running.
ARG VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV WPL7_VERSION=${VERSION}
ENV WPL7_GIT_SHA=${GIT_SHA}
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
