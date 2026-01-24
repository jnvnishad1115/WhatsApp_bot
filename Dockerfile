FROM node:20-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# Use npm install instead of npm ci
RUN npm install --production

COPY . .

# Create session directory
RUN mkdir -p /app/session

EXPOSE 3000

CMD ["npm", "start"]
