FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Conversion binaries live in the cloud image, never on the developer's PC.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg libreoffice-writer poppler-utils fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* values are intentionally build arguments because Next.js embeds
# them into client bundles at build time. They are public project values only.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}

RUN npm run build \
  && chown -R node:node /app

USER node
EXPOSE 3000

# Configure this service's start command in the cloud dashboard:
# Web: npm run start
# Worker: npm run worker
CMD ["npm", "run", "start"]
