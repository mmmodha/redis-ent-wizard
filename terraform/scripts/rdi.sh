#!/bin/bash
# Startup script for the dedicated Redis Data Integration (RDI) VM.
# Templated by terraform/modules/rdi-vm via templatefile(): ${rdi_version},
# ${connections_env}, ${pipeline_config} are substituted at plan time.
set -eux

RDI_VERSION="${rdi_version}"

## injected connection environment (Redis target/state + Cloud SQL source creds)
install -d -o ubuntu -g ubuntu -m 750 /opt/rew
cat >/opt/rew/connections.env <<'REWENV'
${connections_env}
REWENV
chown ubuntu:ubuntu /opt/rew/connections.env
chmod 600 /opt/rew/connections.env
cat >/etc/profile.d/rew-connections.sh <<'REWPROF'
[ -f /opt/rew/connections.env ] && . /opt/rew/connections.env
REWPROF
chmod 644 /etc/profile.d/rew-connections.sh

## the rendered starter pipeline config (config.yaml + jobs), base64 in metadata
install -d -o ubuntu -g ubuntu -m 750 /opt/rdi
if [ -n "${pipeline_config}" ]; then
  printf '%s' "${pipeline_config}" | base64 -d >/opt/rdi/config.yaml || true
  chown ubuntu:ubuntu /opt/rdi/config.yaml
fi

## commons
export DEBIAN_FRONTEND=noninteractive
apt-get -y update
apt-get -y install curl ca-certificates dnsutils netcat

## RDI runtime install.
# NOTE: confirm the exact installer/commands against the current RDI release
# before relying on this in a real apply (see the plan's flagged items). The RDI
# installer is fetched and run here, then `redis-di deploy` applies the pipeline
# using the sourced connections.env once a source and target are wired.
# shellcheck disable=SC1091
. /opt/rew/connections.env || true
if [ -n "$RDI_VERSION" ]; then
  echo "RDI ${rdi_version} requested; run the RDI installer here." >/opt/rdi/INSTALL_TODO
else
  echo "RDI installer version not pinned; using installer default." >/opt/rdi/INSTALL_TODO
fi
