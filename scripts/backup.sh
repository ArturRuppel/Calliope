#!/usr/bin/env bash
# Mirror the Calliope data directory (decks, slides, media, commits, revisions, fonts, uploads,
# trash) to a backup directory with rsync. Never deletes at the destination. Run by
# calliope-backup.timer, or by hand.
#
#   CALLIOPE_BACKUP_DIR    destination directory (required), e.g. on a mounted network share
#   CALLIOPE_BACKUP_PROBE  directory that must exist for the share to count as reachable
#                          (default: the destination's parent); when it is missing, for
#                          example because the share is unreachable, the run skips quietly
#   SVGDECK_DATA           source data directory (default: ~/Data/svgdeck)
set -euo pipefail
SRC="${SVGDECK_DATA:-$HOME/Data/svgdeck}"
if [ -z "${CALLIOPE_BACKUP_DIR:-}" ]; then
    echo "CALLIOPE_BACKUP_DIR is not set: set it to the backup destination" \
        "(for the timer, in a drop-in under ~/.config/systemd/user/calliope-backup.service.d/)" >&2
    exit 1
fi
DEST="$CALLIOPE_BACKUP_DIR"
PROBE="${CALLIOPE_BACKUP_PROBE:-$(dirname "$DEST")}"
if ! timeout 20 test -d "$PROBE"; then echo "backup share not reachable, skipping"; exit 0; fi
mkdir -p "$DEST"
# CIFS: copy contents and times only (-rlt), no permissions or ownership.
rsync -rlt --omit-dir-times --partial --exclude '*.lock' --exclude '.DS_Store' "$SRC/" "$DEST/"
echo "backup up to date: $DEST ($(du -sh "$DEST" | cut -f1))"
