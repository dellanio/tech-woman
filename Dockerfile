FROM node:24-bookworm-slim AS tools-deps
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /tools
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# tsx é runtime do migrador/importador/mailer; kit, TypeScript e Playwright não são.
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN NEXT_TELEMETRY_DISABLED=1 pnpm build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Ferramentas offline e worker usam /tools, nunca a credencial migradora no web.
# O worker real entra em scripts/ no WP-002, sem alteração deste padrão de cópia.
COPY --from=tools-deps /tools/node_modules /tools/node_modules
COPY --from=build /app/package.json /tools/package.json
COPY --from=build /app/scripts /tools/scripts
COPY --from=build /app/src/lib /tools/src/lib
COPY --from=build /app/drizzle /tools/drizzle
EXPOSE 3000
CMD ["node","server.js"]
