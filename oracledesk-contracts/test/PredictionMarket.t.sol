// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MarketFactory.sol";
import "../src/PredictionMarket.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Mock USDC for local testing (real USDC is at fixed address on Arc)
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6; // Match Arc USDC — 6 decimals
    }
}

contract PredictionMarketTest is Test {
    MockUSDC    usdc;
    MarketFactory factory;

    address agent  = address(0xA6E47);
    address trader = address(0x78ADE8);
    address oracle = address(0x08AC1E);

    uint256 constant ONE_USDC     = 1e6;    // 1 USDC in 6-decimal terms
    uint256 constant SEED_AMOUNT  = 100 * ONE_USDC; // 100 USDC seed

    function setUp() public {
        // Deploy mock USDC and override the constant address
        usdc = new MockUSDC();

        // Fund accounts
        usdc.mint(agent,   1000 * ONE_USDC);
        usdc.mint(trader,  500  * ONE_USDC);

        // Deploy factory
        vm.prank(agent);
        factory = new MarketFactory(agent);

        // Override USDC constant with mock for testing
        // In production on Arc, USDC is at 0x3600000000000000000000000000000000000000
        vm.etch(
            0x3600000000000000000000000000000000000000,
            address(usdc).code
        );
        // Fund the mocked address
        MockUSDC(0x3600000000000000000000000000000000000000).mint(
            agent, 1000 * ONE_USDC
        );
        MockUSDC(0x3600000000000000000000000000000000000000).mint(
            trader, 500 * ONE_USDC
        );
    }

    function _deployMarket(uint256 initialYesPrice, uint256 confidenceBps)
        internal
        returns (address marketAddr)
    {
        address usdcAddr = 0x3600000000000000000000000000000000000000;
        string memory question = "Will the Fed raise rates?";

        vm.startPrank(agent);
        IERC20(usdcAddr).approve(address(factory), SEED_AMOUNT);
        factory.depositLiquidity(SEED_AMOUNT);
        marketAddr = factory.createMarket(
            question,
            oracle,
            block.timestamp + 30 days,
            initialYesPrice,
            SEED_AMOUNT,
            agent,
            "QmTestCid123",
            bytes32(0),
            confidenceBps
        );
        vm.stopPrank();
    }

    // ── Test: Basic market creation ───────────────────────────────────────────

    function test_CreateMarket() public {
        address usdcAddr = 0x3600000000000000000000000000000000000000;

        // Agent deposits seed to factory
        vm.startPrank(agent);
        IERC20(usdcAddr).approve(address(factory), SEED_AMOUNT);
        factory.depositLiquidity(SEED_AMOUNT);

        // Create market
        address market = factory.createMarket(
            "Will the Fed raise rates at the June 12 meeting?",
            oracle,
            block.timestamp + 30 days,
            6800,           // 68% initial YES price
            SEED_AMOUNT,
            agent,
            "QmTestCid123",
            keccak256("test reasoning trace content"),
            400
        );
        vm.stopPrank();

        // Verify market was deployed
        assertTrue(market != address(0));
        assertEq(factory.totalMarkets(), 1);

        // Check initial price is close to 68%
        PredictionMarket pm = PredictionMarket(market);
        uint256 yesPrice = pm.currentYesPrice();
        // Allow small rounding tolerance: 6799 or 6800
        assertApproxEqAbs(yesPrice, 6800, 2);
    }

    // ── Test: USDC decimal handling ───────────────────────────────────────────

    function test_UsdcDecimalHandling() public {
        // Critical: ensure 1 USDC = 1_000_000 (6 decimals), NOT 1e18
        assertEq(ONE_USDC, 1_000_000);

        // Verify mock USDC has 6 decimals
        assertEq(
            MockUSDC(0x3600000000000000000000000000000000000000).decimals(),
            6
        );
    }

    // ── Test: Buy YES shares ──────────────────────────────────────────────────

    function test_BuyYesShares() public {
        address usdcAddr = 0x3600000000000000000000000000000000000000;

        vm.startPrank(agent);
        IERC20(usdcAddr).approve(address(factory), SEED_AMOUNT);
        factory.depositLiquidity(SEED_AMOUNT);
        address marketAddr = factory.createMarket(
            "Will the Fed raise rates at the June 12 meeting?",
            oracle,
            block.timestamp + 30 days,
            6800,
            SEED_AMOUNT,
            agent,
            "QmTestCid123",
            bytes32(0),
            400
        );
        vm.stopPrank();

        PredictionMarket market = PredictionMarket(marketAddr);

        // Trader buys 10 USDC worth of YES shares
        uint256 buyAmount = 10 * ONE_USDC;
        vm.startPrank(trader);
        IERC20(usdcAddr).approve(marketAddr, buyAmount);
        uint256 sharesOut = market.buy(true, buyAmount, 0);
        vm.stopPrank();

        // Should have received YES shares
        assertTrue(sharesOut > 0);
        assertEq(market.yesToken().balanceOf(trader), sharesOut);

        // Price should have moved (buying YES raises YES price)
        assertTrue(market.currentYesPrice() > 6800);
    }

    // ── Test: Duplicate market prevention ────────────────────────────────────

    function test_NoDuplicateMarkets() public {
        address usdcAddr = 0x3600000000000000000000000000000000000000;
        string memory q = "Will the Fed raise rates at the June 12 meeting?";

        vm.startPrank(agent);
        IERC20(usdcAddr).approve(address(factory), SEED_AMOUNT * 2);
        factory.depositLiquidity(SEED_AMOUNT * 2);

        factory.createMarket(q, oracle, block.timestamp + 30 days,
            6800, SEED_AMOUNT, agent, "QmCid1", bytes32(0), 400);

        // Second attempt with same question should revert
        vm.expectRevert("Market for this question already exists");
        factory.createMarket(q, oracle, block.timestamp + 30 days,
            6800, SEED_AMOUNT, agent, "QmCid2", bytes32(0), 400);

        vm.stopPrank();
    }

    // ── Test: Resolution and redemption ──────────────────────────────────────

    function test_ResolveAndRedeem() public {
        address usdcAddr = 0x3600000000000000000000000000000000000000;

        vm.startPrank(agent);
        IERC20(usdcAddr).approve(address(factory), SEED_AMOUNT);
        factory.depositLiquidity(SEED_AMOUNT);
        address marketAddr = factory.createMarket(
            "Will the Fed raise rates?",
            oracle,
            block.timestamp + 1 days,
            5000, // 50/50 market
            SEED_AMOUNT,
            agent,
            "QmCid",
            bytes32(0),
            400
        );
        vm.stopPrank();

        PredictionMarket market = PredictionMarket(marketAddr);

        // Trader buys YES shares
        uint256 buyAmount = 20 * ONE_USDC;
        vm.startPrank(trader);
        IERC20(usdcAddr).approve(marketAddr, buyAmount);
        uint256 yesShares = market.buy(true, buyAmount, 0);
        vm.stopPrank();

        // Fast-forward past expiry
        vm.warp(block.timestamp + 2 days);

        // Oracle resolves YES
        vm.prank(oracle);
        market.resolve(true);

        // Trader redeems YES shares for USDC
        uint256 traderUsdcBefore = IERC20(usdcAddr).balanceOf(trader);
        vm.prank(trader);
        market.redeem();
        uint256 traderUsdcAfter = IERC20(usdcAddr).balanceOf(trader);

        assertTrue(traderUsdcAfter > traderUsdcBefore);
        assertEq(market.yesToken().balanceOf(trader), 0);
    }

    // ── Test: dynamic spread widens with low confidence ───────────────────────────
    function test_DynamicSpread() public {
        // Create market with tight confidence interval (200 bps = ±2%)
        address marketAddr = _deployMarket(6800, 200);
        PredictionMarket market = PredictionMarket(marketAddr);

        uint256 tightSpread = market.currentSpreadBps();
        console.log("Tight confidence spread:", tightSpread);

        // Update to wide confidence interval (2000 bps = ±20%)
        vm.prank(agent);
        factory.updateMarketProbability(marketAddr, 6800, 2000);

        uint256 wideSpread = market.currentSpreadBps();
        console.log("Wide confidence spread:", wideSpread);

        // Wide confidence must produce wider spread
        assertGt(wideSpread, tightSpread);
    }

    // ── Test: spread increases near expiry ───────────────────────────────────────
    function test_TimeSpread() public {
        address marketAddr = _deployMarket(6800, 400);
        PredictionMarket market = PredictionMarket(marketAddr);

        uint256 farSpread = market.currentSpreadBps();

        // Warp to 12 hours before expiry
        vm.warp(market.expiryTimestamp() - 12 hours);
        uint256 nearSpread = market.currentSpreadBps();

        // Warp to 3 hours before expiry
        vm.warp(market.expiryTimestamp() - 3 hours);
        uint256 veryNearSpread = market.currentSpreadBps();

        assertGt(nearSpread,     farSpread);
        assertGt(veryNearSpread, nearSpread);
    }

    // ── Test: rebalance anchors price to agent estimate ───────────────────────────
    function test_LiquidityRebalance() public {
        address usdcAddr  = 0x3600000000000000000000000000000000000000;
        address marketAddr = _deployMarket(5000, 500); // 50/50 market
        PredictionMarket market = PredictionMarket(marketAddr);

        // Trader buys a lot of YES, pushing price up to ~70%
        uint256 bigBuy = 80 * ONE_USDC;
        vm.startPrank(trader);
        IERC20(usdcAddr).approve(marketAddr, bigBuy);
        market.buy(true, bigBuy, 0);
        vm.stopPrank();

        uint256 priceAfterBuy = market.currentYesPrice();
        console.log("Price after big buy:", priceAfterBuy);
        assertGt(priceAfterBuy, 5500); // price moved up

        // Agent updates estimate and rebalances
        vm.startPrank(agent);
        factory.updateMarketProbability(marketAddr, 5000, 500); // agent still thinks 50%
        factory.rebalanceMarket(marketAddr);
        vm.stopPrank();

        uint256 priceAfterRebalance = market.currentYesPrice();
        console.log("Price after rebalance:", priceAfterRebalance);

        // Price should be back near 50%
        assertApproxEqAbs(priceAfterRebalance, 5000, 100);
    }

    // ── Test: spread fee stays in pool ───────────────────────────────────────────
    function test_SpreadFeeAccumulation() public {
        address usdcAddr  = 0x3600000000000000000000000000000000000000;
        address marketAddr = _deployMarket(6800, 800);
        PredictionMarket market = PredictionMarket(marketAddr);

        uint256 liquidityBefore = market.totalLiquidity();

        vm.startPrank(trader);
        IERC20(usdcAddr).approve(marketAddr, 10 * ONE_USDC);
        market.buy(true, 10 * ONE_USDC, 0);
        vm.stopPrank();

        // Total liquidity grew because spread fee stayed in pool
        assertGt(market.totalLiquidity(), liquidityBefore);
        assertGt(market.accumulatedFees(), 0);
    }
}