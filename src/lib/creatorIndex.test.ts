import { beforeEach, describe, expect, it } from "vitest";
import { CreatorIndex, reuseBand } from "./creatorIndex";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const OWNER = "0xDeaDBeef00000000000000000000000000000001";

let ix: CreatorIndex;
beforeEach(() => {
  ix = new CreatorIndex();
});

describe("CreatorIndex", () => {
  it("groups collections by the address that launched them", () => {
    ix.remember({ contract: A, owner: OWNER, name: "First", startTime: 100 });
    ix.remember({ contract: B, owner: OWNER, name: "Second", startTime: 200 });
    ix.remember({ contract: C, owner: "0x9999", name: "Elsewhere" });
    expect(ix.byOwner(OWNER).map((c) => c.name)).toEqual(["Second", "First"]);
    expect(ix.byOwner("0x9999")).toHaveLength(1);
  });

  it("keys owners and handles case-insensitively", () => {
    ix.remember({ contract: A, owner: OWNER.toUpperCase(), twitter: "SomeOne" });
    expect(ix.byOwner(OWNER.toLowerCase())).toHaveLength(1);
    expect(ix.byTwitter("someone")).toHaveLength(1);
  });

  it("merges what arrives later instead of replacing it", () => {
    // The owner comes from a scan and the handle from the marketplace lookup,
    // minutes apart. The second must not erase the first.
    ix.remember({ contract: A, owner: OWNER, name: "Known" });
    ix.remember({ contract: A, twitter: "handle" });
    expect(ix.byOwner(OWNER)).toHaveLength(1);
    expect(ix.byTwitter("handle")[0].name).toBe("Known");
  });

  it("never double-counts a collection seen in two scans", () => {
    ix.remember({ contract: A, owner: OWNER });
    ix.remember({ contract: A, owner: OWNER });
    ix.remember({ contract: A.toUpperCase(), owner: OWNER });
    expect(ix.byOwner(OWNER)).toHaveLength(1);
    expect(ix.size).toBe(1);
  });

  it("puts a collection with no date last rather than first", () => {
    ix.remember({ contract: A, owner: OWNER, name: "Undated" });
    ix.remember({ contract: B, owner: OWNER, name: "Dated", startTime: 500 });
    expect(ix.byOwner(OWNER).map((c) => c.name)).toEqual(["Dated", "Undated"]);
  });

  it("keeps accumulating across scans, which is the whole point", () => {
    // A six-hour window shows one collection for an address that has launched
    // four; three scans of it should end up knowing about all four.
    ix.remember({ contract: A, owner: OWNER });
    expect(ix.byOwner(OWNER)).toHaveLength(1);
    ix.remember({ contract: B, owner: OWNER });
    ix.remember({ contract: C, owner: OWNER });
    expect(ix.byOwner(OWNER)).toHaveLength(3);
  });

  it("answers about an owner it has never seen without inventing one", () => {
    expect(ix.byOwner("0xnobody")).toEqual([]);
    expect(ix.byTwitter("nobody")).toEqual([]);
  });

  it("ignores a null handle rather than indexing it", () => {
    ix.remember({ contract: A, owner: OWNER, twitter: null });
    expect(Object.keys(ix.relatedFor([A]).twitters)).toEqual([]);
  });
});

describe("relatedFor", () => {
  it("returns only the owners and handles actually on screen", () => {
    ix.remember({ contract: A, owner: OWNER, twitter: "shared" });
    ix.remember({ contract: B, owner: OWNER, twitter: "shared" });
    ix.remember({ contract: C, owner: "0xother", twitter: "elsewhere" });

    const r = ix.relatedFor([A]);
    expect(Object.keys(r.owners)).toEqual([OWNER.toLowerCase()]);
    expect(Object.keys(r.twitters)).toEqual(["shared"]);
    // …and the lists are complete even though only one contract was asked about.
    expect(r.owners[OWNER.toLowerCase()]).toHaveLength(2);
    expect(r.twitters.shared).toHaveLength(2);
  });

  it("skips contracts it has never indexed", () => {
    expect(ix.relatedFor([A])).toEqual({ owners: {}, twitters: {} });
  });
});

describe("reuseBand", () => {
  it("says nothing about a first collection", () => {
    // Everyone's first drop is their first drop; flagging it would make the
    // badge meaningless.
    expect(reuseBand(0)).toBe("none");
    expect(reuseBand(1)).toBe("none");
  });

  it("escalates from a glance to a production line", () => {
    expect(reuseBand(2)).toBe("warn");
    expect(reuseBand(3)).toBe("warn");
    expect(reuseBand(4)).toBe("bad");
    expect(reuseBand(12)).toBe("bad");
  });
});
