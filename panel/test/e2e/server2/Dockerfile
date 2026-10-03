# Stand-in "worker server" for e2e: dockerd (dind) + sshd + the wpl7-panel user,
# wired exactly like provision/setup.sh does it (docker group + NOPASSWD sudo).
FROM docker:27-dind

RUN apk upgrade --no-cache \
  # curl/openssl: the FTP e2e's clients run on the worker, so FTPS crosses
  # Docker's NAT the way it does on a real server (test/e2e/ftp.sh).
  && apk add --no-cache openssh-server openssh-keygen bash sudo shadow coreutils tar gzip curl openssl \
  && ssh-keygen -A \
  # Root shell for the web-terminal path: unlock the account ('*', like wpl7-panel
  # below - sshd refuses pubkey auth for locked accounts) and pin the Ubuntu
  # default so key-only root login stays allowed if the base image changes it.
  && usermod -p '*' root \
  && echo 'PermitRootLogin prohibit-password' >> /etc/ssh/sshd_config \
  && useradd -m -s /bin/bash wpl7-panel \
  && usermod -p '*' wpl7-panel \
  && (getent group docker || addgroup docker) \
  && usermod -aG docker wpl7-panel \
  && echo 'wpl7-panel ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/91-wpl7-panel \
  && chmod 440 /etc/sudoers.d/91-wpl7-panel \
  && mkdir -p /home/wpl7-panel/.ssh /srv \
  && chmod 700 /home/wpl7-panel/.ssh \
  && chown -R wpl7-panel:wpl7-panel /home/wpl7-panel/.ssh

COPY entrypoint.sh /usr/local/bin/e2e-entrypoint.sh
RUN chmod +x /usr/local/bin/e2e-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/e2e-entrypoint.sh"]
