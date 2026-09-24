import { describe, expect, it } from "vitest";
import { buildXlsx, walletsXlsx } from "./xlsx";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("xlsx", () => {
  it("is a zip with the workbook parts", () => {
    const b = walletsXlsx([{ address: "0xabc", key: "0x01" }]);
    expect([...b.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const t = text(b);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]) {
      expect(t).toContain(part);
    }
  });

  it("puts the address in A and the key in B, as text", () => {
    const t = text(walletsXlsx([{ address: "0xabc", key: "0x00ff" }]));
    expect(t).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">0xabc</t>');
    expect(t).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">0x00ff</t>');
  });

  it("escapes XML", () => {
    expect(text(buildXlsx([["a<b&c"]]))).toContain("a&lt;b&amp;c");
  });
});
