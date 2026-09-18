#!/usr/bin/env bash
# Swap LEADFLO_HTTP_PROXY on Azure App Service dental-asthetica.
#
# Usage:
#   ./scripts/set-leadflo-proxy.sh                 # uses defaults below
#   PROXY_HOST=1.2.3.4 PROXY_PORT=6969 \
#   PROXY_USER=user PROXY_PASS=pass ./scripts/set-leadflo-proxy.sh
#
# Or trigger GitHub Action: .github/workflows/set-leadflo-proxy.yml
# (push SET_LEADFLO_PROXY_NOW, or workflow_dispatch with inputs).
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rapidspec-rg}"
APP_NAME="${APP_NAME:-dental-asthetica}"
PROXY_HOST="${PROXY_HOST:-195.40.128.249}"
PROXY_PORT="${PROXY_PORT:-6969}"
PROXY_USER="${PROXY_USER:-rktwwipc}"
PROXY_PASS="${PROXY_PASS:-baq3spf64bhx}"

PROXY_URL=$(python3 - <<PY
from urllib.parse import quote
print(
    f"http://{quote('${PROXY_USER}', safe='')}:{quote('${PROXY_PASS}', safe='')}@"
    f"${PROXY_HOST}:${PROXY_PORT}"
)
PY
)

echo "Setting LEADFLO_HTTP_PROXY → http://${PROXY_HOST}:${PROXY_PORT}/… (user=${PROXY_USER})"
az webapp config appsettings set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --settings "LEADFLO_HTTP_PROXY=${PROXY_URL}" \
  --output none

az webapp restart --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --output none
echo "Restarted ${APP_NAME}. Check: curl -sS https://dental-asthetica.wasup.co/api/status | jq .leadflo"
