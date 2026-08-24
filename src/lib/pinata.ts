/**
 * Pinata IPFS uploads, straight from the browser with a user-pasted JWT.
 * The JWT lives in React state only — it is never persisted anywhere.
 */

const PINATA_API = "https://api.pinata.cloud";

export class PinataError extends Error {}

export async function testPinataJwt(jwt: string): Promise<void> {
  const token = jwt.trim();
  // The JWT is a three-part token starting with "eyJ". Pinata's key dialog
  // shows three values and the other two (API Key, API Secret) are rejected
  // here with a bare 401 — name the mix-up instead.
  if (!token.startsWith("eyJ") || token.split(".").length !== 3) {
    throw new PinataError(
      "That doesn't look like a Pinata JWT. In Pinata's \"API Key Information\" " +
        'dialog copy the third field — "JWT (secret access token)", it starts ' +
        "with eyJ… — not the API Key or the API Secret.",
    );
  }
  const res = await fetch(`${PINATA_API}/data/testAuthentication`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new PinataError(
      `Pinata rejected the JWT (HTTP ${res.status}). Create a key at Pinata → ` +
        "API Keys with pinFileToIPFS + pinJSONToIPFS permissions (or Admin), " +
        'then paste its "JWT (secret access token)" value here.',
    );
  }
}

/** XHR so large uploads report progress; fetch has no upload progress. */
function xhrUpload(
  jwt: string,
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${PINATA_API}/pinning/pinFileToIPFS`);
    xhr.setRequestHeader("Authorization", `Bearer ${jwt.trim()}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText).IpfsHash as string);
        } catch {
          reject(new PinataError("Pinata returned an unreadable response"));
        }
      } else {
        reject(
          new PinataError(
            `Pinata upload failed (HTTP ${xhr.status}): ${xhr.responseText.slice(0, 200)}`,
          ),
        );
      }
    };
    xhr.onerror = () =>
      reject(new PinataError("Network error uploading to Pinata"));
    xhr.send(form);
  });
}

export async function pinFile(
  jwt: string,
  file: Blob,
  name: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const form = new FormData();
  form.append("file", file, name);
  form.append("pinataMetadata", JSON.stringify({ name }));
  return xhrUpload(jwt, form, onProgress);
}

/**
 * Pin a directory: every file is appended under a shared root folder name, and
 * Pinata returns the directory CID. Individual files resolve as
 * ipfs://<cid>/<path>.
 */
export async function pinDirectory(
  jwt: string,
  files: { path: string; content: Blob }[],
  name: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const form = new FormData();
  for (const f of files) {
    form.append("file", f.content, `${name}/${f.path}`);
  }
  form.append("pinataMetadata", JSON.stringify({ name }));
  return xhrUpload(jwt, form, onProgress);
}

export async function pinJson(
  jwt: string,
  content: unknown,
  name: string,
): Promise<string> {
  const res = await fetch(`${PINATA_API}/pinning/pinJSONToIPFS`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pinataContent: content,
      pinataMetadata: { name },
    }),
  });
  if (!res.ok) {
    throw new PinataError(
      `Pinata JSON pin failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()).IpfsHash as string;
}
