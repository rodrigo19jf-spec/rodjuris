FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NODE_NO_WARNINGS=1
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV DB_FILE=/app/dados/jurify.db PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
