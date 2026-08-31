/**
 * Fetch the keystore passphrase from AWS Secrets Manager, using the instance's
 * own role — so the passphrase is never on the disk at all.
 *
 * This is the last turn of the screw: the key file is encrypted, but until now
 * the passphrase that opens it sat in snipe.env on the same disk, so a stolen
 * snapshot or backup carried both. Pull the passphrase from Secrets Manager at
 * startup instead and the disk holds nothing that can decrypt the keys — an
 * attacker needs code execution on the live instance, with its role, which is
 * a far higher bar than copying a volume.
 *
 * No SDK: credentials come from the instance metadata service (IMDSv2), the
 * request is signed by hand (awsSigv4.ts), and that is the whole of it. It
 * only ever runs on the EC2 box, so the IMDS path cannot be exercised off it;
 * every failure is therefore made loud and specific, because the first place
 * it can possibly be seen working is the real instance.
 */
import { signRequest } from "./awsSigv4";

const IMDS = "http://169.254.169.254";

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** A short timeout everywhere: IMDS is on the local link and answers in ms, so
 *  a hang means it is not there (not an EC2 box, or IMDS disabled) — better to
 *  fail fast and say so than to stall a boot. */
const TIMEOUT_MS = 3000;

async function fetchText(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** The IMDSv2 session token — required; IMDSv1 is refused on hardened boxes. */
async function imdsToken(): Promise<string> {
  const r = await fetchText(`${IMDS}/latest/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "60" },
  }).catch((e) => {
    throw new Error(`IMDS unreachable (${e instanceof Error ? e.message : e}) — not an EC2 box, or metadata is off`);
  });
  if (r.status !== 200) throw new Error(`IMDS token request returned ${r.status}`);
  return r.body.trim();
}

/** The instance role's temporary credentials, via IMDSv2. */
async function instanceCreds(token: string): Promise<Creds> {
  const h = { "x-aws-ec2-metadata-token": token };
  const base = `${IMDS}/latest/meta-data/iam/security-credentials/`;
  const list = await fetchText(base, { headers: h });
  if (list.status !== 200 || !list.body.trim()) {
    throw new Error(`no IAM role on this instance (IMDS returned ${list.status}) — attach a role that can read the secret`);
  }
  const role = list.body.trim().split("\n")[0];
  const creds = await fetchText(base + encodeURIComponent(role), { headers: h });
  if (creds.status !== 200) throw new Error(`could not read role credentials (${creds.status})`);
  const parsed = JSON.parse(creds.body) as {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    Token?: string;
  };
  if (!parsed.AccessKeyId || !parsed.SecretAccessKey || !parsed.Token) {
    throw new Error("role credentials from IMDS were incomplete");
  }
  return {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    sessionToken: parsed.Token,
  };
}

/** The instance's region, from IMDS, so the caller need not hardcode it. */
async function instanceRegion(token: string): Promise<string | null> {
  const r = await fetchText(`${IMDS}/latest/meta-data/placement/region`, {
    headers: { "x-aws-ec2-metadata-token": token },
  }).catch(() => ({ status: 0, body: "" }));
  return r.status === 200 && r.body.trim() ? r.body.trim() : null;
}

/**
 * Read one secret string from Secrets Manager.
 *
 * @param secretId  the secret's name or ARN
 * @param region    optional; discovered from IMDS when omitted
 */
export async function fetchSecret(secretId: string, region?: string): Promise<string> {
  const token = await imdsToken();
  const creds = await instanceCreds(token);
  const rgn = region ?? (await instanceRegion(token));
  if (!rgn) throw new Error("could not determine the AWS region — set SNIPE_AWS_REGION");

  const host = `secretsmanager.${rgn}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: secretId });
  const headers = signRequest({
    method: "POST",
    host,
    path: "/",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "secretsmanager.GetSecretValue",
    },
    body,
    service: "secretsmanager",
    region: rgn,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });

  const res = await fetchText(`https://${host}/`, { method: "POST", headers, body });
  if (res.status !== 200) {
    // The body carries the reason (AccessDenied, ResourceNotFound). It names no
    // secret value, only the error, so it is safe to surface.
    throw new Error(`Secrets Manager returned ${res.status}: ${res.body.slice(0, 300)}`);
  }
  const parsed = JSON.parse(res.body) as { SecretString?: string };
  if (typeof parsed.SecretString !== "string" || parsed.SecretString === "") {
    throw new Error("the secret has no string value (a binary secret cannot be a passphrase)");
  }
  return parsed.SecretString;
}
