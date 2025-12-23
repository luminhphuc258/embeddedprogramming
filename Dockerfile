FROM node:20-alpine

WORKDIR /app

# Install system deps: ffmpeg + yt-dlp
RUN apk add --no-cache \
  ffmpeg \
  yt-dlp \
  ca-certificates

COPY package*.json ./

# Railway khuyến nghị: npm ci + omit dev
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
