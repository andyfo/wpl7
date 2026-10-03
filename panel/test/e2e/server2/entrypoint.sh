#!/bin/sh
# Install the panel's public key (mounted at /panel-key.pub), start sshd, then dockerd.
set -e
if [ -f /panel-key.pub ]; then
  cp /panel-key.pub /home/wpl7-panel/.ssh/authorized_keys
  chmod 600 /home/wpl7-panel/.ssh/authorized_keys
  chown wpl7-panel:wpl7-panel /home/wpl7-panel/.ssh/authorized_keys
fi
/usr/sbin/sshd
# Make the docker socket group-accessible for wpl7-panel.
exec dockerd-entrypoint.sh --group docker
