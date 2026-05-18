// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/TreasuryManager.sol";
import "../src/PositionLedger.sol";

contract DeployLayer2 is Script {
    function run() external {
        uint256 deployerKey     = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agentAddress    = vm.envAddress("AGENT_WALLET_ADDRESS");
        address polygonWallet   = vm.envAddress("POLYGON_EXECUTION_WALLET");

        console.log("Deploying Layer 2 contracts...");
        console.log("  Deployer:       ", vm.addr(deployerKey));
        console.log("  Agent (owner):  ", agentAddress);
        console.log("  Polygon wallet: ", polygonWallet);

        vm.startBroadcast(deployerKey);

        // Deploy TreasuryManager
        TreasuryManager treasury = new TreasuryManager(
            agentAddress,   // owner — the Circle agent wallet
            polygonWallet   // Polygon execution wallet that receives CCTP funds
        );
        console.log("TreasuryManager deployed at:", address(treasury));

        // Deploy PositionLedger
        PositionLedger ledger = new PositionLedger(agentAddress);
        console.log("PositionLedger  deployed at:", address(ledger));

        vm.stopBroadcast();

        // Print .env additions
        console.log("\nAdd to your .env:");
        console.log("TREASURY_MANAGER_ADDRESS=", address(treasury));
        console.log("POSITION_LEDGER_ADDRESS=",  address(ledger));
    }
}