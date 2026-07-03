FROM node:20-alpine

WORKDIR /app

# better-sqlite3 needs build tools to compile its native binding
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 4000

CMD ["npm", "start"]