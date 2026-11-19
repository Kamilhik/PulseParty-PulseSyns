FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.services.json ./
RUN npm ci --ignore-scripts
COPY server ./server
COPY shared ./shared
COPY companion ./companion
RUN npm run build:services
FROM node:24.14.0-bookworm-slim
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist/services ./dist/services
COPY web ./web
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/services/server/main.js"]
