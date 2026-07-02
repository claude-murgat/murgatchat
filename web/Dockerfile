FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL

COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Unprivileged nginx: runs as a non-root user and listens on 8080 (see nginx.conf).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Explicit non-root USER (satisfies the static "missing USER" check; the base
# image already drops privileges to this user).
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
