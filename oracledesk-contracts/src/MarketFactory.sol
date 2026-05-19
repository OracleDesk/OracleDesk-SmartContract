// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./PredictionMarket.sol";

contract MarketFactory is Ownable {
    using SafeERC20 for IERC20;

    // Arc Testnet USDC ERC-20 — 6 decimals
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    // Registry of all deployed markets
    address[] public allMarkets;

    // Lookup by question hash (prevents duplicate markets for same event)
    mapping(bytes32 => address) public marketByQuestion;

    // ── Events ────────────────────────────────────────────────────────────────

    event MarketDeployed(
        address indexed market,
        string          question,
        address         oracle,
        uint256         expiryTimestamp,
        uint256         initialYesPrice,
        uint256         liquiditySeed,
        string          reasoningCid
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _owner) Ownable(_owner) {}

    // ── Core Function — called by the agent backend ───────────────────────────

    // Creates a new PredictionMarket for a given event
    //
    // Parameters:
    //   _question         — The binary question (must end with "?")
    //   _oracle           — Address authorised to call resolve() — this is the
    //                       OracleDesk oracle account, not Chainlink (for hackathon)
    //   _expiryTimestamp  — Unix timestamp after which the market can be resolved
    //   _initialYesPrice  — Agent's probability estimate in basis points (6800 = 68%)
    //   _liquiditySeedUsdc— USDC to deposit as initial AMM liquidity (6 decimals)
    //   _agentWallet      — Address of the agent wallet (for event attribution)
    //   _reasoningCid     — IPFS CID of the creation reasoning trace
    //   _sha256Hash       — SHA-256 hash of the reasoning trace JSON


    /// @notice ORACLE UPGRADE PATH
    /// Current (hackathon): MultiSigOracle — team manually verifies and resolves
    ///   after checking official data sources (BLS, Fed, AP Elections)
    ///
    /// Production v1: Chainlink Functions adapter
    ///   → Fetches official data endpoint → parses result → calls resolve()
    ///   → Requires Chainlink Functions on Arc (roadmap item)
    ///
    /// Production v2: UMA Optimistic Oracle
    ///   → 48-hour dispute window → community verification
    ///   → Already used by Polymarket for complex event resolution
    ///
    /// The oracle address is set per-market at creation time.
    /// Upgrading oracle type = updating the address passed to createMarket().
    /// No contract redeployment needed.
    function createMarket(
        string  calldata _question,
        address          _oracle,
        uint256          _expiryTimestamp,
        uint256          _initialYesPrice,
        uint256          _liquiditySeedUsdc,
        address          _agentWallet,
        string  calldata _reasoningCid,
        bytes32          _sha256Hash,
        uint256          _confidenceIntervalBps
    )
        external
        onlyOwner
        returns (address marketAddress)
    {
        // Prevent duplicate markets for the same question
        bytes32 questionHash = keccak256(bytes(_question));
        require(
            marketByQuestion[questionHash] == address(0),
            "Market for this question already exists"
        );

        // Validate liquidity seed is available in this contract
        // The agent backend must have transferred USDC to the factory
        // before calling createMarket
        require(
            IERC20(USDC).balanceOf(address(this)) >= _liquiditySeedUsdc,
            "Insufficient USDC in factory for liquidity seed"
        );

        // Deploy the market
        PredictionMarket market = new PredictionMarket(
            _question,
            _oracle,
            _expiryTimestamp,
            _initialYesPrice,
            _liquiditySeedUsdc,
            _agentWallet,
            _reasoningCid,
            _sha256Hash,
            _confidenceIntervalBps
        );

        marketAddress = address(market);

        // Transfer liquidity seed to the market
        // Factory owns USDC and transfers directly to market (no approval needed)
        IERC20(USDC).safeTransfer(address(market), _liquiditySeedUsdc);

        // Initialize the market with liquidity reserves
        market.initialize(_liquiditySeedUsdc);

        marketAddress = address(market);

        // Register in the factory registry
        allMarkets.push(marketAddress);
        marketByQuestion[questionHash] = marketAddress;

        emit MarketDeployed(
            marketAddress,
            _question,
            _oracle,
            _expiryTimestamp,
            _initialYesPrice,
            _liquiditySeedUsdc,
            _reasoningCid
        );
    }

    // ── View Functions ─────────────────────────────────────────────────────────

    // Returns total number of markets created
    function totalMarkets() external view returns (uint256) {
        return allMarkets.length;
    }

    // Returns all market addresses (used by Trader Agent scanner)
    function getAllMarkets() external view returns (address[] memory) {
        return allMarkets;
    }

    // Checks if a market exists for a question
    function marketExists(string calldata _question) external view returns (bool) {
        return marketByQuestion[keccak256(bytes(_question))] != address(0);
    }

    // ── Treasury Management ────────────────────────────────────────────────────

    // The agent backend calls this to deposit USDC into the factory
    // before calling createMarket. Alternatively, send USDC directly.
    function depositLiquidity(uint256 _amount) external onlyOwner {
        IERC20(USDC).safeTransferFrom(msg.sender, address(this), _amount);
    }

    // Withdraw unused USDC back to the agent wallet
    function withdrawLiquidity(uint256 _amount) external onlyOwner {
        IERC20(USDC).safeTransfer(owner(), _amount);
    }

    // Publish a reasoning trace on an existing market (for trade traces)
    function publishReasoning(
        address _market,
        address _agentWallet,
        string  calldata _ipfsCid,
        bytes32 _sha256Hash
    ) external onlyOwner {
        PredictionMarket(_market).publishReasoning(
            _agentWallet,
            _ipfsCid,
            _sha256Hash
        );
    }

    /// @notice Agent updates its probability estimate on a live market
    function updateMarketProbability(
        address _market,
        uint256 _newProbabilityBps,
        uint256 _newConfidenceIntervalBps
    ) external onlyOwner {
        PredictionMarket(_market).updateAgentProbability(
            _newProbabilityBps,
            _newConfidenceIntervalBps
        );
    }

    /// @notice Agent rebalances liquidity if market has drifted
    function rebalanceMarket(address _market) external onlyOwner {
        PredictionMarket(_market).rebalanceLiquidity();
    }
}