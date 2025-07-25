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

    error InvalidMerkleRoot();
    error InvalidAmount();
    error AlreadyClaimed();
    error ClaimsDisabled();
    error InvalidRecipient();
    error InvalidMerkleProof();
    error InvalidSeason();
    // The reward token being distributed
    IERC20 public collateral;

    // Current merkle root for reward distribution
    bytes32 public merkleRoot;

    // Total amount of rewards that have been claimed
    mapping(uint256 => uint256) public totalClaimed;

    // Mapping to track if an address has claimed their rewards per season
    mapping(address => mapping(uint256 => bool)) public hasClaimed;

    // Flag to enable/disable claims
    bool public claimsEnabled;

    // Distribution round/epoch for tracking updates
    uint256 public currentSeason;

    /**
     * @notice Initialize the contract
     * @param _owner The contract owner
     * @param _collateral The ERC20 token to distribute as collateral
     * @param _merkleRoot Initial merkle root
     */
    function initialize(address _owner, address _collateral, bytes32 _merkleRoot) external initializer {
        setOwner(_owner);
        initNonReentrant();
        collateral = IERC20(_collateral);
        merkleRoot = _merkleRoot;
        currentSeason = 1;

        emit MerkleRootUpdated(bytes32(0), _merkleRoot, currentSeason);
    }

    /* ========== VIEW FUNCTIONS ========== */

    /**
     * @notice Check if an address has claimed their rewards in the current season
     * @param account The address to check
     * @return Whether the address has claimed
     */
    function hasClaimedCurrentSeason(address account) external view returns (bool) {
        return hasClaimed[account][currentSeason];
    }

    /**
     * @notice Verify a merkle proof without claiming
     * @param account The account address
     * @param amount The reward amount
     * @param merkleProof The proof to verify
     * @return Whether the proof is valid
     */
    function verifyProof(address account, uint256 amount, bytes32[] calldata merkleProof) external view returns (bool) {
        bytes32 leaf = keccak256(abi.encodePacked(account, amount));
        return MerkleProof.verify(merkleProof, merkleRoot, leaf);
    }

    /* ========== EXTERNAL FUNCTIONS ========== */

    /**
     * @notice Claim rewards using merkle proof
     * @param amount The amount of rewards to claim
     * @param merkleProof The merkle proof for the claim
     */
    function claimRewards(uint256 amount, bytes32[] calldata merkleProof) external nonReentrant notPaused {
        if (!claimsEnabled) revert ClaimsDisabled();
        if (hasClaimed[msg.sender][currentSeason]) revert AlreadyClaimed();
        if (amount == 0) revert InvalidAmount();

        // Verify the merkle proof
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!MerkleProof.verify(merkleProof, merkleRoot, leaf)) revert InvalidMerkleProof();

        // Mark as claimed
        hasClaimed[msg.sender][currentSeason] = true;
        totalClaimed[currentSeason] += amount;

        // Transfer rewards
        collateral.safeTransfer(msg.sender, amount);

        emit RewardsClaimed(msg.sender, amount, currentSeason);
    }

    /**
     * @notice Toggle claims on/off
     * @param enabled Whether claims should be enabled
     */
    function setClaimsEnabled(bool enabled) external onlyOwner {
        claimsEnabled = enabled;
        emit ClaimsEnabled(enabled);
    }

    /**
     * @notice Update the merkle root (upgradeable functionality)
     * @param newMerkleRoot The new merkle root
     * @param resetClaims Whether to reset all claim states
     */
    function updateMerkleRoot(bytes32 newMerkleRoot, bool resetClaims, uint256 newSeason) external onlyOwner {
        if (newMerkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (newSeason == 0) revert InvalidSeason();

        bytes32 oldRoot = merkleRoot;
        merkleRoot = newMerkleRoot;
        currentSeason = newSeason;

        if (resetClaims) {
            totalClaimed[newSeason] = 0;
        }

        emit MerkleRootUpdated(oldRoot, newMerkleRoot, newSeason);
    }

    /**
     * @notice Set the collateral token
     * @param _collateral The new collateral token
     */
    function setCollateral(address _collateral) external onlyOwner {
        collateral = IERC20(_collateral);
        emit RewardsCollateralUpdated(_collateral);
    }

    /**
     * @notice Emergency withdraw function for owner
     * @param amount Amount to withdraw (0 = all)
     * @param recipient Address to send tokens to
     */
    function withdrawCollateral(uint256 amount, address recipient) external onlyOwner {
        if (recipient == address(0)) revert InvalidRecipient();

        uint256 balance = collateral.balanceOf(address(this));
        uint256 withdrawAmount = amount > balance ? balance : amount;

        collateral.safeTransfer(recipient, withdrawAmount);

        emit CollateralWithdrawn(withdrawAmount, recipient);
    }

    /* ========== EVENTS ========== */

    event RewardsClaimed(address indexed account, uint256 amount, uint256 round);

    event MerkleRootUpdated(bytes32 oldRoot, bytes32 newRoot, uint256 newRound);

    event ClaimsEnabled(bool enabled);

    event RewardsCollateralUpdated(address indexed collateral);

    event CollateralWithdrawn(uint256 amount, address indexed recipient);
}
