FROM hashicorp/terraform:1.9.5 AS terraform

FROM node:22-bookworm

COPY --from=terraform /bin/terraform /usr/local/bin/terraform

# Pinned CLI versions — override with --build-arg for upgrades.
ARG HELM_VERSION=v3.16.4
ARG KUBECTL_VERSION=v1.31.4

# Google Cloud CLI (+ GKE auth plugin), Helm and kubectl. Uses the current apt
# keyring convention (/etc/apt/keyrings + signed-by) and pinned, arch-aware
# release downloads from the official hosts so builds are reproducible and work
# on both amd64 and arm64.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg python3; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/cloud.google.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" | tar -xz -C /tmp; \
    install -m 0755 "/tmp/linux-${arch}/helm" /usr/local/bin/helm; \
    rm -rf "/tmp/linux-${arch}"; \
    curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    chmod 0755 /usr/local/bin/kubectl; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app/apps/api
COPY apps/api/package.json ./
RUN npm install
COPY apps/api ./
RUN npm run build

COPY terraform /app/terraform

ENV DATA_DIR=/data
ENV TERRAFORM_DIR=/app/terraform
ENV PORT=4000
ENV HOST=0.0.0.0

EXPOSE 4000
CMD ["npm", "run", "start"]
