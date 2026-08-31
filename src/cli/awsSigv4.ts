/**
 * AWS Signature Version 4, by hand, on node:crypto.
 *
 * This is here so the box can fetch the keystore passphrase from AWS Secrets
 * Manager without pulling in the AWS SDK — which is large, and this repo has a
 * standing preference for no heavy or native dependencies (the same reason it
 * uses node:sqlite rather than better-sqlite3). SigV4 is a fixed, well-
 * documented HMAC chain; the whole of it is below, and it is checked against
 * AWS's own published test vector so a subtle mistake shows up in a unit test
 * rather than as an auth failure on a live instance.
 *
 * Only what a single Secrets Manager call needs: one request, headers signed,
 * optional session token for instance-role credentials.
 */
import { createHash, createHmac } from "node:crypto";

export interface SigV4Input {
  method: string;
  host: string;
  /** Path, already URI-encoded. "/" for a service root. */
  path: string;
  /** Canonical query string, already encoded and sorted, or "". */
  query?: string;
  /** Header name → value. host and x-amz-date are added here. */
  headers: Record<string, string>;
  /** Raw request body, hashed into the signature. */
  body: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary (instance-role) credentials. */
  sessionToken?: string;
  /** For tests: pin the request time. Defaults to now. */
  date?: Date;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** yyyymmdd and the full ISO basic timestamp AWS wants. */
function stamps(date: Date): { date: string; dateTime: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { date: iso.slice(0, 8), dateTime: iso };
}

/**
 * Sign a request, returning the headers to send (the originals plus Host,
 * X-Amz-Date, the token if any, and Authorization).
 */
export function signRequest(input: SigV4Input): Record<string, string> {
  const { date: dateTimeSource = new Date() } = input;
  const { date, dateTime } = stamps(dateTimeSource);

  // The headers that go into the signature. Host and the timestamp are always
  // signed; the session token, when present, must be too.
  const signed: Record<string, string> = {
    ...input.headers,
    host: input.host,
    "x-amz-date": dateTime,
  };
  if (input.sessionToken) signed["x-amz-security-token"] = input.sessionToken;

  // Canonical headers: lower-case names, trimmed values, sorted, each on its
  // own line, then the semicolon-joined list of names.
  const names = Object.keys(signed)
    .map((n) => n.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(signed)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const payloadHash = sha256(input.body);
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  // The signing key: the secret walked through date, region, service, and the
  // terminator, each HMAC keyed by the last.
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: Record<string, string> = {
    ...input.headers,
    Host: input.host,
    "X-Amz-Date": dateTime,
    Authorization: authorization,
  };
  if (input.sessionToken) out["X-Amz-Security-Token"] = input.sessionToken;
  return out;
}

/** Exposed for the test vector: the signature hex alone. */
export function signatureOnly(input: SigV4Input): string {
  const auth = signRequest(input).Authorization;
  return /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? "";
}
