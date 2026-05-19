// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ─── YES / NO Share Tokens ────────────────────────────────────────────────────
// Each market deploys two lightweight ERC-20 tokens representing YES and NO
// positions. They are minted by the market and burned on resolution.

contract ShareToken is ERC20 {
    address public immutable market;

    constructor(string memory name, string memory symbol)
        ERC20(name, symbol)
    {
        market = msg.sender;
    }

    modifier onlyMarket() {
        require(msg.sender == market, "Only market");
        _;
    }

    function mint(address to, uint256 amount) external onlyMarket {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMarket {
        _burn(from, amount);
    }
}

// ─── PredictionMarket ─────────────────────────────────────────────────────────

contract PredictionMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── State ─────────────────────────────────────────────────────────────────

    // Arc Testnet USDC ERC-20 address (6 decimals)
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    ShareToken public yesToken;
    ShareToken public noToken;

    string  public question;         // "Will the Fed raise rates at the June 12 meeting?"
    address public oracle;           // Who can call resolve()
    address public factory;          // MarketFactory that deployed this market
    uint256 public expiryTimestamp;  // Unix timestamp — market closes at this time
    uint256 public initialYesPrice;  // Initial YES price as basis points (0–10000 = 0%–100%)

    // Liquidity pool — simple constant-product AMM (x * y = k)
    uint256 public yesReserve;       // USDC worth of YES liquidity
    uint256 public noReserve;        // USDC worth of NO liquidity

    // Resolution
    bool public resolved;
    bool public resolvedYes; // true = YES wins, false = NO wins

    // On-chain reasoning proof
    string public reasoningCid;      // IPFS CID of the creation trace

    // Initialization flag
    bool public initialized;

    // ── Dynamic spread and liquidity management ───────────────────────────────────
    // Add these below the existing state variables in PredictionMarket.sol

    /// @notice Agent's current probability estimate in basis points (6800 = 68%)
    /// Updated by the Market Maker Agent as new signals arrive
    uint256 public agentProbabilityBps;

    /// @notice Agent's confidence interval — determines spread width
    /// Wider interval = wider spread = higher cost to trade
    uint256 public confidenceIntervalBps; // e.g. 800 = ±8% confidence interval

    /// @notice Minimum spread in basis points (floor)
    /// Prevents liquidity from being extracted in extremely thin markets
    uint256 public constant MIN_SPREAD_BPS = 50;   // 0.5% minimum spread

    /// @notice Maximum spread in basis points (ceiling)
    uint256 public constant MAX_SPREAD_BPS = 1000; // 10% maximum spread

    /// @notice Timestamp when agent last updated its probability estimate
    uint256 public lastAgentUpdate;

    /// @notice Fee collected from trades — stays in pool, benefits liquidity providers
    uint256 public accumulatedFees;

    /// @notice Rebalance threshold — how far price must drift before agent rebalances
    /// 500 = agent rebalances if market price drifts more than 5% from its estimate
    uint256 public rebalanceThresholdBps = 500;

    // ── Events ────────────────────────────────────────────────────────────────

    // Emitted on deployment — indexed by the Trader Agent scanner
    event MarketCreated(
        address indexed market,
        string  question,
        address oracle,
        uint256 expiryTimestamp,
        uint256 initialYesPrice,
        string  reasoningCid
    );

    // Emitted on every trade — used for liquidity depth tracking
    event Trade(
        address indexed trader,
        bool    buyYes,
        uint256 usdcIn,
        uint256 sharesOut
    );

    // Emitted on resolution — Trader Agent stops monitoring after this
    event MarketResolved(bool yesWon);

    // Emitted when winning shares are redeemed for USDC
    event Redeemed(address indexed redeemer, uint256 usdcOut);

    // Emitted when the Reasoning Layer publishes a trace hash on-chain
    // (also used by the creation trace — reasoning for market creation)
    event ReasoningPublished(
        address indexed market,
        address indexed agentWallet,
        string  ipfsCid,
        bytes32 sha256Hash,
        uint256 blockTimestamp
    );

    event AgentProbabilityUpdated(
        uint256 newProbabilityBps,
        uint256 newConfidenceIntervalBps,
        uint256 timestamp
    );

    event LiquidityRebalanced(
        uint256 oldYesReserve,
        uint256 oldNoReserve,
        uint256 newYesReserve,
        uint256 newNoReserve,
        uint256 agentProbabilityBps
    );

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle");
        _;
    }

    modifier notResolved() {
        require(!resolved, "Market already resolved");
        _;
    }

    modifier notExpired() {
        require(block.timestamp < expiryTimestamp, "Market expired");
        _;
    }

    modifier isExpired() {
        require(block.timestamp >= expiryTimestamp, "Market not yet expired");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    // Called by MarketFactory only

    constructor(
        string  memory _question,
        address        _oracle,
        uint256        _expiryTimestamp,
        uint256        _initialYesPrice,    // basis points: 6800 = 68%
        uint256        _liquiditySeedUsdc,  // in USDC (6 decimals): 100_000000 = 100 USDC
        address        _agentWallet,
        string  memory _reasoningCid,
        bytes32        _sha256Hash,
        uint256        _confidenceIntervalBps
    ) {
        require(_oracle != address(0),            "Oracle cannot be zero address");
        require(_expiryTimestamp > block.timestamp,"Expiry must be in the future");
        require(_initialYesPrice > 0 &&
                _initialYesPrice < 10000,          "Price must be between 0 and 10000 bps");
        require(_liquiditySeedUsdc >= 10 * 1e6,   "Minimum seed is 10 USDC");

        question        = _question;
        oracle          = _oracle;
        expiryTimestamp = _expiryTimestamp;
        initialYesPrice = _initialYesPrice;
        factory         = msg.sender;
        reasoningCid    = _reasoningCid;
        agentProbabilityBps      = _initialYesPrice;
        confidenceIntervalBps    = _confidenceIntervalBps;
        lastAgentUpdate          = block.timestamp;

        // Deploy YES and NO share tokens
        // Names are derived from the question for readability in the explorer
        yesToken = new ShareToken("OracleDesk YES", "OD-YES");
        noToken  = new ShareToken("OracleDesk NO",  "OD-NO");

        // Publish reasoning trace hash on-chain
        // This is the tamper-evident proof that the creation reasoning existed
        // before the market resolved
        emit ReasoningPublished(
            address(this),
            _agentWallet,
            _reasoningCid,
            _sha256Hash,
            block.timestamp
        );
    }

    // ── Initialization ────────────────────────────────────────────────────────
    // Called by MarketFactory after USDC transfer

    function initialize(uint256 _liquiditySeedUsdc) external {
        require(msg.sender == factory, "Only factory");
        require(!initialized, "Already initialized");
        require(_liquiditySeedUsdc >= 10 * 1e6, "Minimum seed is 10 USDC");

        // Verify that we received the expected amount of USDC
        require(
            IERC20(USDC).balanceOf(address(this)) >= _liquiditySeedUsdc,
            "Market did not receive liquidity seed"
        );

        initialized = true;

        // Split seed into YES and NO reserves according to initial probability
        // e.g. 68% YES price → 68% of seed goes to YES reserve, 32% to NO reserve
        // This sets the initial AMM price at the agent's estimated probability
        yesReserve = (_liquiditySeedUsdc * initialYesPrice) / 10000;
        noReserve  = _liquiditySeedUsdc - yesReserve;

        // Mint initial share tokens for the liquidity reserves
        // 1 share = 1 USDC of reserve at initialization
        yesToken.mint(address(this), yesReserve);
        noToken.mint(address(this), noReserve);

        // Emit creation event
        emit MarketCreated(
            address(this),
            question,
            oracle,
            expiryTimestamp,
            initialYesPrice,
            reasoningCid
        );
    }

    // ── View Functions ────────────────────────────────────────────────────────

    // Returns current YES price as basis points (0–10000)
    // Derived from constant-product AMM: price = yesReserve / (yesReserve + noReserve)
    function currentYesPrice() public view returns (uint256) {
        if (yesReserve == 0 && noReserve == 0) return 0;
        return (yesReserve * 10000) / (yesReserve + noReserve);
    }

    // Returns total USDC locked in the market
    function totalLiquidity() public view returns (uint256) {
        return yesReserve + noReserve;
    }

    // Returns market metadata as a single call (used by Trader Agent scanner)
    function getMarketInfo() external view returns (
        string  memory _question,
        address        _oracle,
        uint256        _expiryTimestamp,
        uint256        _yesPrice,
        uint256        _liquidity,
        bool           _resolved,
        bool           _resolvedYes,
        string  memory _reasoningCid
    ) {
        return (
            question,
            oracle,
            expiryTimestamp,
            currentYesPrice(),
            totalLiquidity(),
            resolved,
            resolvedYes,
            reasoningCid
        );
    }

    // ── Trading ───────────────────────────────────────────────────────────────

    /// @notice Buy YES or NO shares with USDC.
    ///         Applies dynamic spread — a portion of USDC goes to the fee pool,
    ///         the rest enters the AMM. This makes the effective price slightly
    ///         worse than raw AMM price, with spread width determined by
    ///         agent confidence, liquidity depth, and time to expiry.
    ///
    /// @param _buyYes       true = buy YES shares, false = buy NO shares
    /// @param _usdcIn       USDC to spend (6 decimals)
    /// @param _minSharesOut Slippage protection — revert if fewer shares than this

    function buy(
        bool    _buyYes,
        uint256 _usdcIn,
        uint256 _minSharesOut
    )
        external
        nonReentrant
        notResolved
        notExpired
        returns (uint256 sharesOut)
    {
        require(_usdcIn >= 1e4, "Minimum trade is 0.01 USDC");

        IERC20(USDC).safeTransferFrom(msg.sender, address(this), _usdcIn);

        // ── Apply dynamic spread ───────────────────────────────────────────────
        // Spread fee is taken from usdcIn before entering the AMM.
        // This makes the trade slightly more expensive than raw AMM,
        // with the fee staying in the pool as accumulated reserves.
        //
        // Example: 10 USDC trade with 100 bps spread →
        //   fee = 10 * 100 / 10000 = 0.10 USDC
        //   AMM input = 9.90 USDC
        //
        uint256 spreadBps    = currentSpreadBps();
        uint256 spreadFee    = (_usdcIn * spreadBps) / 10000;
        uint256 usdcForAMM   = _usdcIn - spreadFee;

        // Fee stays in the contract, split evenly between reserves
        // This gradually deepens the pool over time
        accumulatedFees += spreadFee;
        uint256 feePerReserve = spreadFee / 2;

        if (_buyYes) {
            uint256 k = yesReserve * noReserve;
            uint256 newYesReserve  = yesReserve + usdcForAMM + feePerReserve;
            uint256 newNoReserve = k / newYesReserve;
            sharesOut = noReserve - newNoReserve;

            yesReserve = newYesReserve;
            noReserve  = newNoReserve;
            yesToken.mint(msg.sender, sharesOut);
        } else {
            uint256 k = yesReserve * noReserve;
            uint256 newNoReserve  = noReserve + usdcForAMM + feePerReserve;
            uint256 newYesReserve = k / newNoReserve;
            sharesOut = yesReserve - newYesReserve;

            yesReserve = newYesReserve;
            noReserve  = newNoReserve;
            noToken.mint(msg.sender, sharesOut);
        }

        require(sharesOut >= _minSharesOut, "Slippage exceeded");

        emit Trade(msg.sender, _buyYes, _usdcIn, sharesOut);
    }

    // Sell YES or NO shares back to USDC
    // Reverse of buy — burns shares, returns USDC

    function sell(
        bool    _sellYes,
        uint256 _sharesIn,
        uint256 _minUsdcOut
    )
        external
        nonReentrant
        notResolved
        notExpired
        returns (uint256 usdcOut)
    {
        require(_sharesIn > 0, "Must sell at least 1 share");

        if (_sellYes) {
            // Selling YES shares back: burns shares, releases USDC from yesReserve
            yesToken.burn(msg.sender, _sharesIn);

            uint256 k = yesReserve * noReserve;
            uint256 newYesReserve = yesReserve - _sharesIn;
            uint256 newNoReserve  = k / newYesReserve;
            usdcOut = newNoReserve - noReserve;

            yesReserve = newYesReserve;
            noReserve  = newNoReserve;
        } else {
            noToken.burn(msg.sender, _sharesIn);

            uint256 k = yesReserve * noReserve;
            uint256 newNoReserve  = noReserve - _sharesIn;
            uint256 newYesReserve = k / newNoReserve;
            usdcOut = newYesReserve - yesReserve;

            yesReserve = newYesReserve;
            noReserve  = newNoReserve;
        }

        require(usdcOut >= _minUsdcOut, "Slippage exceeded");
        IERC20(USDC).safeTransfer(msg.sender, usdcOut);

        emit Trade(msg.sender, !_sellYes, usdcOut, _sharesIn);
    }

    // ── Resolution ────────────────────────────────────────────────────────────

    // Called by the oracle (off-chain resolver) after the event occurs
    // _yesWon: true if YES outcome happened, false if NO outcome happened

    function resolve(bool _yesWon)
        external
        onlyOracle
        notResolved
        isExpired
    {
        resolved    = true;
        resolvedYes = _yesWon;

        emit MarketResolved(_yesWon);
    }

    // After resolution, winning share holders redeem for USDC
    // Each winning share redeems for: totalLiquidity / totalWinningShares USDC

    function redeem() external nonReentrant {
        require(resolved, "Not yet resolved");

        uint256 usdcOut;

        if (resolvedYes) {
            uint256 yesBalance = yesToken.balanceOf(msg.sender);
            require(yesBalance > 0, "No YES shares to redeem");

            uint256 totalYesShares = yesToken.totalSupply();
            // Each YES share gets: totalLiquidity * (1 share / totalYesShares)
            usdcOut = (totalLiquidity() * yesBalance) / totalYesShares;

            yesToken.burn(msg.sender, yesBalance);
        } else {
            uint256 noBalance = noToken.balanceOf(msg.sender);
            require(noBalance > 0, "No NO shares to redeem");

            uint256 totalNoShares = noToken.totalSupply();
            usdcOut = (totalLiquidity() * noBalance) / totalNoShares;

            noToken.burn(msg.sender, noBalance);
        }

        require(usdcOut > 0, "Nothing to redeem");
        IERC20(USDC).safeTransfer(msg.sender, usdcOut);

        emit Redeemed(msg.sender, usdcOut);
    }

    // ── Reasoning Layer ───────────────────────────────────────────────────────

    // Called by the Reasoning Layer backend to publish a subsequent trace
    // (e.g. when the Trader Agent places a bet on this market)
    // The creation trace is published in the constructor — this is for updates.

    function publishReasoning(
        address _agentWallet,
        string  calldata _ipfsCid,
        bytes32 _sha256Hash
    ) external {
        // Only the factory (and therefore the agent) can publish reasoning
        require(msg.sender == factory, "Only factory");

        emit ReasoningPublished(
            address(this),
            _agentWallet,
            _ipfsCid,
            _sha256Hash,
            block.timestamp
        );
    }

    /// @notice Calculates the current spread in basis points.
    ///
    /// Spread has three components:
    ///   1. Confidence spread: wider when agent is less certain
    ///   2. Liquidity spread:  wider when pool is thin
    ///   3. Time spread:       wider as market approaches expiry
    ///      (approaching expiry = high information asymmetry risk)
    ///
    /// Final spread = max(MIN_SPREAD_BPS, min(MAX_SPREAD_BPS, sum of components))
    function currentSpreadBps() public view returns (uint256 spread) {
        // ── Component 1: confidence spread ────────────────────────────────────
        // confidenceIntervalBps of 800 (±8%) → spread contribution of 80 bps
        // Intuition: if agent is uncertain, charge more to trade against it
        uint256 confidenceSpread = confidenceIntervalBps / 10;

        // ── Component 2: liquidity spread ─────────────────────────────────────
        // Thin pools get a wider spread to prevent full extraction
        // Pool < 50 USDC → 200 bps extra spread
        // Pool < 200 USDC → 100 bps extra spread
        // Pool >= 200 USDC → 0 extra spread
        uint256 poolDepth = totalLiquidity();
        uint256 liquiditySpread;
        if (poolDepth < 50 * 1e6) {
            liquiditySpread = 200;
        } else if (poolDepth < 200 * 1e6) {
            liquiditySpread = 100;
        } else {
            liquiditySpread = 0;
        }

        // ── Component 3: time spread ───────────────────────────────────────────
        // Markets within 24 hours of expiry get a 150 bps premium
        // Markets within 6 hours get a 300 bps premium
        // Rationale: informed traders have maximum edge near resolution
        uint256 timeSpread;
        if (block.timestamp >= expiryTimestamp) {
            timeSpread = 0; // expired — no more trading
        } else {
            uint256 timeRemaining = expiryTimestamp - block.timestamp;
            if (timeRemaining < 6 hours) {
                timeSpread = 300;
            } else if (timeRemaining < 24 hours) {
                timeSpread = 150;
            } else {
                timeSpread = 0;
            }
        }

        // ── Combine and clamp ─────────────────────────────────────────────────
        uint256 rawSpread = confidenceSpread + liquiditySpread + timeSpread;
        spread = rawSpread < MIN_SPREAD_BPS ? MIN_SPREAD_BPS
        : rawSpread > MAX_SPREAD_BPS ? MAX_SPREAD_BPS
        : rawSpread;
    }

    /// @notice Called by the Market Maker Agent when its probability estimate changes.
    ///         Updates the confidence interval, which directly controls spread width.
    ///         Only the factory (agent) can call this.
    ///
    /// @param _newProbabilityBps       Updated probability estimate (6800 = 68%)
    /// @param _newConfidenceIntervalBps Updated confidence interval (800 = ±8%)

    function updateAgentProbability(
        uint256 _newProbabilityBps,
        uint256 _newConfidenceIntervalBps
    )
        external
    {
        require(msg.sender == factory, "Only factory");
        require(_newProbabilityBps > 0 && _newProbabilityBps < 10000, "Invalid probability");
        require(_newConfidenceIntervalBps <= 3000, "Confidence interval too wide");

        agentProbabilityBps      = _newProbabilityBps;
        confidenceIntervalBps    = _newConfidenceIntervalBps;
        lastAgentUpdate          = block.timestamp;

        emit AgentProbabilityUpdated(
            _newProbabilityBps,
            _newConfidenceIntervalBps,
            block.timestamp
        );
    }

    /// @notice Rebalances the AMM reserves to align with the agent's current
    ///         probability estimate. Called when market price drifts beyond
    ///         rebalanceThresholdBps from the agent's estimate.
    ///
    /// Does NOT add or remove USDC — total liquidity stays constant.
    /// Only shifts the split between yesReserve and noReserve.
    ///
    /// Example:
    ///   Agent says 74%, market at 61% (13% drift, above 5% threshold)
    ///   Before: yesReserve=61, noReserve=39 (total=100)
    ///   After:  yesReserve=74, noReserve=26 (total=100, price now at 74%)
    ///   Note: price = noReserve / (yesReserve + noReserve)
    ///         so to get price=74%: noReserve = 74, yesReserve = 26

    function rebalanceLiquidity() external notResolved {
        require(msg.sender == factory, "Only factory");

        uint256 marketPriceBps = currentYesPrice();

        // Only rebalance if drift exceeds threshold
        uint256 drift = marketPriceBps > agentProbabilityBps
            ? marketPriceBps - agentProbabilityBps
            : agentProbabilityBps - marketPriceBps;

        require(drift >= rebalanceThresholdBps, "Drift below threshold, no rebalance needed");

        uint256 oldYesReserve = yesReserve;
        uint256 oldNoReserve  = noReserve;
        uint256 total         = totalLiquidity();

        // Rebalance: set reserves proportional to agent probability
        // Price of YES = noReserve / total → to get price = agentP/10000:
        //   noReserve = total * agentP / 10000
        //   yesReserve = total - noReserve
        uint256 newNoReserve  = (total * agentProbabilityBps) / 10000;
        uint256 newYesReserve = total - newNoReserve;

        yesReserve = newYesReserve;
        noReserve  = newNoReserve;

        emit LiquidityRebalanced(
            oldYesReserve,
            oldNoReserve,
            newYesReserve,
            newNoReserve,
            agentProbabilityBps
        );
    }

    /// @notice PRICING CURVE UPGRADE PATH
    /// Current: Constant-product AMM (x * y = k) with dynamic spread overlay
    ///   Simple, battle-tested, sufficient for demonstration
    ///
    /// Production: LMSR (Logarithmic Market Scoring Rule)
    ///   cost(q) = b * log(e^(q_yes/b) + e^(q_no/b))
    ///   Better price stability near 0% and 100%
    ///   Standard for academic prediction market research
    ///   Requires PRBMath or equivalent fixed-point library
    ///   Estimated implementation: 3-4 days + audit
}