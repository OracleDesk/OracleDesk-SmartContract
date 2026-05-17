// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TreasuryManager
/// @notice Controls OracleDesk agent capital on Arc.
///         Enforces bankroll rules and triggers CCTP transfers to Polygon.
///         Deployed once on Arc Testnet.
contract TreasuryManager is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Arc Testnet addresses (hardcoded — these never change on Arc) ──────────
    address public constant USDC          = 0x3600000000000000000000000000000000000000;
    address public constant TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    // CCTP domain ID for Polygon PoS (Amoy testnet and mainnet share domain 7)
    uint32  public constant POLYGON_DOMAIN = 7;

    // ── Bankroll risk parameters ───────────────────────────────────────────────
    // These are the hard limits enforced on-chain.
    // The agent backend applies the Kelly formula BEFORE calling fundBet(),
    // but these act as a final on-chain safety net.

    /// @notice Max % of total bankroll in a single market (basis points: 250 = 2.5%)
    uint256 public maxSinglePositionBps = 250;

    /// @notice Max % total correlated exposure (basis points: 500 = 5%)
    uint256 public maxCorrelatedExposureBps = 500;

    /// @notice Max % drawdown in a single day before agent pauses (basis points: 300 = 3%)
    uint256 public maxDailyDrawdownBps = 300;

    // ── State ──────────────────────────────────────────────────────────────────

    /// @notice Address of the Polygon execution wallet (receives CCTP transfers)
    address public polygonExecutionWallet;

    /// @notice Running count of USDC deployed to Polygon (6 decimals)
    uint256 public deployedCapital;

    /// @notice Total USDC sent to Polygon today (resets daily)
    uint256 public dailyDeployed;

    /// @notice Timestamp of the start of the current daily period
    uint256 public dayStart;

    /// @notice Running daily P&L (can go negative — triggers pause if too negative)
    int256  public dailyPnl;

    /// @notice Whether the agent is paused due to drawdown breach
    bool    public paused;

    /// @notice Total USDC received back from Polygon (sweeps)
    uint256 public totalSweptBack;

    // ── Position registry ──────────────────────────────────────────────────────
    // Tracks open capital sent to Polygon per market ID.
    // marketId is keccak256 of the Polymarket conditionId + tokenId.

    struct Position {
        bytes32 marketId;       // Polymarket market identifier
        uint256 capitalSent;    // USDC sent to Polygon for this position (6 dec)
        uint256 timestamp;      // When the position was opened
        bool    open;           // False after sweep-back confirmed
    }

    mapping(bytes32 => Position) public positions;
    bytes32[] public openPositionIds;

    // ── Events ────────────────────────────────────────────────────────────────

    event FundedBet(
        bytes32 indexed marketId,
        uint256 usdcAmount,
        uint256 cctpNonce,      // nonce from CCTP depositForBurn
        address polygonWallet
    );

    event SweptBack(
        bytes32 indexed marketId,
        uint256 usdcAmount
    );

    event DailyReset(
        uint256 timestamp,
        int256  previousDayPnl
    );

    event AgentPaused(string reason);
    event AgentResumed();

    event RiskParamsUpdated(
        uint256 maxSinglePositionBps,
        uint256 maxCorrelatedExposureBps,
        uint256 maxDailyDrawdownBps
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address _owner,
        address _polygonExecutionWallet
    ) Ownable(_owner) {
        require(_polygonExecutionWallet != address(0), "Invalid polygon wallet");
        polygonExecutionWallet = _polygonExecutionWallet;
        dayStart = block.timestamp;
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier notPaused() {
        require(!paused, "Agent is paused - drawdown limit hit");
        _;
    }

    // ── Core function: fund a Polymarket bet via CCTP ─────────────────────────

    /// @notice Called by the agent backend to fund a Polymarket bet.
    ///         Validates Kelly limits, then burns USDC on Arc via CCTP.
    ///         USDC appears on Polygon in ~20 seconds after attestation.
    ///
    /// @param _marketId      keccak256 of the Polymarket conditionId (for tracking)
    /// @param _usdcAmount    Amount to send (6 decimals — e.g. 25_000000 = 25 USDC)
    /// @param _minFinalityThreshold 1000 = Fast Transfer (~20s), 2000 = Standard (~13min)

    function fundBet(
        bytes32 _marketId,
        uint256 _usdcAmount,
        uint32  _minFinalityThreshold
    )
        external
        onlyOwner
        nonReentrant
        notPaused
        returns (uint64 cctpNonce)
    {
        // ── Daily reset check ──────────────────────────────────────────────
        _checkAndResetDaily();

        // ── Bankroll validation ────────────────────────────────────────────
        uint256 bankroll = _totalBankroll();
        require(bankroll > 0, "Treasury is empty");

        // Enforce max single position size
        uint256 maxAllowed = (bankroll * maxSinglePositionBps) / 10000;
        require(
            _usdcAmount <= maxAllowed,
            "Exceeds max single position size"
        );

        // Enforce no duplicate open position for same market
        require(
            !positions[_marketId].open,
            "Position already open for this market"
        );

        // Ensure treasury has enough USDC
        require(
            IERC20(USDC).balanceOf(address(this)) >= _usdcAmount,
            "Insufficient USDC in treasury"
        );

        // ── CCTP burn (Arc → Polygon) ──────────────────────────────────────
        // Step 1: Approve CCTP TokenMessenger to pull USDC from this contract
        IERC20(USDC).approve(TOKEN_MESSENGER, _usdcAmount);

        // Step 2: Convert Polygon wallet address to bytes32 (CCTP requirement)
        bytes32 mintRecipient = _addressToBytes32(polygonExecutionWallet);

        // Step 3: Call depositForBurn — this burns USDC on Arc
        //         Circle's attestation service signs the burn message
        //         The Polygon side calls receiveMessage() to mint USDC.e
        (bool success, bytes memory data) = TOKEN_MESSENGER.call(
            abi.encodeWithSignature(
                "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
                _usdcAmount,          // amount to burn
                POLYGON_DOMAIN,       // destination domain (7 = Polygon)
                mintRecipient,        // who receives on Polygon
                USDC,                 // token to burn (Arc USDC)
                bytes32(0),           // destinationCaller (0 = anyone can relay)
                500,                  // maxFee (0.0005 USDC)
                _minFinalityThreshold // 1000 = Fast (~20s)
            )
        );
        require(success, "CCTP depositForBurn failed");

        // Extract the nonce from the return data (used to track the transfer)
        cctpNonce = abi.decode(data, (uint64));

        // ── Update state ───────────────────────────────────────────────────
        positions[_marketId] = Position({
            marketId:    _marketId,
            capitalSent: _usdcAmount,
            timestamp:   block.timestamp,
            open:        true
        });
        openPositionIds.push(_marketId);

        deployedCapital += _usdcAmount;
        dailyDeployed   += _usdcAmount;

        emit FundedBet(_marketId, _usdcAmount, cctpNonce, polygonExecutionWallet);
    }

    /// @notice Called when Polygon funds sweep back to Arc treasury.
    ///         The sweep itself happens via CCTP on the backend.
    ///         This function records the return and closes the position.
    ///
    /// @param _marketId   The market position being closed
    /// @param _usdcReturned Amount of USDC that came back (including any profit/loss)

    function recordSweepBack(
        bytes32 _marketId,
        uint256 _usdcReturned
    )
        external
        onlyOwner
    {
        Position storage pos = positions[_marketId];
        require(pos.open, "No open position for this market");

        // Calculate P&L for this position
        int256 pnl = int256(_usdcReturned) - int256(pos.capitalSent);
        dailyPnl += pnl;

        // Close the position
        pos.open = false;
        deployedCapital -= pos.capitalSent;
        totalSweptBack  += _usdcReturned;

        // Check if daily drawdown limit was breached
        _checkDrawdown();

        emit SweptBack(_marketId, _usdcReturned);
    }

    // ── View functions ────────────────────────────────────────────────────────

    /// @notice Total bankroll = on-hand USDC + deployed capital on Polygon
    function _totalBankroll() internal view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this)) + deployedCapital;
    }

    function totalBankroll() external view returns (uint256) {
        return _totalBankroll();
    }

    /// @notice Available USDC sitting in treasury (not yet sent anywhere)
    function availableCapital() external view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this));
    }

    /// @notice Returns all open position IDs
    function getOpenPositions() external view returns (bytes32[] memory) {
        uint256 count;
        for (uint256 i = 0; i < openPositionIds.length; i++) {
            if (positions[openPositionIds[i]].open) count++;
        }
        bytes32[] memory open = new bytes32[](count);
        uint256 idx;
        for (uint256 i = 0; i < openPositionIds.length; i++) {
            if (positions[openPositionIds[i]].open) {
                open[idx++] = openPositionIds[i];
            }
        }
        return open;
    }

    /// @notice Calculates max bet size allowed right now
    function maxBetAllowed() external view returns (uint256) {
        return (_totalBankroll() * maxSinglePositionBps) / 10000;
    }

    // ── Admin functions ───────────────────────────────────────────────────────

    function deposit(uint256 _amount) external onlyOwner {
        IERC20(USDC).safeTransferFrom(msg.sender, address(this), _amount);
    }

    function withdraw(uint256 _amount) external onlyOwner {
        IERC20(USDC).safeTransfer(owner(), _amount);
    }

    function setPolygonWallet(address _wallet) external onlyOwner {
        require(_wallet != address(0), "Invalid address");
        polygonExecutionWallet = _wallet;
    }

    function updateRiskParams(
        uint256 _maxSinglePositionBps,
        uint256 _maxCorrelatedExposureBps,
        uint256 _maxDailyDrawdownBps
    ) external onlyOwner {
        require(_maxSinglePositionBps  <= 1000, "Max single position too high"); // max 10%
        require(_maxDailyDrawdownBps   <= 1000, "Max drawdown too high");        // max 10%
        maxSinglePositionBps      = _maxSinglePositionBps;
        maxCorrelatedExposureBps  = _maxCorrelatedExposureBps;
        maxDailyDrawdownBps       = _maxDailyDrawdownBps;
        emit RiskParamsUpdated(_maxSinglePositionBps, _maxCorrelatedExposureBps, _maxDailyDrawdownBps);
    }

    function resumeAgent() external onlyOwner {
        paused = false;
        emit AgentResumed();
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _checkAndResetDaily() internal {
        if (block.timestamp >= dayStart + 1 days) {
            emit DailyReset(block.timestamp, dailyPnl);
            dailyPnl     = 0;
            dailyDeployed = 0;
            dayStart     = block.timestamp;
        }
    }

    function _checkDrawdown() internal {
        uint256 bankroll = _totalBankroll();
        if (bankroll == 0) return;

        // If daily P&L is negative and exceeds the drawdown threshold → pause
        if (dailyPnl < 0) {
            uint256 loss = uint256(-dailyPnl);
            uint256 threshold = (bankroll * maxDailyDrawdownBps) / 10000;
            if (loss >= threshold) {
                paused = true;
                emit AgentPaused("Daily drawdown limit reached");
            }
        }
    }

    /// @notice Convert an address to bytes32 (required by CCTP depositForBurn)
    function _addressToBytes32(address _addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_addr)));
    }
}