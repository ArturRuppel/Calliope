#!/usr/bin/env bash
# Mirror the Calliope data directory (decks, slides, media, commits, revisions, fonts, uploads,
# trash) to Pomice2 with rsync. Never deletes on the share. Skips quietly when the share is not
# reachable (Pasteur VPN down). Run by calliope-backup.timer, or by hand.
# The destination below is an example default (the author's lab share); set CALLIOPE_BACKUP_DIR
# to your own.
set -euo pipefail
SRC="${SVGDECK_DATA:-$HOME/Data/svgdeck}"
DEST="${CALLIOPE_BACKUP_DIR:-/helix/projects/Pomice2/Artur/backups/calliope/svgdeck}"
if ! timeout 20 test -d "$(dirname "$(dirname "$(dirname "$DEST")")")"; then echo "backup share not reachable, skipping"; exit 0; fi
mkdir -p "$DEST"
# CIFS: copy contents and times only (-rlt), no permissions or ownership.
rsync -rlt --omit-dir-times --partial --exclude '*.lock' --exclude '.DS_Store' "$SRC/" "$DEST/"
echo "backup up to date: $DEST ($(du -sh "$DEST" | cut -f1))"
