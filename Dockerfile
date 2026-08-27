FROM node:24-alpine3.22

ENV NODE_ENV=production \
    PORT=8088 \
    PUBLIC_DIR=/app/public \
    DATA_DIR=/app/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.js ./
COPY --chown=node:node billiards.html ./public/billiards.html
RUN mkdir -p /app/public/assets /app/data && chown -R node:node /app/data

USER node
EXPOSE 8188
VOLUME ["/app/public", "/app/data"]
CMD ["node", "server.js"]
