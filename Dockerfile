FROM node:22-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=4318 DATA_DIR=/data
USER node
EXPOSE 4318
CMD ["node", "server.mjs"]
