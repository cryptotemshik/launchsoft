// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { Test } from "forge-std/Test.sol";
import {
    PaidSeaDropCloneFactory
} from "seadrop/clones/PaidSeaDropCloneFactory.sol";
import {
    ERC721SeaDropCloneable
} from "seadrop/clones/ERC721SeaDropCloneable.sol";

contract PaidSeaDropCloneFactoryTest is Test {
    PaidSeaDropCloneFactory factory;
    address platform = address(0xFEE);
    address creator = address(0xC0FFEE);
    uint256 fee = 0.01 ether;

    function setUp() public {
        vm.prank(platform);
        factory = new PaidSeaDropCloneFactory(fee, platform);
        vm.deal(creator, 10 ether);
    }

    function testLaunchCollectsFeeAndSetsOwner() public {
        uint256 platformBefore = platform.balance;
        vm.prank(creator);
        address col = factory.launch{ value: fee }("Bibs", "BIB", bytes32("s1"));

        assertEq(platform.balance - platformBefore, fee, "fee not received");
        assertEq(ERC721SeaDropCloneable(col).owner(), creator, "owner != creator");
        assertEq(ERC721SeaDropCloneable(col).name(), "Bibs");
        assertEq(ERC721SeaDropCloneable(col).symbol(), "BIB");
    }

    function testRefundsOverpayment() public {
        uint256 before = creator.balance;
        vm.prank(creator);
        factory.launch{ value: 1 ether }("Bibs", "BIB", bytes32("s2"));
        // Spent exactly the fee, rest refunded.
        assertEq(before - creator.balance, fee, "overpayment not refunded");
    }

    function testRevertsOnUnderpayment() public {
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaidSeaDropCloneFactory.InsufficientFee.selector,
                fee - 1,
                fee
            )
        );
        factory.launch{ value: fee - 1 }("Bibs", "BIB", bytes32("s3"));
    }

    function testFreeLaunchWhenFeeZero() public {
        vm.prank(platform);
        factory.setLaunchFee(0);
        vm.prank(creator);
        address col = factory.launch{ value: 0 }("Free", "FREE", bytes32("s4"));
        assertEq(ERC721SeaDropCloneable(col).owner(), creator);
    }

    function testPredictMatchesLaunch() public {
        bytes32 salt = bytes32("predict");
        address predicted = factory.predict(salt, creator);
        vm.prank(creator);
        address col = factory.launch{ value: fee }("P", "P", salt);
        assertEq(col, predicted, "predicted != actual");
    }

    function testOnlyOwnerCanSetFee() public {
        vm.prank(creator);
        vm.expectRevert(PaidSeaDropCloneFactory.NotOwner.selector);
        factory.setLaunchFee(1 ether);

        vm.prank(platform);
        factory.setLaunchFee(0.5 ether);
        assertEq(factory.launchFee(), 0.5 ether);
    }

    function testOnlyOwnerCanSetRecipient() public {
        vm.prank(creator);
        vm.expectRevert(PaidSeaDropCloneFactory.NotOwner.selector);
        factory.setFeeRecipient(creator);

        vm.prank(platform);
        factory.setFeeRecipient(address(0x1234));
        assertEq(factory.feeRecipient(), address(0x1234));
    }

    function testDuplicateSaltReverts() public {
        vm.startPrank(creator);
        factory.launch{ value: fee }("A", "A", bytes32("dup"));
        vm.expectRevert(); // Clones: create2 collision
        factory.launch{ value: fee }("B", "B", bytes32("dup"));
        vm.stopPrank();
    }

    function testDifferentCreatorsSameSaltOk() public {
        address creator2 = address(0xBEEF);
        vm.deal(creator2, 1 ether);
        vm.prank(creator);
        address a = factory.launch{ value: fee }("A", "A", bytes32("same"));
        vm.prank(creator2);
        address b = factory.launch{ value: fee }("B", "B", bytes32("same"));
        assertTrue(a != b, "salt not namespaced by creator");
    }
}
