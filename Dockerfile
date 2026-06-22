# ---- Stage 1: Build the Vite app ----
FROM node:20-alpine AS build

WORKDIR /app

# Install deps first so this layer is cached unless package.json changes
COPY package*.json ./
RUN npm ci

# Copy the rest of the source and build the production bundle
COPY . .
RUN npm run build

# ---- Stage 2: Serve the static build with nginx ----
FROM nginx:alpine

# Remove the default nginx welcome page
RUN rm -rf /usr/share/nginx/html/*

# Copy the built static files from the build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Custom nginx config so client-side routing (if you add any) doesn't 404 on refresh
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]