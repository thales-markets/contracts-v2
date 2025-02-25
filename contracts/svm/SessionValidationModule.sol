// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ECDSA} from "./openzeppelin/ECDSA.sol";

contract SessionValidationModule is Initializable {
    /**
     * @notice User Operation struct
     * @param sender The sender account of this request
     * @param nonce Unique value the sender uses to verify it is not a replay
     * @param initCode If set, the account contract will be created by this constructor
     * @param callData The method call to execute on this account
     * @param verificationGasLimit Gas used for validateUserOp and validatePaymasterUserOp
     * @param preVerificationGas Gas not calculated by the handleOps method but added to the gas paid. Covers batch overhead.
     * @param maxFeePerGas Same as EIP-1559 gas parameter
     * @param maxPriorityFeePerGas Same as EIP-1559 gas parameter
     * @param paymasterAndData If set, this field holds the paymaster address and "paymaster-specific-data". The paymaster will pay for the transaction instead of the sender
     * @param signature Sender-verified signature over the entire request, the EntryPoint address, and the chain ID
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

    address public sportMarketsAMM;
    address public liveTradingProcessor;
    address public freeBetContract;
    address public stakingThalesContract;

    /**
     * @notice Initializes the contract with the given addresses
     * @param _sportMarketsAMM Address of the Sport Markets AMM contract
     * @param _liveTradingProcessor Address of the Live Trading Processor contract
     * @param _freeBetContract Address of the Free Bet contract
     * @param _stakingThalesContract Address of the Staking Thales contract
     */
    function initialize(
        address _sportMarketsAMM,
        address _liveTradingProcessor,
        address _freeBetContract,
        address _stakingThalesContract
    ) external initializer {
        sportMarketsAMM = _sportMarketsAMM;
        liveTradingProcessor = _liveTradingProcessor;
        freeBetContract = _freeBetContract;
        stakingThalesContract = _stakingThalesContract;
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
        uint160 destContract;
        uint160 destContract2;

        assembly {
            // Load the first 20 bytes of _sessionKeyData into sessionKey
            sessionKey := shr(96, calldataload(_sessionKeyData.offset))

            // Extract destination contracts from callData based on whether paymaster data is included
            destContract := calldataload(add(callData.offset, 0x4))
            destContract2 := calldataload(add(callData.offset, 0xa4))
        }

        if (
            address(destContract) == sportMarketsAMM ||
            address(destContract2) == sportMarketsAMM ||
            address(destContract) == liveTradingProcessor ||
            address(destContract2) == liveTradingProcessor ||
            address(destContract) == freeBetContract ||
            address(destContract2) == freeBetContract ||
            address(destContract) == stakingThalesContract ||
            address(destContract2) == stakingThalesContract
        ) {
            return address(sessionKey) == ECDSA.recover(ECDSA.toEthSignedMessageHash(_userOpHash), _sessionKeySignature);
        }
        revert("Forbidden destination");
    }
}
