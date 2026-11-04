#!/bin/bash
while true; do
  echo "[$(date)] Starting SSH reverse tunnel to localhost.run..."
  ssh -o StrictHostKeyChecking=no \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -R 80:127.0.0.1:3000 nokey@localhost.run 2>&1 | while IFS= read -r line; do
        echo "$line"
        if [[ "$line" =~ ([a-z0-9]+\.lhr\.life) ]]; then
          echo "https://${BASH_REMATCH[1]}" > /Users/tutul/Downloads/confi/tunnel_url.txt
          echo "[$(date)] Active tunnel: https://${BASH_REMATCH[1]}"
        fi
      done
  echo "[$(date)] Tunnel exited, restarting in 3 seconds..."
  sleep 3
done
