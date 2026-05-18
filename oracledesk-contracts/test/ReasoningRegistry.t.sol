// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ReasoningRegistry.sol";

contract ReasoningRegistryTest is Test {
    ReasoningRegistry registry;
    address agent      = address(0xA6E47);
    address subscriber = address(0x5AB5C416);

    function setUp() public {
        vm.prank(agent);
        registry = new ReasoningRegistry(agent);
    }

    // ── Test: publish a trace ─────────────────────────────────────────────────

    function test_PublishTrace() public {
        string  memory cid  = "QmTestReasoningTrace123";
        bytes32 hash        = keccak256("full reasoning trace json content");
        bytes32 relatedId   = keccak256("market-id-abc");

        vm.prank(agent);
        bytes32 traceId = registry.publishTrace(cid, hash, "trade", relatedId);

        // traceId should be deterministic
        assertEq(traceId, keccak256(bytes(cid)));

        // Record should exist
        ReasoningRegistry.TraceRecord memory record = registry.getTrace(traceId);
        assertEq(record.ipfsCid,    cid);
        assertEq(record.sha256Hash, hash);
        assertEq(record.traceType,  "trade");
        assertEq(record.agentWallet, agent);
        assertTrue(record.exists);
        assertGt(record.publishedAt, 0);
    }

    // ── Test: duplicate CID rejected ──────────────────────────────────────────

    function test_NoDuplicateCid() public {
        string  memory cid = "QmSameCid";
        bytes32 hash       = keccak256("content");

        vm.startPrank(agent);
        registry.publishTrace(cid, hash, "trade", bytes32(0));

        vm.expectRevert("Trace already published");
        registry.publishTrace(cid, hash, "trade", bytes32(0));
        vm.stopPrank();
    }

    // ── Test: record access ───────────────────────────────────────────────────

    function test_RecordAccess() public {
        string  memory cid = "QmAccessTestTrace";
        bytes32 hash       = keccak256("content");

        vm.prank(agent);
        bytes32 traceId = registry.publishTrace(cid, hash, "trade", bytes32(0));

        // Before access
        assertFalse(registry.hasAccess(subscriber, traceId));

        // Record access (called by API server after x402 payment)
        vm.prank(agent);
        registry.recordAccess(traceId, subscriber, 1000); // 0.001 USDC

        // After access
        assertTrue(registry.hasAccess(subscriber, traceId));

        ReasoningRegistry.SubscriberRecord memory sub = registry.getSubscriber(subscriber);
        assertEq(sub.tracesRead,    1);
        assertEq(sub.totalPaidUsdc, 1000);
        assertTrue(sub.active);
    }

    // ── Test: pagination ──────────────────────────────────────────────────────

    function test_Pagination() public {
        // Publish 5 traces
        vm.startPrank(agent);
        for (uint256 i = 0; i < 5; i++) {
            string memory cid = string(abi.encodePacked("QmCid", vm.toString(i)));
            registry.publishTrace(cid, bytes32(i + 1), "trade", bytes32(0));
        }
        vm.stopPrank();

        assertEq(registry.totalTraces(), 5);

        // Get first page (2 newest)
        (bytes32[] memory page, uint256 total) = registry.getTraceIds(0, 2);
        assertEq(total, 5);
        assertEq(page.length, 2);
        // Most recent should be QmCid4
        assertEq(page[0], keccak256(bytes("QmCid4")));
        assertEq(page[1], keccak256(bytes("QmCid3")));
    }

    // ── Test: verify trace ────────────────────────────────────────────────────

    function test_VerifyTrace() public {
        string  memory cid  = "QmVerifyMe";
        bytes32 realHash    = keccak256("real content");
        bytes32 fakeHash    = keccak256("tampered content");

        vm.prank(agent);
        registry.publishTrace(cid, realHash, "market_creation", bytes32(0));

        // Correct hash verifies
        (bool valid, uint256 publishedAt) = registry.verifyTrace(cid, realHash);
        assertTrue(valid);
        assertGt(publishedAt, 0);

        // Wrong hash fails
        (bool invalid,) = registry.verifyTrace(cid, fakeHash);
        assertFalse(invalid);
    }

    // ── Test: only owner can publish and record ───────────────────────────────

    function test_OnlyOwner() public {
        address stranger = address(0x5737);

        vm.prank(stranger);
        vm.expectRevert();
        registry.publishTrace("QmCid", bytes32(0), "trade", bytes32(0));

        // Publish first as agent
        vm.prank(agent);
        bytes32 traceId = registry.publishTrace("QmCid2", keccak256("c"), "trade", bytes32(0));

        vm.prank(stranger);
        vm.expectRevert();
        registry.recordAccess(traceId, subscriber, 1000);
    }
}