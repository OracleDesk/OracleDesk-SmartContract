// SPDX-License-Identifier: MIT
pragma solidity ^0.8.15;

// src/interfaces/IPolymarket.sol
// Reference-only — DO NOT deploy these. They are Polymarket's existing contracts.

enum Side { BUY, SELL }

enum SignatureType {
    EOA,          // Standard ECDSA EIP-712 — use this for your agent wallet
    POLY_PROXY,   // Polymarket proxy wallet
    POLY_GNOSIS_SAFE
}

/// @notice The order struct that your agent signs via EIP-712
/// This is what gets submitted to Polymarket's API
struct Order {
    uint256 salt;           // Random uint256 for uniqueness
    address maker;          // Your Polygon execution wallet address
    address signer;         // Same as maker for EOA
    address taker;          // address(0) = public order (any taker)
    uint256 tokenId;        // CTF ERC-1155 tokenId of the outcome share
    uint256 makerAmount;    // USDC amount you're spending (6 decimals)
    uint256 takerAmount;    // Shares you expect to receive
    uint256 expiration;     // Unix timestamp — order expires here
    uint256 nonce;          // Must be 0 for new orders
    uint256 feeRateBps;     // Fee in basis points (usually 0 — fee is in makerAmount)
    Side    side;           // BUY (buying outcome shares) or SELL
    SignatureType signatureType; // EOA for your agent
}

/// @notice EIP-712 domain separator for Polymarket CTF Exchange
/// You use this to compute the typed hash before signing
/// Domain name: "CTF Exchange"   Version: "1"
/// Chain ID: 137 (Polygon mainnet) or 80002 (Polygon Amoy testnet)
/// Verifying contract: CTF Exchange address

interface ICTFExchange {
    /// @notice Called by Polymarket's operator to settle matched orders
    /// You do NOT call this directly — Polymarket does after matching your API order
    function fillOrder(Order calldata order, uint256 fillAmount) external;

    /// @notice The EIP-712 domain separator (useful for signing verification)
    function domainSeparator() external view returns (bytes32);
}