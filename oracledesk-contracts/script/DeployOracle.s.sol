// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

contract MultiSigOracle {
    address[4] public signers;
    uint256 public required = 2;

    mapping(bytes32 => uint256) public approvalCount;
    mapping(bytes32 => mapping(address => bool)) public hasApproved;

    event ResolutionApproved(address signer, address market, bool yesWon, uint256 count);
    event MarketResolved(address market, bool yesWon);

    constructor(address[4] memory _signers) { signers = _signers; }

    modifier onlySigner() {
        require(
            msg.sender == signers[0] ||
            msg.sender == signers[1] ||
            msg.sender == signers[2] ||
            msg.sender == signers[3],
            "Not a signer"
        );
        _;
    }

    function approveResolution(address _market, bool _yesWon) external onlySigner {
        bytes32 key = keccak256(abi.encodePacked(_market, _yesWon));
        require(!hasApproved[key][msg.sender], "Already approved");
        hasApproved[key][msg.sender] = true;
        approvalCount[key]++;
        emit ResolutionApproved(msg.sender, _market, _yesWon, approvalCount[key]);
        if (approvalCount[key] >= required) {
            (bool success,) = _market.call(abi.encodeWithSignature("resolve(bool)", _yesWon));
            require(success, "Resolution call failed");
            emit MarketResolved(_market, _yesWon);
        }
    }
}

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