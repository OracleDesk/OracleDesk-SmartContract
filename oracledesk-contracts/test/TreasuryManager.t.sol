// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/TreasuryManager.sol";
import "../src/PositionLedger.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Mock USDC (6 decimals, matching Arc)
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

// Mock CCTP TokenMessenger — captures depositForBurn calls without actually bridging
contract MockTokenMessenger {
    event BurnCalled(uint256 amount, uint32 domain, bytes32 recipient);
    uint64 public nonceCounter;

    function depositForBurn(
        uint256 amount,
        uint32  destinationDomain,
        bytes32 mintRecipient,
        address, // burnToken
        bytes32, // destinationCaller
        uint256, // maxFee
        uint32   // minFinalityThreshold
    ) external returns (uint64 nonce) {
        emit BurnCalled(amount, destinationDomain, mintRecipient);
        nonce = ++nonceCounter;
        // In the real CCTP this burns the tokens. Here we just emit the event.
        // NOTE: TreasuryManager approves the messenger to spend its USDC.
        // For the test, we must pull those tokens to simulate the burn.
        IERC20(0x3600000000000000000000000000000000000000).transferFrom(
            msg.sender, address(this), amount
        );
    }
}

contract TreasuryManagerTest is Test {
    MockUSDC          usdc;
    MockTokenMessenger messenger;
    TreasuryManager   treasury;
    PositionLedger    ledger;

    address agent   = address(0xA6E47);
    address polygon = address(0x9876);

    uint256 constant ONE_USDC = 1e6;

    function setUp() public {
        // Deploy mock USDC and etch it at the Arc hardcoded address
        usdc = new MockUSDC();
        vm.etch(
            0x3600000000000000000000000000000000000000,
            address(usdc).code
        );
        MockUSDC usdcAtAddr = MockUSDC(0x3600000000000000000000000000000000000000);

        // Deploy and etch mock messenger at CCTP address
        messenger = new MockTokenMessenger();
        vm.etch(
            0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA,
            address(messenger).code
        );

        // Fund agent
        usdcAtAddr.mint(agent, 1000 * ONE_USDC);

        // Deploy contracts
        vm.startPrank(agent);
        treasury = new TreasuryManager(agent, polygon);
        ledger   = new PositionLedger(agent);

        // Deposit 500 USDC into treasury
        IERC20(0x3600000000000000000000000000000000000000)
            .approve(address(treasury), 500 * ONE_USDC);
        treasury.deposit(500 * ONE_USDC);
        vm.stopPrank();
    }

    // ── Test: basic treasury state ────────────────────────────────────────────

    function test_InitialState() public {
        assertEq(treasury.totalBankroll(), 500 * ONE_USDC);
        assertEq(treasury.availableCapital(), 500 * ONE_USDC);
        assertEq(treasury.deployedCapital(), 0);
        assertFalse(treasury.paused());
    }

    // ── Test: Kelly limit enforcement ─────────────────────────────────────────

    function test_KellyLimitEnforced() public {
        // Max single position = 2.5% of 500 USDC = 12.5 USDC
        uint256 maxAllowed = (500 * ONE_USDC * 250) / 10000; // = 12.5 USDC
        assertEq(maxAllowed, 12_500_000); // 12.5 USDC in 6 decimals

        // Trying to fund 20 USDC (above limit) should revert
        vm.prank(agent);
        vm.expectRevert("Exceeds max single position size");
        treasury.fundBet(bytes32(uint256(1)), 20 * ONE_USDC, 1000);
    }

    // ── Test: successful bet funding via CCTP ─────────────────────────────────

    function test_FundBet() public {
        bytes32 marketId = keccak256("Will Fed raise rates June 12?");
        uint256 betSize  = 10 * ONE_USDC; // 10 USDC (within 2.5% of 500 = 12.5 max)

        vm.prank(agent);
        uint64 nonce = treasury.fundBet(marketId, betSize, 1000);

        // Nonce from mock messenger should be 1
        assertEq(nonce, 1);

        // Treasury should show deployed capital
        assertEq(treasury.deployedCapital(), betSize);
        assertEq(treasury.availableCapital(), 490 * ONE_USDC);

        // Position should be open
        (,,,, bool open) = _getPositionFields(marketId);
        assertTrue(open);
    }

    // ── Test: duplicate position rejected ─────────────────────────────────────

    function test_NoDuplicatePosition() public {
        bytes32 marketId = keccak256("Fed June 12");

        vm.startPrank(agent);
        treasury.fundBet(marketId, 5 * ONE_USDC, 1000);

        vm.expectRevert("Position already open for this market");
        treasury.fundBet(marketId, 5 * ONE_USDC, 1000);
        vm.stopPrank();
    }

    // ── Test: drawdown pause ──────────────────────────────────────────────────

    function test_DrawdownPause() public {
        bytes32 marketId = keccak256("ECB rate decision");

        vm.prank(agent);
        treasury.fundBet(marketId, 10 * ONE_USDC, 1000);

        // Simulate a loss: swept back 0 (lost everything)
        // Drawdown = 10 USDC / 490 USDC available ≈ 2.04%
        // Max drawdown = 3% → should NOT pause yet
        vm.prank(agent);
        treasury.recordSweepBack(marketId, 0); // total loss

        // 10 USDC loss / 490 USDC remaining = 2.04% < 3% → not paused
        assertFalse(treasury.paused());

        // Now fund another bet and lose it too (total loss ~4% of remaining)
        bytes32 marketId2 = keccak256("OPEC production cut");
        vm.prank(agent);
        treasury.fundBet(marketId2, 5 * ONE_USDC, 1000);

        vm.prank(agent);
        treasury.recordSweepBack(marketId2, 0);

        // 15 USDC loss from 500 starting = 3% → should pause
        assertTrue(treasury.paused());

        // Verify agent cannot place bets while paused
        vm.prank(agent);
        vm.expectRevert("Agent is paused - drawdown limit hit");
        treasury.fundBet(keccak256("another bet"), 5 * ONE_USDC, 1000);
    }

    // ── Test: PositionLedger openPosition ─────────────────────────────────────

    function test_OpenPosition() public {
        bytes32 conditionId = keccak256("polymarket-condition-abc123");
        uint256 tokenId     = 58670511222237437150810312030727137317904629401680594753026701991201571494287;

        vm.prank(agent);
        bytes32 positionId = ledger.openPosition(
            conditionId,
            tokenId,
            PositionLedger.Side.YES,
            10 * ONE_USDC,         // usdcSpent
            14705882,              // sharesReceived (~14.7 shares at 68c each)
            6800,                  // entryPriceBps (68%)
            125,                   // kellyFractionBps (1.25% of bankroll)
            800,                   // edgeBps (8% edge)
            "QmTestReasoningCid",
            keccak256("reasoning content"),
            "0xPolygonTxHashHere",
            1                      // cctpNonce
        );

        assertTrue(positionId != bytes32(0));
        assertEq(ledger.totalPositions(), 1);

        PositionLedger.Position memory pos = ledger.getPosition(positionId);
        assertEq(pos.usdcSpent, 10 * ONE_USDC);
        assertEq(pos.entryPriceBps, 6800);
        assertEq(uint8(pos.state), uint8(PositionLedger.PositionState.OPEN));
    }

    // ── Test: closePosition with P&L ──────────────────────────────────────────

    function test_ClosePositionWithPnl() public {
        bytes32 conditionId = keccak256("polymarket-condition-xyz");

        vm.startPrank(agent);
        bytes32 positionId = ledger.openPosition(
            conditionId, 12345, PositionLedger.Side.YES,
            10 * ONE_USDC, 14705882, 6800, 125, 800,
            "QmCid", bytes32(0), "0xPolygonTx", 1
        );

        // Close as WIN — received 14.7 USDC back on 10 USDC bet
        ledger.closePosition(positionId, PositionLedger.PositionState.CLOSED_WIN, 14_700_000);
        vm.stopPrank();

        PositionLedger.Position memory pos = ledger.getPosition(positionId);
        assertEq(uint8(pos.state), uint8(PositionLedger.PositionState.CLOSED_WIN));
        assertEq(pos.realisedPnl, 4_700_000); // +4.7 USDC profit
    }

    // Helper to read position fields from TreasuryManager
    function _getPositionFields(bytes32 marketId) internal view returns (
        bytes32, uint256, uint256, bool, bool
    ) {
        (
            bytes32 id,
            uint256 capitalSent,
            uint256 timestamp,
            bool open
        ) = treasury.positions(marketId);
        return (id, capitalSent, timestamp, open, open);
    }
}