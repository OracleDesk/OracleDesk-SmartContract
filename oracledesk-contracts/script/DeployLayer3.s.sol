// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/ReasoningRegistry.sol";

contract DeployLayer3 is Script {
    function run() external {
        uint256 deployerKey  = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agentAddress = vm.envAddress("AGENT_WALLET_ADDRESS");

        console.log("Deploying Layer 3 contracts...");
        console.log("  Deployer:       ", vm.addr(deployerKey));
        console.log("  Agent (owner):  ", agentAddress);

        vm.startBroadcast(deployerKey);

        ReasoningRegistry registry = new ReasoningRegistry(agentAddress);
        console.log("ReasoningRegistry deployed at:", address(registry));

        vm.stopBroadcast();

        console.log("\nAdd to your .env:");
        console.log("REASONING_REGISTRY_ADDRESS=", address(registry));
    }
}