# LaunchPad launch-fee factory

`PaidSeaDropCloneFactory.sol` monetizes LaunchPad: it deploys OpenSea
`ERC721SeaDropCloneable` collections as cheap minimal-proxy clones and charges a
flat launch fee in native ETH that goes to your fee recipient. The clone is
owned by the creator the instant it's made (one-step), so launch stays two
transactions and the creator fully controls their collection.

Verified against the real Robinhood Chain SeaDrop: a factory-launched clone
registers with the canonical SeaDrop and `getPublicDrop` reports its drop back
(see `PaidFactoryFork.t.sol`).

## Honest limits

The SeaDrop system is permissionless and open-source. This factory makes the
fee unavoidable **for anyone using it**, but it cannot stop a determined user
from deploying a SeaDrop token directly (via Foundry, Etherscan, or OpenSea's
own free clone factory) and skipping your fee. It monetizes convenience — 99%
of users go through your site, where the fee is baked into the same transaction
as the deploy, with no "skip" button — not a monopoly. Price accordingly.

## Build & deploy (once)

These `.sol` files must be compiled inside the OpenSea seadrop repo (they import
its clone contracts). From a machine with [Foundry](https://getfoundry.sh):

```bash
git clone https://github.com/ProjectOpenSea/seadrop && cd seadrop
git submodule update --init lib/ERC721A lib/solmate \
  lib/openzeppelin-contracts lib/utility-contracts lib/forge-std

# Drop in the factory + tests from this folder:
cp /path/to/contracts/PaidSeaDropCloneFactory.sol src/clones/
cp /path/to/contracts/PaidSeaDropCloneFactory.t.sol test/foundry/
cp /path/to/contracts/PaidFactoryFork.t.sol         test/foundry/

# Run the tests (unit + a fork test against the live chain):
forge test --match-contract PaidSeaDropCloneFactoryTest
forge test --match-contract PaidFactoryForkTest \
  --fork-url https://rpc.mainnet.chain.robinhood.com

# Deploy it. Constructor args: <launchFee in wei> <feeRecipient>.
# Configured: 0.001 ETH fee (1000000000000000 wei), fees to
# 0x989fc61bcdf2cb40864127c2f75955d76a9a679a.
forge create src/clones/PaidSeaDropCloneFactory.sol:PaidSeaDropCloneFactory \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key $YOUR_DEPLOYER_KEY \
  --constructor-args 1000000000000000 0x989fc61bcdf2cb40864127c2f75955d76a9a679a
```

Then paste the deployed factory address into `src/config.ts`:

```ts
export const LAUNCH_FACTORY = "0xYourFactoryAddress";
```

Rebuild and redeploy the site. Every launch now routes through the factory and
pays the fee. While `LAUNCH_FACTORY` is empty, LaunchPad falls back to a free
direct deploy (handy for local/self-host testing).

## Managing the fee later (owner only)

The deployer is the factory owner and can change things on-chain without
touching code — from Blockscout's *Write Contract* tab, or with `cast`:

```bash
# Change the fee to 0.02 ETH:
cast send <FACTORY> "setLaunchFee(uint256)" 20000000000000000 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $OWNER_KEY

# Change where fees go:
cast send <FACTORY> "setFeeRecipient(address)" 0xNewRecipient \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key $OWNER_KEY
```

The app reads `launchFee()` live, so a fee change takes effect immediately with
no redeploy.

## Before a real mainnet launch

Get the factory **audited**. It handles other people's money (fees + refunds).
The code is deliberately small and uses checks-effects-interactions plus a
reentrancy latch, but an independent audit is non-negotiable for a public,
fee-taking contract.
