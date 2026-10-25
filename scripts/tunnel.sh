#!/usr/bin/env bash
# Cloudflare quick tunnel -> local server. Writes the public URL to logs/public_url.txt
cd "$(dirname "$0")/.."
PORT=$(node -e "console.log(require('./config.json').port||8787)")
exec ~/.local/bin/cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:${PORT}" 2>&1 | while IFS= read -r line; do
  echo "$line"
  url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' <<<"$line" | head -1)
  [ -n "$url" ] && echo "$url" > logs/public_url.txt
done
