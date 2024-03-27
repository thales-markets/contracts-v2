// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// external
import "@thales-dao/contracts/contracts/AddressManager/AddressManager.sol";

contract AddressManagerExtension is AddressManager {
    /// @notice Get address from the addressBook based on the contract name
    /// @param _contractName name of the contract
    /// @return contract_ the address of the contract
    function getAddressForName(string calldata _contractName) external view returns (address contract_) {
        if (addressBook[_contractName] == address(0)) revert InvalidAddressForContractName(_contractName);
        contract_ = addressBook[_contractName];
    }
}
