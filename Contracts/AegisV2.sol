// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title AegisGuardV2
 * @dev Improved on-chain policy registry for x402 Agent Payments on Avalanche (Fuji).
 * - Owner / facilitator access control for recordSpend
 * - Replay protection by recording processed tx hashes
 * - Helpful views for frontend: getPolicy, timeUntilReset
 *
 * NOTE: This contract does not move funds. It is only a policy registry / audit log.
 * Units: `dailyLimit` and `_amount` are in atomic units (e.g., USDC = 6 decimals; AVAX/wei = 18 decimals).
 */
contract AegisGuardV2 {
    // --- Events ---
    event PolicyUpdated(address indexed user, address indexed agent, uint256 dailyLimit, bool isActive);
    event KillSwitchTriggered(address indexed user, address indexed agent);
    event SpendRecorded(address indexed user, address indexed agent, uint256 amount, bytes32 indexed txHash);
    event FacilitatorAdded(address indexed facilitator);
    event FacilitatorRemoved(address indexed facilitator);
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    // --- Structs ---
    struct Policy {
        uint256 dailyLimit;    // Max allowed per rolling 24h window (atomic units)
        uint256 currentSpend;  // Spend since last reset
        uint256 lastReset;     // Timestamp of last reset
        bool isActive;         // Master switch
        bool exists;           // To check if policy is initialized
    }

    // --- State ---
    address public owner;
    mapping(address => bool) public facilitators;
    // User Address -> Agent Address -> Policy
    mapping(address => mapping(address => Policy)) public policies;
    // processed transaction hashes (replay protection)
    mapping(bytes32 => bool) public recordedTx;

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "Aegis: Only owner");
        _;
    }

    modifier onlyFacilitator() {
        require(facilitators[msg.sender] == true || msg.sender == owner, "Aegis: Not facilitator");
        _;
    }

    modifier onlyActive(address _user, address _agent) {
        require(policies[_user][_agent].isActive, "Aegis: Agent access revoked");
        _;
    }

    constructor(address[] memory initialFacilitators) {
        owner = msg.sender;
        for (uint256 i = 0; i < initialFacilitators.length; i++) {
            facilitators[initialFacilitators[i]] = true;
            emit FacilitatorAdded(initialFacilitators[i]);
        }
    }

    // --- Owner / Facilitator management ---
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Aegis: zero owner");
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addFacilitator(address _fac) external onlyOwner {
        facilitators[_fac] = true;
        emit FacilitatorAdded(_fac);
    }

    function removeFacilitator(address _fac) external onlyOwner {
        facilitators[_fac] = false;
        emit FacilitatorRemoved(_fac);
    }

    // --- User functions ---

    /**
     * @notice Register or Update a spending policy for an AI Agent
     * @param _agent The wallet address of the autonomous agent
     * @param _dailyLimit The limit in smallest unit (e.g., Wei/USDC atomic units)
     */
    function setPolicy(address _agent, uint256 _dailyLimit) external {
        require(_agent != address(0), "Aegis: zero agent");
        Policy storage p = policies[msg.sender][_agent];
        p.dailyLimit = _dailyLimit;
        p.isActive = true;
        
        // If new policy, init reset time
        if (!p.exists) {
            p.lastReset = block.timestamp;
            p.exists = true;
        }

        emit PolicyUpdated(msg.sender, _agent, _dailyLimit, true);
    }

    /**
     * @notice EMERGENCY: Instantly revokes an agent's permission.
     * @dev This is the "Panic Button" feature for the UI.
     */
    function killSwitch(address _agent) external {
        require(policies[msg.sender][_agent].exists, "Aegis: no policy");
        policies[msg.sender][_agent].isActive = false;
        emit KillSwitchTriggered(msg.sender, _agent);
    }

    // --- Views / Helpers ---

    /**
     * @notice Returns full policy fluid state for a user/agent
     */
    function getPolicy(address _user, address _agent) external view returns (
        uint256 dailyLimit, uint256 currentSpend, uint256 lastReset, bool isActive, bool exists
    ) {
        Policy memory p = policies[_user][_agent];
        return (p.dailyLimit, p.currentSpend, p.lastReset, p.isActive, p.exists);
    }

    /**
     * @notice Seconds until the policy's daily reset window elapses (0 if reset is due now)
     */
    function timeUntilReset(address _user, address _agent) external view returns (uint256) {
        Policy memory p = policies[_user][_agent];
        if (!p.exists) return 0;
        if (block.timestamp > p.lastReset + 1 days) return 0;
        return (p.lastReset + 1 days) - block.timestamp;
    }

    /**
     * @notice Checks if a transaction is valid without executing it.
     * @dev Called by x402 Middleware/SDK off-chain.
     */
    function checkGuard(address _user, address _agent, uint256 _amount) public view returns (bool allowed, string memory reason) {
        Policy memory p = policies[_user][_agent];

        if (!p.exists) return (false, "No Policy Found");
        if (!p.isActive) return (false, "Kill Switch Active");

        // Reset daily logic
        uint256 effectiveSpend = p.currentSpend;
        if (block.timestamp > p.lastReset + 1 days) {
            effectiveSpend = 0;
        }

        if (effectiveSpend + _amount > p.dailyLimit) return (false, "Daily Limit Exceeded");

        return (true, "Authorized");
    }

    // --- Facilitator functions (onlyFacilitator) ---

    /**
     * @notice Records a spend and prevents replay by txHash.
     * @param _user The policy owner
     * @param _agent The agent who spent
     * @param _amount Atomic units (e.g., USDC 6 decimals)
     * @param _txHash Hash of the payment tx (off-chain onchain tx recorded by facilitator)
     */
    function recordSpend(address _user, address _agent, uint256 _amount, bytes32 _txHash) external onlyFacilitator {
        require(_txHash != bytes32(0), "Aegis: zero txHash");
        require(!recordedTx[_txHash], "Aegis: tx already recorded");

        (bool allowed, string memory reason) = checkGuard(_user, _agent, _amount);
        require(allowed, reason);

        Policy storage p = policies[_user][_agent];

        // Daily Reset Logic
        if (block.timestamp > p.lastReset + 1 days) {
            p.currentSpend = 0;
            p.lastReset = block.timestamp;
        }

        p.currentSpend += _amount;
        recordedTx[_txHash] = true;

        emit SpendRecorded(_user, _agent, _amount, _txHash);
    }
}
