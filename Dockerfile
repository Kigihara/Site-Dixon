FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY server.js start.bat ./
COPY public ./public
RUN mkdir -p data
ENV PORT=8099 HOST=0.0.0.0 DATA_DIR=/app/data
EXPOSE 8099
CMD ["node", "server.js"]
