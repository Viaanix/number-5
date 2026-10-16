# Pin the runtime, the proxy build and Pi: rebuilds must not change any of them silently. The
# proxy is a release asset of the fork (see package.json) and package-lock.json records its hash.
# It runs on Node (the fork dropped Bun), and Pi's own packages are pinned in package.json.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: nothing here needs a build step, and a dependency must not run code at build.
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ENV HOME=/home/node \
    PI_CODING_AGENT_DIR=/home/node/.pi/agent \
    PI_PROXY_HOST=0.0.0.0 \
    PI_PROXY_PORT=4141 \
    NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/package.json /app/package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
# Docker initializes a new named volume from this directory, including its ownership. The node
# user is UID 1000, the same as the bun user of the earlier images, so a login volume made by one
# is readable and writable by the other.
RUN mkdir -p /home/node/.pi/agent && chown -R node:node /home/node/.pi
USER node
EXPOSE 4141
# The proxy serves whatever Claude login is in the volume and, left alone, starts with no
# authentication at all (checked: HTTP 200 on /v1/models with no token). Compose already requires
# a token, but the image is shared, so it enforces this itself instead of trusting every caller.
ENTRYPOINT ["sh", "-c", "[ -n \"$PI_PROXY_AUTH_TOKEN\" ] || { echo 'PI_PROXY_AUTH_TOKEN is required: this proxy serves your Claude login and must not run without a bearer token.' >&2; exit 64; }; exec node /app/node_modules/@vx-daniel/pi-openai-proxy/dist/index.mjs \"$@\"", "proxy"]
