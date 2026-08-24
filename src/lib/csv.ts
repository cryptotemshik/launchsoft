/**
 * OpenSea Studio metadata CSV → per-token ERC-721 metadata JSON.
 *
 * Studio's CSV format:
 *   tokenID,name,description,file_name,external_url,attributes[Type],attributes[Eyes],...
 * Empty attribute cells are skipped. Attribute values that are plain numbers
 * become JSON numbers (numeric traits on OpenSea); anything else stays a string.
 */

export interface TokenMetadata {
  name: string;
  description?: string;
  external_url?: string;
  image: string;
  attributes: { trait_type: string; value: string | number }[];
}

export interface StudioRow {
  tokenId: number;
  name?: string;
  description?: string;
  fileName?: string;
  externalUrl?: string;
  attributes: { trait_type: string; value: string | number }[];
}

export interface ParsedStudioCsv {
  rows: StudioRow[];
  errors: string[];
}

/** RFC-4180-ish CSV parser: quoted fields, escaped quotes, CR/LF line ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Flush the last field/row (no trailing newline case).
  if (field !== "" || row.length > 0) pushRow();
  // Drop fully-empty trailing rows.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const ATTR_RE = /^attributes\[(.+)\]$/i;

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[_\s]/g, "");
}

/** "3" → 3, "0.5" → 0.5; leading-zero strings like "007" stay strings. */
export function coerceAttributeValue(raw: string): string | number {
  const v = raw.trim();
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function parseStudioCsv(text: string): ParsedStudioCsv {
  const errors: string[] = [];
  const table = parseCsv(text);
  if (table.length < 2) {
    return { rows: [], errors: ["CSV has no data rows (need a header + rows)"] };
  }
  const header = table[0];
  const col: Record<string, number> = {};
  const attrCols: { index: number; traitType: string }[] = [];
  header.forEach((h, idx) => {
    const attrMatch = h.trim().match(ATTR_RE);
    if (attrMatch) {
      attrCols.push({ index: idx, traitType: attrMatch[1].trim() });
      return;
    }
    col[normalizeHeader(h)] = idx;
  });

  const idCol = col["tokenid"] ?? col["id"];
  if (idCol === undefined) {
    return { rows: [], errors: ['CSV is missing a "tokenID" column'] };
  }
  const nameCol = col["name"];
  const descCol = col["description"];
  const fileCol = col["filename"];
  const urlCol = col["externalurl"];

  const rows: StudioRow[] = [];
  const seen = new Set<number>();
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const rawId = (cells[idCol] ?? "").trim();
    const tokenId = Number(rawId);
    if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(tokenId)) {
      errors.push(`Row ${r + 1}: tokenID "${rawId}" is not a whole number`);
      continue;
    }
    if (seen.has(tokenId)) {
      errors.push(`Row ${r + 1}: duplicate tokenID ${tokenId}`);
      continue;
    }
    seen.add(tokenId);
    const attributes = attrCols
      .map(({ index, traitType }) => ({
        trait_type: traitType,
        value: coerceAttributeValue(cells[index] ?? ""),
      }))
      .filter((a) => String(a.value).trim() !== "");
    rows.push({
      tokenId,
      name: (nameCol !== undefined ? cells[nameCol] : "")?.trim() || undefined,
      description:
        (descCol !== undefined ? cells[descCol] : "")?.trim() || undefined,
      fileName:
        (fileCol !== undefined ? cells[fileCol] : "")?.trim() || undefined,
      externalUrl:
        (urlCol !== undefined ? cells[urlCol] : "")?.trim() || undefined,
      attributes,
    });
  }
  rows.sort((a, b) => a.tokenId - b.tokenId);
  return { rows, errors };
}

export interface RevealValidationInput {
  supply: number;
  /** Image file names as uploaded, e.g. ["1.png", "2.png"]. */
  imageFileNames: string[];
  /** Parsed CSV rows; null when launching without a CSV. */
  csvRows: StudioRow[] | null;
}

/**
 * Refuse with a clear diff when images/CSV/supply disagree:
 * ids must run 1..supply, every CSV row must name an uploaded file, every
 * image must be used.
 */
export function validateReveal(input: RevealValidationInput): string[] {
  const { supply, imageFileNames, csvRows } = input;
  const errors: string[] = [];

  const idOf = (fileName: string): number | null => {
    const m = fileName.match(/^(\d+)\.[A-Za-z0-9]+$/);
    return m ? Number(m[1]) : null;
  };

  if (imageFileNames.length !== supply) {
    errors.push(
      `Image count mismatch: ${imageFileNames.length} files uploaded, supply is ${supply}`,
    );
  }
  const badNames = imageFileNames.filter((f) => idOf(f) === null);
  if (badNames.length > 0) {
    errors.push(
      `Files not named <tokenId>.<ext>: ${summarizeList(badNames)}`,
    );
  }
  const ids = imageFileNames
    .map(idOf)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const dupes = ids.filter((n, i) => i > 0 && ids[i - 1] === n);
  if (dupes.length > 0) {
    errors.push(`Duplicate token ids in image files: ${summarizeList(dupes)}`);
  }
  const idSet = new Set(ids);
  const missing: number[] = [];
  for (let n = 1; n <= supply; n++) if (!idSet.has(n)) missing.push(n);
  if (missing.length > 0 && badNames.length === 0) {
    errors.push(`Missing images for token ids: ${summarizeList(missing)}`);
  }
  const extra = ids.filter((n) => n < 1 || n > supply);
  if (extra.length > 0) {
    errors.push(
      `Images outside token id range 1..${supply}: ${summarizeList(extra)}`,
    );
  }

  if (csvRows) {
    const csvIds = new Set(csvRows.map((r) => r.tokenId));
    const csvMissing: number[] = [];
    for (let n = 1; n <= supply; n++) if (!csvIds.has(n)) csvMissing.push(n);
    if (csvMissing.length > 0) {
      errors.push(`CSV is missing rows for token ids: ${summarizeList(csvMissing)}`);
    }
    const csvExtra = csvRows
      .filter((r) => r.tokenId < 1 || r.tokenId > supply)
      .map((r) => r.tokenId);
    if (csvExtra.length > 0) {
      errors.push(
        `CSV rows outside token id range 1..${supply}: ${summarizeList(csvExtra)}`,
      );
    }
    const fileSet = new Set(imageFileNames);
    const unmatched = csvRows.filter(
      (r) => r.fileName && !fileSet.has(r.fileName),
    );
    if (unmatched.length > 0) {
      errors.push(
        `CSV file_name values with no matching uploaded image: ${summarizeList(
          unmatched.map((r) => `${r.tokenId}→${r.fileName}`),
        )}`,
      );
    }
  }
  return errors;
}

function summarizeList(items: (string | number)[], max = 8): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} … (${items.length} total)` : shown;
}

/**
 * Build per-token metadata. Files in the metadata folder are named "1", "2", …
 * with NO extension: ERC721SeaDrop's tokenURI is baseURI + tokenId, no ".json"
 * suffix (verified in ERC721SeaDrop.sol).
 */
export function buildTokenMetadata(params: {
  tokenId: number;
  collectionName: string;
  imagesCid: string;
  imageFileName: string;
  csvRow: StudioRow | null;
}): TokenMetadata {
  const { tokenId, collectionName, imagesCid, imageFileName, csvRow } = params;
  const meta: TokenMetadata = {
    name: csvRow?.name || `${collectionName} #${tokenId}`,
    image: `ipfs://${imagesCid}/${imageFileName}`,
    attributes: csvRow?.attributes ?? [],
  };
  if (csvRow?.description) meta.description = csvRow.description;
  if (csvRow?.externalUrl) meta.external_url = csvRow.externalUrl;
  return meta;
}
