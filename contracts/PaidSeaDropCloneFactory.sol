// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ERC721SeaDropCloneable } from "./ERC721SeaDropCloneable.sol";

import { Clones } from "openzeppelin-contracts/proxy/Clones.sol";

/**
 * @title  PaidSeaDropCloneFactory
 * @notice A LaunchPad monetization wrapper around OpenSea's
 *         ERC721SeaDropCloneFactory. It deploys minimal-proxy clones of a
 *         single ERC721SeaDropCloneable implementation (so there is no
 *         contract-size problem and every collection is a real,
 *         OpenSea-compatible SeaDrop token), while charging a flat launch fee
 *         in native ETH that goes to the platform's fee recipient.
 *
 *         The clone is initialized with the CALLER as its owner in the same
 *         transaction (one-step), so the creator immediately controls their
 *         collection — no acceptOwnership step, launch stays two transactions
 *         (this call, then multiConfigure by the owner).
 *
 *         NOTE ON ENFORCEMENT: the SeaDrop system is permissionless and
 *         open-source. This factory makes the fee unavoidable for anyone using
 *         it, but it cannot stop a determined user from deploying a SeaDrop
 *         token directly and bypassing the factory entirely. It monetizes the
 *         convenience, not a monopoly.
 */
contract PaidSeaDropCloneFactory {
    /// @notice The shared implementation every clone points at.
    address public immutable seaDropCloneableImplementation;

    address public constant DEFAULT_SEADROP =
        0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;

    /// @notice Platform owner — may change the fee and recipient.
    address public owner;

    /// @notice Flat fee (wei) charged per launch.
    uint256 public launchFee;

    /// @notice Where collected fees are sent.
    address public feeRecipient;

    /// @dev Simple non-reentrancy latch.
    uint256 private _locked = 1;

    event CollectionLaunched(
        address indexed collection,
        address indexed creator,
        uint256 feePaid
    );
    event LaunchFeeUpdated(uint256 newFee);
    event FeeRecipientUpdated(address newRecipient);
    event OwnerUpdated(address newOwner);

    error NotOwner();
    error Reentrancy();
    error InsufficientFee(uint256 sent, uint256 required);
    error ZeroAddress();
    error FeeTransferFailed();
    error RefundFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(uint256 initialLaunchFee, address initialFeeRecipient) {
        if (initialFeeRecipient == address(0)) revert ZeroAddress();
        owner = msg.sender;
        launchFee = initialLaunchFee;
        feeRecipient = initialFeeRecipient;

        // Deploy the one implementation all clones delegate to.
        ERC721SeaDropCloneable impl = new ERC721SeaDropCloneable();
        impl.initialize("", "", new address[](0), address(this));
        seaDropCloneableImplementation = address(impl);

        emit LaunchFeeUpdated(initialLaunchFee);
        emit FeeRecipientUpdated(initialFeeRecipient);
        emit OwnerUpdated(msg.sender);
    }

    /**
     * @notice Launch a new collection. Pays the flat launch fee, deploys a
     *         SeaDrop clone owned by the caller, and refunds any overpayment.
     *
     * @param name   Collection name.
     * @param symbol Collection symbol.
     * @param salt   Caller-supplied salt for the deterministic clone address.
     *
     * @return collection The deployed collection address.
     */
    function launch(
        string calldata name,
        string calldata symbol,
        bytes32 salt
    ) external payable nonReentrant returns (address collection) {
        uint256 fee = launchFee;
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);

        // ── Effects/deploy ───────────────────────────────────────────────
        bytes32 cloneSalt = keccak256(abi.encodePacked(salt, msg.sender));
        collection = Clones.cloneDeterministic(
            seaDropCloneableImplementation,
            cloneSalt
        );
        address[] memory allowedSeaDrop = new address[](1);
        allowedSeaDrop[0] = DEFAULT_SEADROP;
        // Caller becomes owner immediately (one-step) — no acceptOwnership.
        ERC721SeaDropCloneable(collection).initialize(
            name,
            symbol,
            allowedSeaDrop,
            msg.sender
        );

        emit CollectionLaunched(collection, msg.sender, fee);

        // ── Interactions (last) ──────────────────────────────────────────
        if (fee > 0) {
            (bool feeOk, ) = feeRecipient.call{ value: fee }("");
            if (!feeOk) revert FeeTransferFailed();
        }
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool refundOk, ) = msg.sender.call{ value: refund }("");
            if (!refundOk) revert RefundFailed();
        }
    }

    /// @notice Predict the clone address for a salt + caller (UI convenience).
    function predict(bytes32 salt, address creator)
        external
        view
        returns (address)
    {
        return
            Clones.predictDeterministicAddress(
                seaDropCloneableImplementation,
                keccak256(abi.encodePacked(salt, creator))
            );
    }

    // ── Owner controls ───────────────────────────────────────────────────

    function setLaunchFee(uint256 newFee) external onlyOwner {
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }
}
