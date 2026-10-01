# Lets this service join the Tailscale network directly (userspace mode — no
# NET_ADMIN/TUN device needed, which Render's container runtime doesn't grant)
# so it can reach the Mac Mini's IPFS API at its real tailnet IP, instead of
# through a public ngrok tunnel. See docker-entrypoint.sh for how it connects.
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL https://tailscale.com/install.sh | sh \
  && apt-get purge -y curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
