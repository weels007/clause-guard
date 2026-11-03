# The console lives in frontend/ and is built with Vite, then served as static
# files by nginx on the port Cloud Run hands over in $PORT.

FROM node:22-slim AS build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
# chain.js imports the contract source with ?raw, so the build needs it too.
COPY contracts/ClauseGuard.py /app/contracts/ClauseGuard.py
RUN npm run build

FROM nginx:1.27-alpine
ENV PORT=8080
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
