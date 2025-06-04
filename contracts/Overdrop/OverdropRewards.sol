// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../utils/proxy/ProxyReentrancyGuard.sol";


contract OverdropRewards is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    // The reward token being distributed
    IERC20 public collateral;
    
    // Current merkle root for reward distribution
    bytes32 public merkleRoot;
    
    // Total amount of rewards available for distribution
    uint256 public totalRewards;
    
    // Total amount of rewards that have been claimed
    uint256 public totalClaimed;
    
    // Mapping to track if an address has claimed their rewards
    mapping(address => bool) public hasClaimed;
    
    // Flag to enable/disable claims
    bool public claimsEnabled;
    
    // Distribution round/epoch for tracking updates
    uint256 public currentSeason;

    /* ========== INITIALIZATION ========== */

    /**
     * @notice Initialize the contract
     * @param _owner The contract owner
     * @param _collateral The ERC20 token to distribute as collateral
     * @param _merkleRoot Initial merkle root
     * @param _totalRewards Total rewards for initial distribution
     */
    function initialize(
        address _owner,
        address _collateral,
        bytes32 _merkleRoot,
        uint256 _totalRewards
    ) external initializer {
        require(address(collateral) == address(0), "Already initialized");
        require(_collateral != address(0), "Invalid collateral token");
        require(_merkleRoot != bytes32(0), "Invalid merkle root");
        
        setOwner(_owner);
        initNonReentrant();
        collateral = IERC20(_collateral);
        merkleRoot = _merkleRoot;
        totalRewards = _totalRewards;
        currentSeason = 1;
        
        emit MerkleRootUpdated(bytes32(0), _merkleRoot, currentSeason, _totalRewards);
    }

    /* ========== VIEW FUNCTIONS ========== */

    /**
     * @notice Check if an address has claimed their rewards
     * @param account The address to check
     * @return Whether the address has claimed
     */
    function hasClaimedRewards(address account) external view returns (bool) {
        return hasClaimed[account];
    }

    /**
     * @notice Get remaining rewards available for distribution
     * @return Amount of unclaimed rewards
     */
    function remainingRewards() external view returns (uint256) {
        return totalRewards > totalClaimed ? totalRewards - totalClaimed : 0;
    }

    /**
     * @notice Verify a merkle proof without claiming
     * @param account The account address
     * @param amount The reward amount
     * @param merkleProof The proof to verify
     * @return Whether the proof is valid
     */
    function verifyProof(
        address account,
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external view returns (bool) {
        bytes32 leaf = keccak256(abi.encodePacked(account, amount));
        return MerkleProof.verify(merkleProof, merkleRoot, leaf);
    }


    /* ========== EXTERNAL FUNCTIONS ========== */

    /**
     * @notice Claim rewards using merkle proof
     * @param amount The amount of rewards to claim
     * @param merkleProof The merkle proof for the claim
     */
    function claimRewards(
        uint256 amount,
        bytes32[] calldata merkleProof
    ) external {
        require(claimsEnabled, "Claims are disabled");
        require(!hasClaimed[msg.sender], "Already claimed");
        require(amount > 0, "Amount must be greater than 0");
        
        // Verify the merkle proof
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        require(
            MerkleProof.verify(merkleProof, merkleRoot, leaf),
            "Invalid merkle proof"
        );
        
        // Mark as claimed
        hasClaimed[msg.sender] = true;
        totalClaimed += amount;
        
        // Transfer rewards
        collateral.safeTransfer(msg.sender, amount);
        
        emit RewardsClaimed(msg.sender, amount, currentSeason);
    }

    /**
     * @notice Deposit additional reward tokens
     * @param amount Amount of tokens to deposit
     */
    function depositRewards(uint256 amount) external {
        require(amount > 0, "Amount must be greater than 0");
        
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        
        emit RewardsDeposited(amount, msg.sender);
    }

    /**
     * @notice Toggle claims on/off
     * @param enabled Whether claims should be enabled
     */
    function enableClaims(bool enabled) external onlyOwner {
        claimsEnabled = enabled;
        emit ClaimsEnabled(enabled);
    }

    /**
     * @notice Update the merkle root (upgradeable functionality)
     * @param newMerkleRoot The new merkle root
     * @param newTotalRewards Total rewards for the new distribution
     * @param resetClaims Whether to reset all claim states
     */
    function updateMerkleRoot(
        bytes32 newMerkleRoot,
        uint256 newTotalRewards,
        bool resetClaims
    ) external onlyOwner {
        require(newMerkleRoot != bytes32(0), "Invalid merkle root");
        
        bytes32 oldRoot = merkleRoot;
        merkleRoot = newMerkleRoot;
        totalRewards = newTotalRewards;
        currentSeason++;
        
        if (resetClaims) {
            // Note: This is expensive for large numbers of users
            // Consider using a round-based approach instead
            totalClaimed = 0;
        }
        
        emit MerkleRootUpdated(oldRoot, newMerkleRoot, currentSeason, newTotalRewards);
    }

    /**
     * @notice Emergency withdraw function for owner
     * @param amount Amount to withdraw (0 = all)
     * @param recipient Address to send tokens to
     */
    function withdrawCollateral(
        uint256 amount,
        address recipient
    ) external onlyOwner {
        require(recipient != address(0), "Invalid recipient");
        
        uint256 balance = collateral.balanceOf(address(this));
        uint256 withdrawAmount = amount == 0 ? balance : amount;
        
        require(withdrawAmount <= balance, "Insufficient balance");
        
        collateral.safeTransfer(recipient, withdrawAmount);
        
        emit CollateralWithdrawn(withdrawAmount, recipient);
    }

     /* ========== EVENTS ========== */

    event RewardsClaimed(
        address indexed account,
        uint256 amount,
        uint256 round
    );
    
    event MerkleRootUpdated(
        bytes32 oldRoot,
        bytes32 newRoot,
        uint256 newRound,
        uint256 totalRewards
    );
    
    event ClaimsEnabled(bool enabled);
    
    event RewardsDeposited(uint256 amount, address indexed depositor);
    
    event CollateralWithdrawn(uint256 amount, address indexed recipient);

} 