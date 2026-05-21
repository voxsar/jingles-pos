#!/usr/bin/env bash
# deploy.sh — Build, configure, and start Jingles POS on pos.theredsun.org
# Run as root or with sudo privileges.
set -euo pipefail

APP_DIR="/var/www/jingles-pos"
DOMAIN="pos.theredsun.org"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}.conf"
DATA_DIR="${APP_DIR}/data"

echo "=== Jingles POS Deployment ==="

# ── 1. Dependencies ──────────────────────────────────────────────────────────
echo "[1/7] Installing system packages..."
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx nodejs npm

# Install PM2 globally if not present
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

# ── 2. App dependencies & build ──────────────────────────────────────────────
echo "[2/7] Installing Node dependencies..."
cd "${APP_DIR}"
npm install --workspaces --if-present

echo "[3/7] Building backend and web..."
npm run build

# ── 3. Prisma client & database ──────────────────────────────────────────────
echo "[4/7] Preparing database..."
mkdir -p "${DATA_DIR}"

# Update DATABASE_URL in .env if the data dir is different from default
if [ ! -f "${APP_DIR}/packages/backend/.env" ]; then
  cat > "${APP_DIR}/packages/backend/.env" <<EOF
DATABASE_URL="file:${DATA_DIR}/jingles.db"
PORT=3001
NODE_ENV=production
EOF
fi

# Sync DATABASE_URL in ecosystem.config.js to match .env
DB_URL=$(grep DATABASE_URL "${APP_DIR}/packages/backend/.env" | cut -d'"' -f2)
sed -i "s|file:/var/www/jingles-pos/data/jingles.db|${DB_URL#file:}|g" \
  "${APP_DIR}/ecosystem.config.js" 2>/dev/null || true

# Run Prisma migrations against the existing database (safe, additive only)
cd "${APP_DIR}/packages/backend"
DATABASE_URL="${DB_URL}" npx prisma migrate deploy
DATABASE_URL="${DB_URL}" npx prisma generate

# ── 4. nginx ─────────────────────────────────────────────────────────────────
echo "[5/7] Configuring nginx..."
cp "${APP_DIR}/nginx/${DOMAIN}.conf" "${NGINX_CONF}"
ln -sf "${NGINX_CONF}" "/etc/nginx/sites-enabled/${DOMAIN}.conf"

# Temporarily serve HTTP only so certbot can issue the cert
# Replace SSL server block with a temporary HTTP block for the cert challenge
cat > "/etc/nginx/sites-available/${DOMAIN}-temp.conf" <<'NGINX'
server {
    listen 80;
    server_name pos.theredsun.org;
    root /var/www/jingles-pos/packages/web/dist;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}
NGINX
ln -sf "/etc/nginx/sites-available/${DOMAIN}-temp.conf" \
  "/etc/nginx/sites-enabled/${DOMAIN}-temp.conf"

# Disable the SSL config until cert exists
rm -f "/etc/nginx/sites-enabled/${DOMAIN}.conf"

nginx -t && systemctl reload nginx

# ── 5. Certbot ───────────────────────────────────────────────────────────────
echo "[6/7] Obtaining SSL certificate via certbot..."
certbot --nginx \
  --non-interactive \
  --agree-tos \
  --redirect \
  -d "${DOMAIN}" \
  -m "admin@theredsun.org"

# After certbot runs, install our full nginx config
rm -f "/etc/nginx/sites-enabled/${DOMAIN}-temp.conf"
rm -f "/etc/nginx/sites-available/${DOMAIN}-temp.conf"
ln -sf "${NGINX_CONF}" "/etc/nginx/sites-enabled/${DOMAIN}.conf"
nginx -t && systemctl reload nginx

# ── 6. PM2 ───────────────────────────────────────────────────────────────────
echo "[7/7] Starting backend with PM2..."
cd "${APP_DIR}"
pm2 delete jingles-pos-backend 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | bash   # enable PM2 on boot

echo ""
echo "✓ Deployment complete!"
echo "  Site:    https://${DOMAIN}"
echo "  API:     https://${DOMAIN}/api"
echo "  PM2:     pm2 status"
echo "  Logs:    pm2 logs jingles-pos-backend"
echo "  DB:      ${DB_URL}"
echo ""
echo "  To update the database path, edit:"
echo "    ${APP_DIR}/packages/backend/.env"
echo "    ${APP_DIR}/ecosystem.config.js"
echo "  Then run: pm2 restart jingles-pos-backend"
