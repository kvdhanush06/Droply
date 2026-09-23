# Droply — multi-stage production image.
# Stage 1 builds the frontend bundle, stage 2 compiles the backend,
# stage 3 is the minimal runtime: backend + static frontend, non-root.

FROM node:24-alpine AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
RUN npm ci --workspace frontend --include-workspace-root=false --no-audit --no-fund
COPY frontend/ ./frontend/
RUN npm run build -w frontend

FROM node:24-alpine AS backend-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
# Full install (dev deps included) so the TypeScript compiler is available.
RUN npm ci --workspace backend --include-workspace-root=false --no-audit --no-fund
COPY backend/ ./backend/
RUN npm run build -w backend

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S droply && adduser -S droply -G droply

COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=backend-build /app/backend/package.json ./backend/package.json
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Production dependencies only.
RUN cd backend && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

USER droply
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0 STATIC_DIR=/app/frontend/dist

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/server.js"]
