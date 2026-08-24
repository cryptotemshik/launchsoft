import { describe, expect, it } from "vitest";
import {
  buildTokenMetadata,
  coerceAttributeValue,
  parseCsv,
  parseStudioCsv,
  validateReveal,
} from "./csv";

describe("parseCsv", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas, escaped quotes, CRLF", () => {
    const text = 'name,desc\r\n"Bib, the 1st","He said ""gm"""\r\n';
    expect(parseCsv(text)).toEqual([
      ["name", "desc"],
      ["Bib, the 1st", 'He said "gm"'],
    ]);
  });

  it("handles newlines inside quoted fields", () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([["a"], ["line1\nline2"]]);
  });

  it("drops empty trailing rows", () => {
    expect(parseCsv("a,b\n1,2\n\n,\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("coerceAttributeValue", () => {
  it("turns plain numbers into JSON numbers", () => {
    expect(coerceAttributeValue("3")).toBe(3);
    expect(coerceAttributeValue("0.5")).toBe(0.5);
    expect(coerceAttributeValue("-2")).toBe(-2);
  });

  it("keeps leading-zero and non-numeric strings as strings", () => {
    expect(coerceAttributeValue("007")).toBe("007");
    expect(coerceAttributeValue("Laser Eyes")).toBe("Laser Eyes");
    expect(coerceAttributeValue("1st")).toBe("1st");
  });
});

const STUDIO_CSV = [
  "tokenID,name,description,file_name,external_url,attributes[Type],attributes[Eyes],attributes[Level]",
  '1,Bib #1,First bib,1.png,https://bib.example,Robot,"Laser, Red",3',
  "2,Bib #2,,2.png,,Human,,7",
  "3,,,3.png,,,,",
].join("\n");

describe("parseStudioCsv", () => {
  it("parses the OpenSea Studio format", () => {
    const { rows, errors } = parseStudioCsv(STUDIO_CSV);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      tokenId: 1,
      name: "Bib #1",
      description: "First bib",
      fileName: "1.png",
      externalUrl: "https://bib.example",
      attributes: [
        { trait_type: "Type", value: "Robot" },
        { trait_type: "Eyes", value: "Laser, Red" },
        { trait_type: "Level", value: 3 },
      ],
    });
  });

  it("skips empty attribute cells", () => {
    const { rows } = parseStudioCsv(STUDIO_CSV);
    expect(rows[1].attributes).toEqual([
      { trait_type: "Type", value: "Human" },
      { trait_type: "Level", value: 7 },
    ]);
    expect(rows[2].attributes).toEqual([]);
    expect(rows[2].name).toBeUndefined();
  });

  it("accepts tokenId header case variations", () => {
    const { rows, errors } = parseStudioCsv("tokenId,file_name\n1,1.png");
    expect(errors).toEqual([]);
    expect(rows[0].tokenId).toBe(1);
  });

  it("reports duplicate and non-numeric ids", () => {
    const { errors } = parseStudioCsv("tokenID\n1\n1\nx");
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true);
    expect(errors.some((e) => e.includes("not a whole number"))).toBe(true);
  });

  it("refuses a CSV without tokenID column", () => {
    const { errors } = parseStudioCsv("name,file_name\nBib,1.png");
    expect(errors[0]).toContain("tokenID");
  });
});

describe("validateReveal", () => {
  const images = ["1.png", "2.png", "3.png"];

  it("passes a clean set", () => {
    const { rows } = parseStudioCsv(STUDIO_CSV);
    expect(
      validateReveal({ supply: 3, imageFileNames: images, csvRows: rows }),
    ).toEqual([]);
  });

  it("passes without a CSV", () => {
    expect(
      validateReveal({ supply: 3, imageFileNames: images, csvRows: null }),
    ).toEqual([]);
  });

  it("catches count mismatch and missing ids", () => {
    const errors = validateReveal({
      supply: 4,
      imageFileNames: images,
      csvRows: null,
    });
    expect(errors.some((e) => e.includes("Image count mismatch"))).toBe(true);
    expect(errors.some((e) => e.includes("Missing images") && e.includes("4"))).toBe(
      true,
    );
  });

  it("catches bad file names, duplicates, out-of-range ids", () => {
    expect(
      validateReveal({
        supply: 2,
        imageFileNames: ["one.png", "2.png"],
        csvRows: null,
      }).some((e) => e.includes("not named")),
    ).toBe(true);
    expect(
      validateReveal({
        supply: 2,
        imageFileNames: ["1.png", "1.jpg"],
        csvRows: null,
      }).some((e) => e.includes("Duplicate")),
    ).toBe(true);
    expect(
      validateReveal({
        supply: 2,
        imageFileNames: ["1.png", "5.png"],
        csvRows: null,
      }).some((e) => e.includes("outside token id range")),
    ).toBe(true);
  });

  it("catches CSV rows that reference missing files", () => {
    const { rows } = parseStudioCsv("tokenID,file_name\n1,1.png\n2,ghost.png");
    const errors = validateReveal({
      supply: 2,
      imageFileNames: ["1.png", "2.png"],
      csvRows: rows,
    });
    expect(errors.some((e) => e.includes("ghost.png"))).toBe(true);
  });

  it("catches CSV missing rows for token ids", () => {
    const { rows } = parseStudioCsv("tokenID,file_name\n1,1.png");
    const errors = validateReveal({
      supply: 2,
      imageFileNames: ["1.png", "2.png"],
      csvRows: rows,
    });
    expect(errors.some((e) => e.includes("CSV is missing rows"))).toBe(true);
  });
});

describe("buildTokenMetadata", () => {
  it("builds full metadata from a CSV row", () => {
    const { rows } = parseStudioCsv(STUDIO_CSV);
    const meta = buildTokenMetadata({
      tokenId: 1,
      collectionName: "Bibs",
      imagesCid: "QmImages",
      imageFileName: "1.png",
      csvRow: rows[0],
    });
    expect(meta).toEqual({
      name: "Bib #1",
      description: "First bib",
      external_url: "https://bib.example",
      image: "ipfs://QmImages/1.png",
      attributes: [
        { trait_type: "Type", value: "Robot" },
        { trait_type: "Eyes", value: "Laser, Red" },
        { trait_type: "Level", value: 3 },
      ],
    });
  });

  it("falls back to minimal Name #N metadata without a CSV", () => {
    const meta = buildTokenMetadata({
      tokenId: 7,
      collectionName: "Bibs",
      imagesCid: "QmImages",
      imageFileName: "7.png",
      csvRow: null,
    });
    expect(meta).toEqual({
      name: "Bibs #7",
      image: "ipfs://QmImages/7.png",
      attributes: [],
    });
  });
});
