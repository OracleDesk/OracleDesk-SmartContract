// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MultiSigOracle.sol";

contract DeployOracle is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent       = vm.envAddress("AGENT_WALLET_ADDRESS");
        address signer1     = vm.envOr("TEAM_MEMBER_1", agent);
        address signer2     = vm.envOr("TEAM_MEMBER_2", agent);
        address signer3     = vm.envOr("TEAM_MEMBER_3", agent);

        vm.startBroadcast(deployerKey);
        MultiSigOracle oracle = new MultiSigOracle([agent, signer1, signer2, signer3]);
        console.log("MultiSigOracle:", address(oracle));
        vm.stopBroadcast();

        console.log("\nAdd to .env:");
        console.log("ORACLE_ADDRESS=", address(oracle));
    }
}