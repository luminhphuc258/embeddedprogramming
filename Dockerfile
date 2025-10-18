# ===== Base image =====
FROM node:20-alpine

# ===== Set working directory =====
WORKDIR /app

# ===== Copy package files and install dependencies =====
COPY package*.json ./
RUN npm install --production

# ===== Copy source code =====
COPY . .

# ===== Expose port =====
EXPOSE 3000

# ===== Start the app =====
CMD ["node", "server.js"]
