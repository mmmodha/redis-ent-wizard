FROM hashicorp/terraform:1.9.5 AS terraform

FROM node:22-bookworm

COPY --from=terraform /bin/terraform /usr/local/bin/terraform

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg apt-transport-https python3 \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli google-cloud-sdk-gke-gcloud-auth-plugin \
    && curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash \
    && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x /usr/local/bin/kubectl \
    && rm -rf /var/lib/apt/lists/*

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
