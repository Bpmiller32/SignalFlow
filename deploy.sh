#!/bin/bash
set -e

# --- Config ---
PI_USER="billy"
PI_HOST="192.168.0.65"
PI_DIR="/home/billy/SignalFlow"
SSH_TARGET="${PI_USER}@${PI_HOST}"

# SSH ControlMaster settings - one password prompt for the whole script
SOCKET="/tmp/signalflow-deploy-ssh"
SSH_OPTS="-o ControlMaster=auto -o ControlPath=${SOCKET} -o ControlPersist=60"

echo "=== SignalFlow Deploy ==="

# --- Step 1: Build ---
echo "[1/4] Building TypeScript..."
npm run build

# --- Step 2: Open shared SSH connection (you type password once here) ---
echo "[2/4] Connecting to Pi..."
ssh ${SSH_OPTS} -fN ${SSH_TARGET}

# --- Step 3: Sync files ---
echo "[3/4] Syncing files to Pi..."
ssh ${SSH_OPTS} ${SSH_TARGET} "mkdir -p ${PI_DIR}/dist ${PI_DIR}/data"
rsync -avz --delete \
  -e "ssh ${SSH_OPTS}" \
  dist/ \
  ${SSH_TARGET}:${PI_DIR}/dist/

rsync -avz \
  -e "ssh ${SSH_OPTS}" \
  package.json package-lock.json strategies.json .env \
  ${SSH_TARGET}:${PI_DIR}/

rsync -avz \
  -e "ssh ${SSH_OPTS}" \
  data/ \
  ${SSH_TARGET}:${PI_DIR}/data/

# --- Step 4: Install dependencies on Pi ---
echo "[4/4] Installing dependencies on Pi..."
ssh ${SSH_OPTS} ${SSH_TARGET} "cd ${PI_DIR} && npm install --omit=dev"

# Close the shared connection
ssh -O exit -o ControlPath=${SOCKET} ${SSH_TARGET} 2>/dev/null || true

echo ""
echo "=== Deploy complete! ==="
echo ""
echo "On the Pi, run:"
echo "  cd ~/SignalFlow && pm2 start dist/main.js --name SignalFlow"
echo ""
echo "If already running:"
echo "  pm2 restart SignalFlow"
