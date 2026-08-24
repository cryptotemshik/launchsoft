import { useMemo, useState } from "react";
import { xShareUrl } from "../config";
import {
  CHAINS_BY_ID,
  DEFAULT_CHAIN_ID,
  openSeaCollectionUrl,
  type ChainInfo,
} from "../chains";
import { useActiveChain } from "../signer";
import type { CollectionStatus } from "../lib/collectionData";
import { timeAgo, unixToLocalAndUtc, weiToEth } from "../lib/convert";
import { getAllClicks, LINK_LABEL } from "../lib/linkStats";
import {
  formatEthShort,
  formatUsdApprox,
  type ProfitBreakdown,
} from "../lib/profit";
import { AddrLink, CopyButton, IpfsLink, OpenSeaLink, TrackedLink } from "./Bits";

export interface ProfitView {
  loading: boolean;
  breakdown?: ProfitBreakdown;
  ethUsd: number | null;
  error?: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function CollectionDetail({
  contract,
  status,
  isOwner,
}: {
  contract: string;
  status: CollectionStatus;
  isOwner: boolean;
}) {
  const info: ChainInfo =
    useActiveChain() ?? CHAINS_BY_ID.get(DEFAULT_CHAIN_ID)!;
  const pd = status.publicDrop;
  // Bumped on each tracked click so the tallies below re-read from storage.
  const [clickTick, setClickTick] = useState(0);
  const bumpClicks = () => setClickTick((n) => n + 1);
  const revealed = status.baseURI.endsWith("/");
  const enforced =
    info.transferValidator !== undefined &&
    status.transferValidator.toLowerCase() === info.transferValidator.toLowerCase();
  return (
    <dl className="kv">
      <dt>minted</dt>
      <dd>
        {status.totalSupply.toString()} / {status.maxSupply.toString()}
      </dd>
      <dt>price</dt>
      <dd>{pd.mintPrice === 0n ? "FREE" : `${weiToEth(pd.mintPrice)} ETH`}</dd>
      <dt>window</dt>
      <dd>
        {pd.startTime === 0 ? (
          <span className="warn">not configured</span>
        ) : (
          <>
            {unixToLocalAndUtc(pd.startTime).local} →{" "}
            {unixToLocalAndUtc(pd.endTime).local}
            <div className="dim">
              {unixToLocalAndUtc(pd.startTime).utc} →{" "}
              {unixToLocalAndUtc(pd.endTime).utc}
            </div>
          </>
        )}
      </dd>
      <dt>per wallet</dt>
      <dd>{pd.maxTotalMintableByWallet}</dd>
      <dt>fee</dt>
      <dd>
        {pd.feeBps / 100}% · restricted: {pd.restrictFeeRecipients ? "yes" : "no"} ·
        recipients: {status.allowedFeeRecipients.length}
      </dd>
      <dt>royalties</dt>
      <dd>
        {status.royaltyBps > 0 ? (
          <>
            {status.royaltyBps / 100}% → {status.royaltyReceiver.slice(0, 10)}…{" "}
            {enforced ? (
              <span className="ok">[ENFORCED — OpenSea validator]</span>
            ) : status.transferValidator !== ZERO ? (
              <span className="warn">
                [custom validator {status.transferValidator.slice(0, 10)}…]
              </span>
            ) : (
              <span className="warn">[signal only — not enforced]</span>
            )}
          </>
        ) : (
          "not set (ERC-2981)"
        )}
      </dd>
      <dt>owner</dt>
      <dd>
        <AddrLink address={status.owner} />
        {isOwner ? <span className="ok"> (you)</span> : null}
      </dd>
      <dt>payout</dt>
      <dd>
        <AddrLink address={status.creatorPayout} />
        <div className="dim">
          mint proceeds stream here automatically — nothing to withdraw
        </div>
      </dd>
      <dt>baseURI</dt>
      <dd>
        {status.baseURI ? <IpfsLink uri={status.baseURI} /> : "—"}{" "}
        <span className={revealed ? "ok" : "warn"}>
          {revealed ? "(revealed)" : "(pre-reveal)"}
        </span>
      </dd>
      <dt>contractURI</dt>
      <dd>{status.contractURI ? <IpfsLink uri={status.contractURI} /> : "—"}</dd>
      <dt>provenance</dt>
      <dd>{/^0x0+$/.test(status.provenanceHash) ? "not set" : status.provenanceHash}</dd>
      <dt>links</dt>
      <dd>
        <OpenSeaLink
          address={contract}
          fallback={openSeaCollectionUrl(info, contract)}
          onCounted={bumpClicks}
        />{" "}
        ·{" "}
        <span className="addr-row">
          <AddrLink address={contract} />
          <CopyButton text={contract} />
        </span>{" "}
        ·{" "}
        <TrackedLink
          contract={contract}
          kind="twitter"
          href={xShareUrl(
            `${status.name} — live on OpenSea.`,
            openSeaCollectionUrl(info, contract),
          )}
          onCounted={bumpClicks}
        >
          share on X
        </TrackedLink>
        {isOwner ? (
          <div className="dim">
            connect X (Twitter): OpenSea → collection → Edit → Links → Connect
            (OAuth — only possible on opensea.io)
          </div>
        ) : null}
      </dd>
      <dt>link clicks</dt>
      <dd>
        <LinkClicks contract={contract} tick={clickTick} />
      </dd>
    </dl>
  );
}

/**
 * Click tallies for the collection's outbound links. Honest about scope: these
 * are clicks made through LaunchPad in this browser — opensea.io can't report
 * its own link clicks to a static site.
 */
function LinkClicks({ contract, tick }: { contract: string; tick: number }) {
  const rows = useMemo(
    () => getAllClicks(contract),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contract, tick],
  );
  const total = rows.reduce((n, r) => n + r.record.count, 0);

  return (
    <div>
      <div className="click-row">
        {rows.map(({ kind, record }) => (
          <span key={kind} className="click-stat">
            <b>{record.count}</b> {LINK_LABEL[kind]}
            {record.lastAt ? (
              <span className="dim"> · {timeAgo(Math.floor(record.lastAt / 1000))}</span>
            ) : null}
          </span>
        ))}
      </div>
      <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
        {total === 0
          ? "No clicks counted yet — these count clicks on the links above, made in this browser."
          : "Counts clicks on the links above, made through LaunchPad in this browser."}{" "}
        Clicks that happen on opensea.io can&apos;t reach a static site; to count
        every visitor, put a tracked short link (Bitly, Dub, etc.) in the
        collection&apos;s website/X field and read the numbers there.
      </div>
    </div>
  );
}

export function ProfitBlock({
  b,
  ethUsd,
}: {
  b: ProfitBreakdown;
  ethUsd: number | null;
}) {
  const pos = b.profit >= 0n;
  const usd = formatUsdApprox(b.profit, ethUsd);
  return (
    <>
      <div className={`profit-big ${pos ? "profit-pos" : "profit-neg"}`}>
        {pos ? "▲ +" : "▼ "}
        {formatEthShort(b.profit)} ETH
        {usd ? <span className="profit-usd">{usd}</span> : null}
      </div>
      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>mint proceeds</dt>
        <dd>
          <span className="ok">+{formatEthShort(b.mint.creator)} ETH</span>{" "}
          <span className="dim">
            {b.mint.mintedViaSeaDrop.toString()} minted · gross{" "}
            {formatEthShort(b.mint.gross)} − OpenSea&apos;s cut{" "}
            {formatEthShort(b.mint.openSeaFee)}
          </span>
        </dd>
        <dt>royalties</dt>
        <dd>
          <span className="ok">+{formatEthShort(b.royalties)} ETH</span>{" "}
          <span className="dim">
            received via OpenSea/Seaport payouts
            {b.royaltiesTruncated ? " (first 250 payouts counted)" : ""}
          </span>
        </dd>
        <dt>launch cost</dt>
        <dd>
          <span className="error">−{formatEthShort(b.launchCost, 6)} ETH</span>{" "}
          <span className="dim">
            gas paid
            {b.launchCostComplete ? "" : " (deploy tx only — launch not made from this browser)"}
          </span>
        </dd>
      </dl>
      <p className="dim" style={{ marginBottom: 0, fontSize: 11 }}>
        Mint numbers are exact (decoded from SeaDrop mint events, already net of
        OpenSea&apos;s drop fee). Royalties are an estimate: every Seaport payout
        to the royalty address counts, so other collections or sales from the
        same wallet inflate it. Amounts are what actually reached the wallet.
      </p>
    </>
  );
}
