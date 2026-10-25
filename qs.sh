#!/usr/bin/env bash
# QuantSignal control script.  Usage: ./qs.sh start|stop|restart|status|logs|url|tunnel-off
# Run start/restart from a shell where HL_TESTNET_PRIVATE_KEY is exported (it is passed through, never stored).
set -e
cd "$(dirname "$0")"
PM2=$(command -v pm2 || echo ~/.local/bin/pm2)
case "$1" in
  start)   $PM2 start ecosystem.config.js --only quantsignal ;;
  tunnel)  $PM2 start ecosystem.config.js --only quantsignal-tunnel ;;
  stop)    $PM2 stop quantsignal quantsignal-tunnel ;;
  restart) $PM2 restart ecosystem.config.js --only quantsignal --update-env ;;   # picks up .env edits + current shell env
  status)  $PM2 ls; curl -s "http://127.0.0.1:$(node -e "console.log(require('./config.json').port)")/health"; echo ;;
  logs)    tail -n ${2:-80} logs/engine.out.log ;;
  url)     cat logs/public_url.txt 2>/dev/null || echo "no tunnel url yet" ;;
  tunnel-off) $PM2 stop quantsignal-tunnel ;;
  delete)  $PM2 delete quantsignal quantsignal-tunnel ;;
  *) echo "usage: $0 start|tunnel|stop|restart|status|logs [n]|url|tunnel-off|delete"; exit 1 ;;
esac
