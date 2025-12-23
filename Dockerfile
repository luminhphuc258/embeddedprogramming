FROM node:20-alpine

WORKDIR /app

# 1) Cài system deps: git (để npm install không bị spawn git ENOENT),
#    ffmpeg (yt-dlp extract mp3 cần), python/pip (để cài yt-dlp)
RUN apk add --no-cache \
  git \
  ffmpeg \
  python3 \
  py3-pip \
  ca-certificates \
  && pip3 install --no-cache-dir -U yt-dlp

# 2) Install node deps
COPY package*.json ./
# npm mới khuyên dùng --omit=dev thay vì --production
RUN npm ci --omit=dev

# 3) Copy code
COPY . .

# 4) Port: phải khớp với server bạn đang dùng (thường 8080)
EXPOSE 8080

CMD ["node", "server.js"]
