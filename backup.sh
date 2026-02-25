#!/usr/bin/env bash
set -euo pipefail
TS="$(date +%Y%m%d_%H%M%S)"
DEST="/opt/backups/orchestrator_${TS}.tar.gz"
tar -czf "$DEST" -C /opt orchestrator
find /opt/backups -type f -name "orchestrator_*.tar.gz" -mtime +14 -delete
echo "Backup OK: $DEST"
