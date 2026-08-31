import { describe, expect, it } from "vitest";
import { signatureOnly, signRequest } from "./awsSigv4";

/**
 * AWS's own published Signature Version 4 example: GET ListUsers on IAM, with
 * the example credentials and a pinned timestamp. If the HMAC chain here is
 * right, the signature is exactly this — so a mistake is a failed test, not an
 * auth error on a live box we cannot debug from here.
 *
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html
 */
describe("the SigV4 signing chain, against AWS's vector", () => {
  const base = {
    method: "GET",
    host: "iam.amazonaws.com",
    path: "/",
    query: "Action=ListUsers&Version=2010-05-08",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: "",
    service: "iam",
    region: "us-east-1",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    date: new Date("2015-08-30T12:36:00Z"),
  };

  it("produces the documented signature", () => {
    expect(signatureOnly(base)).toBe(
      "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("builds the Authorization header AWS expects", () => {
    const auth = signRequest(base).Authorization;
    expect(auth).toContain("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request");
    expect(auth).toContain("SignedHeaders=content-type;host;x-amz-date");
  });

  it("sets the timestamp header in the basic ISO form", () => {
    expect(signRequest(base)["X-Amz-Date"]).toBe("20150830T123600Z");
  });
});

describe("temporary credentials", () => {
  it("signs and forwards the session token", () => {
    // Instance-role credentials always carry a token; it must be both signed
    // (or the request is rejected) and sent.
    const headers = signRequest({
      method: "POST",
      host: "secretsmanager.us-east-2.amazonaws.com",
      path: "/",
      headers: { "content-type": "application/x-amz-json-1.1" },
      body: '{"SecretId":"x"}',
      service: "secretsmanager",
      region: "us-east-2",
      accessKeyId: "ASIA_EXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "the-session-token",
      date: new Date("2026-01-01T00:00:00Z"),
    });
    expect(headers["X-Amz-Security-Token"]).toBe("the-session-token");
    expect(headers.Authorization).toContain("x-amz-security-token");
  });

  it("changes the signature when the body changes", () => {
    const of = (body: string) =>
      signatureOnly({
        method: "POST",
        host: "secretsmanager.us-east-2.amazonaws.com",
        path: "/",
        headers: { "content-type": "application/x-amz-json-1.1" },
        body,
        service: "secretsmanager",
        region: "us-east-2",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "secret",
        date: new Date("2026-01-01T00:00:00Z"),
      });
    expect(of('{"SecretId":"a"}')).not.toBe(of('{"SecretId":"b"}'));
  });
});
