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