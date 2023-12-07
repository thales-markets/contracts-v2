// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

// internal
import "../utils/proxy/ProxyReentrancyGuard.sol";
import "../utils/proxy/ProxyOwned.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2 is Initializable, ProxyOwned, PausableUpgradeable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Merkle tree root
    bytes32 public root;

    /// The default token used for payment
    IERC20 public defaultPaymentToken;

    /// @notice Initialize the storage in the proxy contract with the parameters.
    /// @param _owner Owner for using the onlyOwner functions
    /// @param _defaultPaymentToken The address of default token used for payment
    function initialize(address _owner, IERC20 _defaultPaymentToken) public initializer {
        setOwner(_owner);
        initNonReentrant();
        defaultPaymentToken = _defaultPaymentToken;
    }

    /// @notice Calculate the sUSD cost to buy an amount of available position options from AMM for specific market/game
    /// @param market The address of the SportPositional market of a game
    /// @param sportId tag id for sport
    /// @param allBaseOdds all base odds for given market
    /// @param merkleProof merkle proof for check
    /// @return _quote The sUSD cost for buying the `amount` of `position` options (tokens) from AMM for `market`.
    function buyFromAmmQuote(
        address market,
        uint sportId,
        uint[] memory allBaseOdds,
        bytes32[] memory merkleProof
    ) public view returns (uint _quote) {
        // Compute the merkle leaf from market, sportId and all odds
        bytes32 leaf = keccak256(
            allBaseOdds.length > 2
                ? abi.encodePacked(market, sportId, allBaseOdds[0], allBaseOdds[1], allBaseOdds[2])
                : abi.encodePacked(market, sportId, allBaseOdds[0], allBaseOdds[1])
        );
        // verify the proof is valid
        require(MerkleProof.verify(merkleProof, root, leaf), "Proof is not valid");

        _quote = 1;
    }

    // @notice Set root of merkle tree
    /// @param _root New root
    function setRoot(bytes32 _root) public onlyOwner {
        root = _root;
        emit NewRoot(_root);
    }

    /// @notice Setting the main addresses for SportsAMMV2
    /// @param _defaultPaymentToken Address of the default payment token
    function setAddresses(IERC20 _defaultPaymentToken) external onlyOwner {
        defaultPaymentToken = _defaultPaymentToken;

        emit AddressesUpdated(_defaultPaymentToken);
    }

    event NewRoot(bytes32 root);
    event AddressesUpdated(IERC20 _defaultPaymentToken);
}
