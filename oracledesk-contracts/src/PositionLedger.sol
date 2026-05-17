// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title PositionLedger
/// @notice On-chain audit trail for all Trader Agent positions.
///         Lives on Arc. Every Polymarket bet (executed on Polygon)
///         is recorded here with IPFS reasoning CID and SHA-256 hash.
///         This is the tamper-evident foundation of the Reasoning Layer.
contract PositionLedger is Ownable {

    // ── Enums ─────────────────────────────────────────────────────────────────

    enum PositionState { OPEN, CLOSED_WIN, CLOSED_LOSS, CLOSED_HEDGE }
    enum Side { YES, NO }

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Position {
        // Market identification
        bytes32 polymarketConditionId; // Polymarket's conditionId (bytes32)
        uint256 polymarketTokenId;     // CTF ERC-1155 tokenId of the share bought
        Side    side;                  // YES or NO

        // Trade details
        uint256 usdcSpent;            // USDC spent on Polygon (6 decimals)
        uint256 sharesReceived;       // CTF shares received
        uint256 entryPriceBps;        // Entry price in basis points (6800 = 68%)
        uint256 kellyFractionBps;     // Half-Kelly fraction used (basis points)
        uint256 edgeBps;              // Detected edge (agentP - marketP) in bps

        // Timestamps
        uint256 openedAt;             // Arc block timestamp when logged
        uint256 closedAt;             // 0 if still open

        // Reasoning proof
        string  reasoningCid;         // IPFS CID of the full reasoning trace
        bytes32 sha256Hash;           // SHA-256 of reasoning JSON (tamper proof)

        // Outcome
        PositionState state;
        int256        realisedPnl;    // USDC P&L (6 decimals, signed)

        // Cross-chain reference
        string  polygonTxHash;        // The Polygon tx where the bet was placed
        uint64  cctpNonce;            // CCTP transfer nonce that funded this bet
    }

    // ── State ─────────────────────────────────────────────────────────────────

    mapping(bytes32 => Position) public positions;  // positionId → Position
    bytes32[] public allPositionIds;

    // Lookup by Polymarket conditionId
    mapping(bytes32 => bytes32[]) public positionsByCondition;

    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Emitted when a new Polymarket bet is logged
    /// This is the primary event the Reasoning Layer subscribes to
    event PositionOpened(
        bytes32 indexed positionId,
        bytes32 indexed conditionId,
        uint256         tokenId,
        Side            side,
        uint256         usdcSpent,
        uint256         entryPriceBps,
        uint256         edgeBps,
        string          reasoningCid,
        bytes32         sha256Hash,
        string          polygonTxHash
    );

    /// @notice Emitted when a position is closed (market resolved or hedged)
    event PositionClosed(
        bytes32 indexed positionId,
        PositionState   state,
        int256          realisedPnl,
        uint256         closedAt
    );

    /// @notice The core tamper-evident event — identical to Layer 1's ReasoningPublished
    /// Both Market Maker and Trader Agent use the same event signature
    /// so the Reasoning Layer frontend can filter both from Arc
    event ReasoningPublished(
        bytes32 indexed positionId,
        address indexed agentWallet,
        string          ipfsCid,
        bytes32         sha256Hash,
        uint256         blockTimestamp
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _owner) Ownable(_owner) {}

    // ── Core function: log a new position ─────────────────────────────────────

    /// @notice Called by the agent backend immediately after placing a Polymarket bet.
    ///         The Polygon tx must already be confirmed before calling this.
    ///
    /// @param _conditionId      Polymarket conditionId (from their API)
    /// @param _tokenId          CTF ERC-1155 tokenId of the position
    /// @param _side             YES (0) or NO (1)
    /// @param _usdcSpent        USDC spent (6 decimals)
    /// @param _sharesReceived   CTF shares received
    /// @param _entryPriceBps    Entry price in basis points (6800 = 68%)
    /// @param _kellyFractionBps Half-Kelly fraction used (e.g. 125 = 1.25% of bankroll)
    /// @param _edgeBps          Edge detected (agentP - marketP) in bps
    /// @param _reasoningCid     IPFS CID of reasoning trace JSON
    /// @param _sha256Hash       SHA-256 of reasoning trace JSON
    /// @param _polygonTxHash    Polygon transaction hash of the bet
    /// @param _cctpNonce        CCTP nonce from the funding transfer

    function openPosition(
        bytes32        _conditionId,
        uint256        _tokenId,
        Side           _side,
        uint256        _usdcSpent,
        uint256        _sharesReceived,
        uint256        _entryPriceBps,
        uint256        _kellyFractionBps,
        uint256        _edgeBps,
        string calldata _reasoningCid,
        bytes32        _sha256Hash,
        string calldata _polygonTxHash,
        uint64         _cctpNonce
    )
        external
        onlyOwner
        returns (bytes32 positionId)
    {
        // Generate unique position ID
        positionId = keccak256(abi.encodePacked(
            _conditionId,
            _tokenId,
            _side,
            block.timestamp,
            msg.sender
        ));

        require(positions[positionId].openedAt == 0, "Position ID collision");

        // Store full position record
        positions[positionId] = Position({
            polymarketConditionId: _conditionId,
            polymarketTokenId:     _tokenId,
            side:                  _side,
            usdcSpent:             _usdcSpent,
            sharesReceived:        _sharesReceived,
            entryPriceBps:         _entryPriceBps,
            kellyFractionBps:      _kellyFractionBps,
            edgeBps:               _edgeBps,
            openedAt:              block.timestamp,
            closedAt:              0,
            reasoningCid:          _reasoningCid,
            sha256Hash:            _sha256Hash,
            state:                 PositionState.OPEN,
            realisedPnl:           0,
            polygonTxHash:         _polygonTxHash,
            cctpNonce:             _cctpNonce
        });

        allPositionIds.push(positionId);
        positionsByCondition[_conditionId].push(positionId);

        // Emit position opened event (Trader Agent scanner picks this up)
        emit PositionOpened(
            positionId,
            _conditionId,
            _tokenId,
            _side,
            _usdcSpent,
            _entryPriceBps,
            _edgeBps,
            _reasoningCid,
            _sha256Hash,
            _polygonTxHash
        );

        // Emit tamper-evident reasoning proof on Arc
        // Block timestamp proves this reasoning existed before market resolved
        emit ReasoningPublished(
            positionId,
            msg.sender,
            _reasoningCid,
            _sha256Hash,
            block.timestamp
        );
    }

    /// @notice Called when a position is closed (resolved or hedged early)
    ///
    /// @param _positionId     The position to close
    /// @param _state          How it closed (WIN, LOSS, HEDGE)
    /// @param _usdcReturned   USDC received back on Polygon (6 decimals)

    function closePosition(
        bytes32       _positionId,
        PositionState _state,
        uint256       _usdcReturned
    )
        external
        onlyOwner
    {
        Position storage pos = positions[_positionId];
        require(pos.openedAt > 0,                   "Position not found");
        require(pos.state == PositionState.OPEN,     "Position already closed");
        require(_state != PositionState.OPEN,        "Cannot close to OPEN state");

        pos.state       = _state;
        pos.closedAt    = block.timestamp;
        pos.realisedPnl = int256(_usdcReturned) - int256(pos.usdcSpent);

        emit PositionClosed(_positionId, _state, pos.realisedPnl, block.timestamp);
    }

    // ── View functions ────────────────────────────────────────────────────────

    function getPosition(bytes32 _positionId)
        external view
        returns (Position memory)
    {
        return positions[_positionId];
    }

    function getPositionsByCondition(bytes32 _conditionId)
        external view
        returns (bytes32[] memory)
    {
        return positionsByCondition[_conditionId];
    }

    function totalPositions() external view returns (uint256) {
        return allPositionIds.length;
    }

    function getAllPositionIds() external view returns (bytes32[] memory) {
        return allPositionIds;
    }

    /// @notice Returns open positions only
    function getOpenPositionIds() external view returns (bytes32[] memory) {
        uint256 count;
        for (uint256 i = 0; i < allPositionIds.length; i++) {
            if (positions[allPositionIds[i]].state == PositionState.OPEN) count++;
        }
        bytes32[] memory open = new bytes32[](count);
        uint256 idx;
        for (uint256 i = 0; i < allPositionIds.length; i++) {
            if (positions[allPositionIds[i]].state == PositionState.OPEN) {
                open[idx++] = allPositionIds[i];
            }
        }
        return open;
    }

    /// @notice Calculates total realised P&L across all closed positions
    function totalRealisedPnl() external view returns (int256 pnl) {
        for (uint256 i = 0; i < allPositionIds.length; i++) {
            Position storage pos = positions[allPositionIds[i]];
            if (pos.state != PositionState.OPEN) {
                pnl += pos.realisedPnl;
            }
        }
    }
}