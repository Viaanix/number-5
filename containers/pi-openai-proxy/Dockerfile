# Pin the runtime as well as the model adapter: rebuilds must not change either silently.
FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73 AS dependencies
WORKDIR /app
COPY package.json bun.lock patch-usage.ts ./
RUN bun install --frozen-lockfile --production --ignore-scripts \
    && bun patch-usage.ts

FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73
ENV HOME=/home/bun \
    PI_CODING_AGENT_DIR=/home/bun/.pi/agent \
    PI_PROXY_HOST=0.0.0.0 \
    PI_PROXY_PORT=4141
WORKDIR /app
COPY --from=dependencies /app/package.json /app/bun.lock ./
COPY --from=dependencies /app/node_modules ./node_modules
# Docker initializes a new named volume from this directory, including its ownership.
RUN mkdir -p /home/bun/.pi/agent && chown -R bun:bun /home/bun/.pi
USER bun
EXPOSE 4141
# The proxy serves whatever Claude login is in the volume and, left alone, starts with no
# authentication at all (checked: HTTP 200 on /v1/models with no token). Compose already requires
# a token, but the image is shared, so it enforces this itself instead of trusting every caller.
ENTRYPOINT ["sh", "-c", "[ -n \"$PI_PROXY_AUTH_TOKEN\" ] || { echo 'PI_PROXY_AUTH_TOKEN is required: this proxy serves your Claude login and must not run without a bearer token.' >&2; exit 64; }; exec bun /app/node_modules/@victor-software-house/pi-openai-proxy/dist/index.mjs \"$@\"", "proxy"]
