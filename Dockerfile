FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache ffmpeg yt-dlp ca-certificates

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
