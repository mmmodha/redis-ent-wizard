export const VM_SA_ROLES = [
  "roles/browser",
  "roles/serviceusage.serviceUsageConsumer",
  "roles/compute.viewer",
  "roles/compute.networkAdmin",
  "roles/compute.instanceAdmin.v1",
  "roles/dns.admin",
] as const;

export const GKE_EXTRA_ROLES = ["roles/container.clusterAdmin"] as const;

export function saKeySetupScript(opts: {
  projectId: string;
  saId?: string;
  includeGke?: boolean;
}): string {
  const projectId = opts.projectId.trim() || "YOUR_PROJECT_ID";
  const saId = (opts.saId || "rew-wizard").trim() || "rew-wizard";
  const email = `${saId}@${projectId}.iam.gserviceaccount.com`;
  const keyFile = `${saId}.json`;
  const roles = opts.includeGke ? [...VM_SA_ROLES, ...GKE_EXTRA_ROLES] : [...VM_SA_ROLES];
  const apis = opts.includeGke
    ? "compute.googleapis.com dns.googleapis.com container.googleapis.com"
    : "compute.googleapis.com dns.googleapis.com";

  const roleLoop = roles.map((role) => `  "${role}"`).join("\n");

  const gkeActAs = opts.includeGke
    ? `
# Bind actAs on the default Compute Engine SA only (not project-wide).
PROJECT_NUMBER="$(gcloud projects describe "${projectId}" --format='value(projectNumber)')"
gcloud iam service-accounts add-iam-policy-binding \\
  "\${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \\
  --project="${projectId}" \\
  --member="serviceAccount:${email}" \\
  --role="roles/iam.serviceAccountUser"
`
    : "";

  return `# Run this in Cloud Shell or a laptop with gcloud (you must be a project admin).
# Then paste ${keyFile} into Credentials → Add your JSON, Save, Verify, and delete the file.

gcloud auth login
gcloud config set project ${projectId}

gcloud services enable ${apis}

gcloud iam service-accounts create ${saId} \\
  --display-name="Redis Enterprise wizard" \\
  --project="${projectId}"

for ROLE in \\
${roleLoop}
do
  gcloud projects add-iam-policy-binding "${projectId}" \\
    --member="serviceAccount:${email}" \\
    --role="\${ROLE}" \\
    --condition=None
done
${gkeActAs}
gcloud iam service-accounts keys create "./${keyFile}" \\
  --iam-account="${email}" \\
  --project="${projectId}"

echo "Paste this JSON into the wizard, then: rm ./${keyFile}"
cat "./${keyFile}"
`;
}
