// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ReasoningRegistry
/// @notice On-chain index of all OracleDesk reasoning traces.
///         Stores IPFS CID + SHA-256 hash for every agent decision.
///         Also tracks subscriber access rights for the x402 payment layer.
///         Deployed once on Arc Testnet.
contract ReasoningRegistry is Ownable {

    // ── Structs ───────────────────────────────────────────────────────────────

    struct TraceRecord {
        string  ipfsCid;          // IPFS CID of the full reasoning trace JSON
        bytes32 sha256Hash;       // SHA-256 of the trace JSON (tamper-evident)
        address agentWallet;      // Agent wallet that published this trace
        uint256 publishedAt;      // Arc block timestamp of publication
        string  traceType;        // "market_creation" | "trade" | "hedge" | "pass"
        bytes32 relatedId;        // positionId or marketId from Layer 1/2 contracts
        bool    exists;           // Guard for lookup
    }

    struct SubscriberRecord {
        uint256 tracesRead;       // Total traces read by this subscriber
        uint256 totalPaidUsdc;    // Total USDC paid (6 decimals, tracked off-chain and synced)
        uint256 firstAccessAt;    // Block timestamp of first access
        uint256 lastAccessAt;     // Block timestamp of most recent access
        bool    active;           // Whether subscriber has ever accessed
    }

    // ── State ─────────────────────────────────────────────────────────────────

    // traceId → TraceRecord
    // traceId = keccak256(ipfsCid) — deterministic, reproducible off-chain
    mapping(bytes32 => TraceRecord) public traces;

    // Ordered list of trace IDs (for pagination)
    bytes32[] public traceIds;

    // subscriber address → SubscriberRecord
    mapping(address => SubscriberRecord) public subscribers;

    // subscriber → traceId → whether they have paid to read this trace
    mapping(address => mapping(bytes32 => bool)) public traceAccess;

    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Emitted when the agent publishes a new reasoning trace
    /// This is the primary event for the Reasoning Layer frontend to index
    event ReasoningPublished(
        bytes32 indexed traceId,
        address indexed agentWallet,
        string  ipfsCid,
        bytes32 sha256Hash,
        string  traceType,
        bytes32 relatedId,
        uint256 blockTimestamp
    );

    /// @notice Emitted when a subscriber pays to access a trace
    /// Provides an on-chain audit trail of all paid accesses
    event TraceAccessed(
        bytes32 indexed traceId,
        address indexed subscriber,
        uint256 amountPaidUsdc,
        uint256 blockTimestamp
    );

    /// @notice Emitted when subscriber stats are updated
    event SubscriberUpdated(
        address indexed subscriber,
        uint256 totalTracesRead,
        uint256 totalPaidUsdc
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _owner) Ownable(_owner) {}

    // ── Core functions ────────────────────────────────────────────────────────

    /// @notice Called by the agent backend after pinning a trace to IPFS.
    ///         Records the CID + hash on Arc — this is the tamper-evident proof.
    ///
    /// @param _ipfsCid      IPFS Content Identifier of the reasoning trace JSON
    /// @param _sha256Hash   SHA-256 hash of the reasoning trace JSON
    /// @param _traceType    "market_creation" | "trade" | "hedge" | "pass"
    /// @param _relatedId    positionId (Layer 2) or marketId (Layer 1) this trace belongs to

    function publishTrace(
        string  calldata _ipfsCid,
        bytes32          _sha256Hash,
        string  calldata _traceType,
        bytes32          _relatedId
    )
        external
        onlyOwner
        returns (bytes32 traceId)
    {
        // Derive deterministic traceId from the CID
        // This means anyone can compute traceId = keccak256(cid) off-chain
        traceId = keccak256(bytes(_ipfsCid));

        require(!traces[traceId].exists, "Trace already published");

        traces[traceId] = TraceRecord({
            ipfsCid:     _ipfsCid,
            sha256Hash:  _sha256Hash,
            agentWallet: msg.sender,
            publishedAt: block.timestamp,
            traceType:   _traceType,
            relatedId:   _relatedId,
            exists:      true
        });

        traceIds.push(traceId);

        emit ReasoningPublished(
            traceId,
            msg.sender,
            _ipfsCid,
            _sha256Hash,
            _traceType,
            _relatedId,
            block.timestamp
        );
    }

    /// @notice Called by the API server after a subscriber successfully pays via x402.
    ///         Records access on-chain for the subscriber audit trail.
    ///
    /// @param _traceId         The trace that was accessed
    /// @param _subscriber      The subscriber wallet address
    /// @param _amountPaidUsdc  Amount paid in USDC (6 decimals)

    function recordAccess(
        bytes32 _traceId,
        address _subscriber,
        uint256 _amountPaidUsdc
    )
        external
        onlyOwner
    {
        require(traces[_traceId].exists, "Trace does not exist");

        // Mark this subscriber as having paid for this trace
        traceAccess[_subscriber][_traceId] = true;

        // Update subscriber stats
        SubscriberRecord storage sub = subscribers[_subscriber];
        if (!sub.active) {
            sub.active        = true;
            sub.firstAccessAt = block.timestamp;
        }
        sub.tracesRead     += 1;
        sub.totalPaidUsdc  += _amountPaidUsdc;
        sub.lastAccessAt    = block.timestamp;

        emit TraceAccessed(_traceId, _subscriber, _amountPaidUsdc, block.timestamp);
        emit SubscriberUpdated(_subscriber, sub.tracesRead, sub.totalPaidUsdc);
    }

    // ── View functions ────────────────────────────────────────────────────────

    /// @notice Returns a page of trace IDs (newest first)
    /// @param _offset Start index (0 = newest)
    /// @param _limit  Page size (max 50)
    function getTraceIds(uint256 _offset, uint256 _limit)
        external
        view
        returns (bytes32[] memory page, uint256 total)
    {
        total = traceIds.length;
        if (_offset >= total) return (new bytes32[](0), total);

        uint256 end   = total - _offset;
        uint256 start = end > _limit ? end - _limit : 0;
        uint256 size  = end - start;

        page = new bytes32[](size);
        for (uint256 i = 0; i < size; i++) {
            // Reverse order — newest first
            page[i] = traceIds[end - 1 - i];
        }
    }

    /// @notice Returns the full TraceRecord for a given traceId
    function getTrace(bytes32 _traceId)
        external
        view
        returns (TraceRecord memory)
    {
        require(traces[_traceId].exists, "Trace not found");
        return traces[_traceId];
    }

    /// @notice Returns total number of published traces
    function totalTraces() external view returns (uint256) {
        return traceIds.length;
    }

    /// @notice Check if a subscriber has paid for a specific trace
    function hasAccess(address _subscriber, bytes32 _traceId)
        external
        view
        returns (bool)
    {
        return traceAccess[_subscriber][_traceId];
    }

    /// @notice Returns subscriber stats
    function getSubscriber(address _subscriber)
        external
        view
        returns (SubscriberRecord memory)
    {
        return subscribers[_subscriber];
    }

    /// @notice Verifies a trace on-chain: recomputes traceId and checks hash
    ///         Returns true if the IPFS CID produces the stored hash match
    /// @param _ipfsCid    The CID to verify
    /// @param _sha256Hash The hash claimed to match this CID's content
    function verifyTrace(string calldata _ipfsCid, bytes32 _sha256Hash)
        external
        view
        returns (bool valid, uint256 publishedAt)
    {
        bytes32 traceId = keccak256(bytes(_ipfsCid));
        TraceRecord memory record = traces[traceId];

        if (!record.exists) return (false, 0);

        valid       = record.sha256Hash == _sha256Hash;
        publishedAt = record.publishedAt;
    }
}