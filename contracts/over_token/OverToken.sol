// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OverToken - Overtime DAO Token
/// @notice This contract implements an ERC20 token for the Overtime DAO.
/// @dev This contract includes owner management and CCIP admin functionality.
contract OverToken is ERC20 {
    /// @notice The name of the token
    string private __name = "Overtime DAO Token";
    /// @notice The symbol of the token
    string private __symbol = "OVER";
    /// @notice The number of decimals for the token
    uint8 private constant __decimals = 18;
    /// @notice The initial total supply of tokens
    uint private constant INITIAL_TOTAL_SUPPLY = 69420000;

    /// @notice The owner of the contract
    address public owner;
    /// @notice The admin responsible for CCIP operations
    address public ccipAdmin;

    /// @notice Deploys the token contract and mints the initial supply to the treasury
    /// @param _treasury The address of the treasury that receives the initial supply
    constructor(address _treasury) ERC20(__name, __symbol) {
        owner = _treasury;
        ccipAdmin = _treasury;
        _mint(_treasury, INITIAL_TOTAL_SUPPLY * 1e18);
    }

    /// @notice Retrieves the current CCIP admin address
    /// @return The address of the CCIP admin
    function getCCIPAdmin() external view returns (address) {
        return ccipAdmin;
    }

    /// @notice Sets a new CCIP admin
    /// @dev Only callable by the contract owner
    /// @param _ccipAdmin The address of the new CCIP admin
    function setCCIPAdmin(address _ccipAdmin) external {
        require(msg.sender == owner, "OnlyAllowedFromOwner");
        ccipAdmin = _ccipAdmin;
        emit SetCCIPAdmin(_ccipAdmin);
    }

    /// @notice Transfers ownership of the contract to a new owner
    /// @dev Only callable by the current owner
    /// @param _newOwner The address of the new owner
    function changeOwner(address _newOwner) external {
        require(msg.sender == owner, "OnlyAllowedFromOwner");
        owner = _newOwner;
        emit OwnerChanged(_newOwner);
    }

    /// @notice Emitted when a new CCIP admin is set
    /// @param newCCIPAdmin The address of the new CCIP admin
    event SetCCIPAdmin(address newCCIPAdmin);
    /// @notice Emitted when ownership of the contract is transferred
    /// @param _newOwner The address of the new owner
    event OwnerChanged(address _newOwner);
}
