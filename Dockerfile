FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    QQBRIDGE_HOST=0.0.0.0 \
    QQBRIDGE_PORT=5700

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docs ./docs
COPY --chown=node:node README.md LICENSE ./

USER node

EXPOSE 5700

CMD ["npm", "start"]
