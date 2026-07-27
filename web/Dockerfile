FROM node:24-alpine AS build
WORKDIR /app
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL

# Contexte de build = RACINE du repo (voir docker-compose : context: .), pour
# embarquer le mini-package de contrats `shared/` en plus de `web/`.
# On installe d'abord les deps du web (couche cache), puis on copie les sources.
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
# `shared/` à /shared : web/src importe ../../shared -> depuis /app/src ça résout
# /shared. Pas besoin de shared/node_modules ici : Vite bundle contracts.js et
# résout `zod` depuis les node_modules du web.
COPY shared/ /shared/
RUN npm run build

# Unprivileged nginx: runs as a non-root user and listens on 8080 (see nginx.conf).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
# Explicit non-root USER (satisfies the static "missing USER" check; the base
# image already drops privileges to this user).
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
