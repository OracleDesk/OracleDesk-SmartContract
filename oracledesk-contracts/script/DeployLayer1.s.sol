// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MarketFactory.sol";

contract DeployLayer1 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agentAddress = vm.envAddress("AGENT_WALLET_ADDRESS");

        console.log("Deploying Layer 1 contracts...");
        console.log("  Deployer:      ", vm.addr(deployerKey));
        console.log("  Agent (owner): ", agentAddress);

        vm.startBroadcast(deployerKey);

        MarketFactory factory = new MarketFactory(agentAddress);
        console.log("MarketFactory deployed at:", address(factory));

        vm.stopBroadcast();

        console.log("\nAdd to your .env:");
        console.log("MARKET_FACTORY_ADDRESS=", address(factory));
    }
}
