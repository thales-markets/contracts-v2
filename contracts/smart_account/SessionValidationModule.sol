// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ECDSA} from "./openzeppelin/ECDSA.sol";

/**
 * @title SessionValidationModule
 * @dev This contract manages session validation for user operations.
 * It includes an owner-managed whitelist of allowed contract addresses.
 */
contract SessionValidationModule is Initializable {
    /**
     * @notice User Operation struct
     * @dev Represents a user operation that must be validated before execution.
     */
    struct UserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        uint256 callGasLimit;
        uint256 verificationGasLimit;
        uint256 preVerificationGas;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        bytes paymasterAndData;
        bytes signature;
    }

    /// @notice Mapping of whitelisted contract addresses
    mapping(address => bool) public whitelistedContracts;

    /// @notice Address of the contract owner
    address public owner;

    /// @notice Emitted when the contract owner is changed
    /// @param previousOwner The previous owner of the contract
    /// @param newOwner The new owner of the contract
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted when a contract's whitelist status is updated
    /// @param contractAddress The contract address that was updated
    /// @param isWhitelisted True if added to the whitelist, false if removed
    event WhitelistUpdated(address indexed contractAddress, bool isWhitelisted);

    /// @notice Ensures that only the owner can call the function
    modifier onlyOwner() {
        require(msg.sender == owner, "Not the owner");
        _;
    }

    /**
     * @notice Initializes the contract with the owner and a list of whitelisted contracts
     * @param _owner Address of the initial contract owner
     * @param _whitelistedContracts List of contract addresses to whitelist
     */
    function initialize(address _owner, address[] calldata _whitelistedContracts) external initializer {
        require(owner == address(0), "Already initialized"); // Prevents re-initialization
        require(_owner != address(0), "Owner cannot be zero address");
        owner = _owner;

        for (uint256 i = 0; i < _whitelistedContracts.length; i++) {
            whitelistedContracts[_whitelistedContracts[i]] = true;
        }
    }

    /**
     * @notice Transfers ownership of the contract to a new address
     * @dev Only the current owner can call this function
     * @param newOwner The address of the new owner
     */
    function changeOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner cannot be zero address");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Updates the whitelist status of a contract
     * @dev Only the owner can call this function
     * @param contractAddress The address of the contract to update
     * @param isWhitelisted Boolean flag to add (true) or remove (false) from the whitelist
     */
    function updateWhitelist(address contractAddress, bool isWhitelisted) external onlyOwner {
        require(contractAddress != address(0), "Invalid contract address");
        whitelistedContracts[contractAddress] = isWhitelisted;
        emit WhitelistUpdated(contractAddress, isWhitelisted);
    }

    /**
     * @notice Validates if the `_op` (UserOperation) matches the SessionKey permissions
     * and that `_op` has been signed by this SessionKey
     * @param _op User Operation to be validated
     * @param _userOpHash Hash of the User Operation to be validated
     * @param _sessionKeyData SessionKey data that describes sessionKey permissions
     * @param _sessionKeySignature Signature over the `_userOpHash`
     * @return True if the `_op` is valid, false otherwise
     */
    function validateSessionUserOp(
        UserOperation calldata _op,
        bytes32 _userOpHash,
        bytes calldata _sessionKeyData,
        bytes calldata _sessionKeySignature
    ) external view returns (bool) {
        bytes calldata callData = _op.callData;
        address sessionKey;
        address destContract;
        address destContract2;

        assembly {
            // Extract the session key from the sessionKeyData
            sessionKey := shr(96, calldataload(_sessionKeyData.offset))

            // Extract destination contracts from callData
            destContract := calldataload(add(callData.offset, 0x4))
            destContract2 := calldataload(add(callData.offset, 0xa4))
        }

        // Check if the destination contract(s) are whitelisted
        require(whitelistedContracts[destContract] || whitelistedContracts[destContract2], "DestContractNotWhitelisted");
        return address(sessionKey) == ECDSA.recover(ECDSA.toEthSignedMessageHash(_userOpHash), _sessionKeySignature);
    }
}
