#!/bin/sh
# Starts as root only to let the agent's group reach Fly's Machines API socket,
# through which the agent suspends its own machine when idle (lifecycle/
# idle-sleeper.ts). The socket is root:root 755 by default. Then it drops to the
# unprivileged `node` user for good.
set -e
if [ -S /.fly/api ]; then
  chgrp node /.fly/api && chmod 770 /.fly/api
fi
# A volume mounts owned by root: the folder their uploads go in (UPLOAD_DIR) is made and handed to the agent's user.
if [ -n "$UPLOAD_DIR" ]; then
  mkdir -p "$UPLOAD_DIR"
  chown node:node "$UPLOAD_DIR"
fi
exec setpriv --reuid=node --regid=node --init-groups "$@"
