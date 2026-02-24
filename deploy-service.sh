#!/bin/bash
set -e

echo "📦 Copying updated service file to server..."
scp yimaru-cd.service yimaru@yimaru_serv:/tmp/

echo "🔧 Installing and restarting service..."
ssh yimaru@yimaru_serv << 'REMOTE'
sudo mv /tmp/yimaru-cd.service /etc/systemd/system/yimaru-cd.service
sudo systemctl daemon-reload
sudo systemctl restart yimaru-cd
echo "✅ Service restarted"
sudo systemctl status yimaru-cd --no-pager -l
REMOTE

echo "✅ Deployment complete"
