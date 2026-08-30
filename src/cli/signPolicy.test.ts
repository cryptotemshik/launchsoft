import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther } from "viem";
import { judgeAll, judgeTransaction, MINT_SELECTORS, type PolicyContext } from "./signPolicy";
import { SEADROP } from "../chains";
import { seaDropAbi } from "../contracts/seadrop";

const OUR_A = `0x${"aa".repeat(20)}` as `0x${string}`;
const OUR_B = `0x${"bb".repeat(20)}`;
const LOGIN = `0x${"cc".repeat(20)}`;
const STRANGER = `0x${"dd".repeat(20)}`;
const COLLECTION = `0x${"ee".repeat(20)}` as `0x${string}`;

const ctx: PolicyContext = {
  ownWallets: new Set([OUR_A, OUR_B]),
  withdrawTo: new Set([LOGIN]),
  mintContract: SEADROP.toLowerCase(),
  maxMintWei: parseEther("0.01"),
};

/** A real mintPublic call, encoded with the real ABI — not a hand-rolled hex. */
const mintData = encodeFunctionData({
  abi: seaDropAbi,
  functionName: "mintPublic",
  args: [COLLECTION, OUR_A, OUR_A, 2n],
});

const transferData = (to: string) =>
  encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "transferFrom",
        inputs: [
          { type: "address", name: "from" },
          { type: "address", name: "to" },
          { type: "uint256", name: "id" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ] as const,
    functionName: "transferFrom",
    args: [OUR_A, to as `0x${string}`, 42n],
  });

describe("minting", () => {
  it("allows a real mint call to SeaDrop", () => {
    expect(judgeTransaction({ to: SEADROP, value: 0n, data: mintData }, ctx)).toEqual({
      ok: true,
      kind: "mint",
    });
  });

  it("knows all three mint functions", () => {
    // The set is built from signatures at load; three selectors, no typos.
    expect(MINT_SELECTORS.size).toBe(3);
  });

  it("refuses any other function on SeaDrop", () => {
    // Owning the API must not mean calling arbitrary SeaDrop admin functions
    // with our wallets.
    const v = judgeTransaction({ to: SEADROP, value: 0n, data: "0xdeadbeef" }, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("not a mint function");
  });

  it("refuses a mint priced over the cap", () => {
    // The one hole in a destination whitelist: a fake 10 ETH "drop" whose
    // creator payout is the attacker. The cap is what closes it.
    const v = judgeTransaction({ to: SEADROP, value: parseEther("10"), data: mintData }, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("exceeds the policy cap");
  });

  it("allows a mint priced exactly at the cap", () => {
    expect(
      judgeTransaction({ to: SEADROP, value: parseEther("0.01"), data: mintData }, ctx).ok,
    ).toBe(true);
  });

  it("matches the mint contract case-insensitively", () => {
    expect(judgeTransaction({ to: SEADROP.toUpperCase().replace("0X", "0x"), value: 0n, data: mintData }, ctx).ok).toBe(
      true,
    );
  });
});

describe("plain ETH transfers", () => {
  it("allows funding our own wallets", () => {
    expect(judgeTransaction({ to: OUR_B, value: parseEther("1") }, ctx)).toEqual({
      ok: true,
      kind: "transfer-own",
    });
  });

  it("allows withdrawing to the registered address", () => {
    expect(judgeTransaction({ to: LOGIN, value: parseEther("5") }, ctx)).toEqual({
      ok: true,
      kind: "withdraw",
    });
  });

  it("refuses everywhere else — this is the rule the box exists to enforce", () => {
    const v = judgeTransaction({ to: STRANGER, value: parseEther("0.1") }, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("not a registered withdrawal address");
  });

  it("treats '0x' data as no data", () => {
    expect(judgeTransaction({ to: OUR_B, value: 1n, data: "0x" }, ctx).ok).toBe(true);
  });
});

describe("NFT moves", () => {
  it("allows gathering onto one of our wallets", () => {
    expect(
      judgeTransaction({ to: COLLECTION, value: 0n, data: transferData(OUR_B) }, ctx),
    ).toEqual({ ok: true, kind: "nft-move" });
  });

  it("allows sweeping to the registered address", () => {
    expect(
      judgeTransaction({ to: COLLECTION, value: 0n, data: transferData(LOGIN) }, ctx).ok,
    ).toBe(true);
  });

  it("judges by the recipient inside the calldata, not the contract", () => {
    // The `to` of the transaction is the collection; the place the NFT lands
    // is an argument. Judging the wrong one would allow everything.
    const v = judgeTransaction({ to: COLLECTION, value: 0n, data: transferData(STRANGER) }, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(STRANGER);
  });

  it("refuses an NFT transfer carrying ETH", () => {
    expect(
      judgeTransaction({ to: COLLECTION, value: 1n, data: transferData(OUR_B) }, ctx).ok,
    ).toBe(false);
  });

  it("refuses calldata too short to hold a recipient", () => {
    expect(judgeTransaction({ to: COLLECTION, value: 0n, data: "0x23b872dd0011" }, ctx).ok).toBe(
      false,
    );
  });
});

describe("everything else", () => {
  it("refuses contract creation", () => {
    expect(judgeTransaction({ value: 0n, data: "0x600060" }, ctx).ok).toBe(false);
  });

  it("refuses an arbitrary call to an arbitrary contract", () => {
    // approve(), setApprovalForAll(), a swap, a bridge — none of it is
    // anything this server sends, so none of it needs to be listed to die.
    const v = judgeTransaction({ to: STRANGER, value: 0n, data: "0x095ea7b3" + "00".repeat(64) }, ctx);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("nothing this server ever sends");
  });
});

describe("judging a batch", () => {
  it("passes when every transaction passes", () => {
    expect(
      judgeAll(
        [
          { to: OUR_A, value: 1n },
          { to: SEADROP, value: 0n, data: mintData },
        ],
        ctx,
      ),
    ).toEqual({ ok: true });
  });

  it("sinks the whole batch on one bad transaction, and names it", () => {
    // A sweep where half went to the right place is not half-safe; it is a
    // confusing incident.
    const v = judgeAll(
      [
        { to: OUR_A, value: 1n },
        { to: STRANGER, value: 1n },
      ],
      ctx,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.index).toBe(1);
  });
});
