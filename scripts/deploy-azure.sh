#!/usr/bin/env bash
# Deploy Leadflo Tracker to Azure App Service (zip deploy).
# Requires: az login, Node 22+.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-leadflo-tracker}"
LOCATION="${LOCATION:-eastus2}"
APP_SERVICE_PLAN="${APP_SERVICE_PLAN:-asp-leadflo-tracker}"
APP_NAME="${APP_NAME:-leadflo-tracker-arslan}"
SKU="${SKU:-B1}"
RUNTIME="${RUNTIME:-NODE:22-lts}"

echo "Typecheck + test…"
npm run typecheck
npm test

echo "Ensuring Azure resources…"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
az appservice plan create \
  --name "$APP_SERVICE_PLAN" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --is-linux \
  --sku "$SKU" \
  --output none || true

az webapp create \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --plan "$APP_SERVICE_PLAN" \
  --runtime "$RUNTIME" \
  --output none || true

az webapp config set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --startup-file "npm start" \
  --always-on true \
  --output none

# App settings (pass secrets via env when invoking this script)
SETTINGS=(
  SCM_DO_BUILD_DURING_DEPLOYMENT=true
  ENABLE_ORYX_BUILD=true
  PORT=8080
  HOST=0.0.0.0
  LEADFLO_MODE="${LEADFLO_MODE:-live}"
  LEADFLO_EMAIL="${LEADFLO_EMAIL:-}"
  LEADFLO_PASSWORD="${LEADFLO_PASSWORD:-}"
  LEADFLO_HTTP_PROXY="${LEADFLO_HTTP_PROXY:-}"
  TRACKED_TREATMENT_TYPES="${TRACKED_TREATMENT_TYPES:-Implant}"
  POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-60000}"
  NOTES_ONLY_TEST_NAMES="${NOTES_ONLY_TEST_NAMES:-true}"
  WEBHOOK_URL="${WEBHOOK_URL:-}"
  WEBHOOK_SECRET="${WEBHOOK_SECRET:-}"
  INBOUND_WEBHOOK_SECRET="${INBOUND_WEBHOOK_SECRET:-}"
  DATABASE_PATH=/home/site/data/leadflo.db
  PUBLIC_BASE_URL="https://${APP_NAME}.azurewebsites.net"
)

az webapp config appsettings set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --settings "${SETTINGS[@]}" \
  --output none

echo "Packaging…"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
rsync -a \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  --exclude '*.db' \
  --exclude .env \
  ./ "$STAGE/"
(
  cd "$STAGE"
  zip -qr /tmp/leadflo-deploy.zip .
)

echo "Zip deploying…"
az webapp deployment source config-zip \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --src /tmp/leadflo-deploy.zip

az webapp restart --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --output none

printf '\nDeployed dashboard: https://%s.azurewebsites.net\n' "$APP_NAME"
printf 'API docs:            https://%s.azurewebsites.net/docs.html\n' "$APP_NAME"
