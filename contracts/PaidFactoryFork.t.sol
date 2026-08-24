// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { Test } from "forge-std/Test.sol";
import {
    PaidSeaDropCloneFactory
} from "seadrop/clones/PaidSeaDropCloneFactory.sol";
import {
    ERC721SeaDropCloneable
} from "seadrop/clones/ERC721SeaDropCloneable.sol";
import {
    ERC721SeaDropStructsErrorsAndEvents
} from "seadrop/lib/ERC721SeaDropStructsErrorsAndEvents.sol";
import { PublicDrop } from "seadrop/lib/SeaDropStructs.sol";
import { ISeaDrop } from "seadrop/interfaces/ISeaDrop.sol";

/**
 * Fork test: proves a factory-launched clone registers with the REAL SeaDrop
 * on Robinhood Chain and that multiConfigure writes a public drop that the
 * canonical SeaDrop reports back. Run with a fork URL; skipped otherwise.
 */
contract PaidFactoryForkTest is Test {
    address constant SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    PaidSeaDropCloneFactory factory;
    address platform = address(0xFEE);
    address creator = address(0xC0FFEE);

    function setUp() public {
        // Only meaningful on a fork where SeaDrop is deployed.
        if (SEADROP.code.length == 0) return;
        vm.prank(platform);
        factory = new PaidSeaDropCloneFactory(0.01 ether, platform);
        vm.deal(creator, 10 ether);
    }

    function testCloneConfiguresRealSeaDrop() public {
        if (SEADROP.code.length == 0) {
            emit log("no SeaDrop on this network - skipping fork test");
            return;
        }

        vm.prank(creator);
        address col = factory.launch{ value: 0.01 ether }(
            "Fork Test",
            "FORK",
            bytes32("fork")
        );

        // Build a minimal public-drop config, exactly as the frontend does.
        ERC721SeaDropStructsErrorsAndEvents.MultiConfigureStruct memory cfg;
        cfg.maxSupply = 100;
        cfg.seaDropImpl = SEADROP;
        cfg.creatorPayoutAddress = creator;
        cfg.publicDrop = PublicDrop({
            mintPrice: 0.02 ether,
            startTime: uint48(block.timestamp),
            endTime: uint48(block.timestamp + 7 days),
            maxTotalMintableByWallet: 5,
            feeBps: 1000,
            restrictFeeRecipients: true
        });
        address[] memory feeRecipients = new address[](1);
        feeRecipients[0] = 0x0000a26b00c1F0DF003000390027140000fAa719;
        cfg.allowedFeeRecipients = feeRecipients;

        vm.prank(creator);
        ERC721SeaDropCloneable(col).multiConfigure(cfg);

        // The REAL SeaDrop must now report this clone's public drop.
        PublicDrop memory pd = ISeaDrop(SEADROP).getPublicDrop(col);
        assertEq(pd.mintPrice, 0.02 ether, "mintPrice not registered");
        assertEq(pd.maxTotalMintableByWallet, 5, "per-wallet not registered");
        assertEq(pd.feeBps, 1000, "feeBps not registered");
        assertEq(
            ISeaDrop(SEADROP).getCreatorPayoutAddress(col),
            creator,
            "payout not set to creator"
        );
        assertEq(ERC721SeaDropCloneable(col).maxSupply(), 100);
        assertEq(ERC721SeaDropCloneable(col).owner(), creator);
    }
}
