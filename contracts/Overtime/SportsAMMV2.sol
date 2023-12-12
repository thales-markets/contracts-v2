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

    uint private constant ONE = 1e18;

    struct TradeData {
        bytes32 gameId;
        uint16 sportId;
        uint16 typeId;
        uint16 playerPropsTypeId;
        uint maturityDate;
        uint8 status;
        int24 line;
        uint16 playerId;
        uint[] odds;
        bytes32[] merkleProof;
        uint16 position;
    }

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

    function tradeQuote(
        TradeData[] calldata tradeData,
        uint buyInAmount
    )
        external
        view
        returns (
            uint buyInAmountAfterFees,
            uint payout,
            uint totalQuote,
            uint[] memory finalQuotes,
            uint[] memory amountsToBuy
        )
    {
        uint numOfPositions = tradeData.length;
        finalQuotes = new uint[](numOfPositions);
        amountsToBuy = new uint[](numOfPositions);
        buyInAmountAfterFees = ((ONE - ((1e16 + 1e16))) * buyInAmount) / ONE;

        for (uint i = 0; i < numOfPositions; i++) {
            TradeData memory tradeDataItem = tradeData[i];

            _verifyMerkleTree(tradeDataItem);

            finalQuotes[i] = tradeDataItem.odds[tradeDataItem.position];
            if (finalQuotes[i] > 0) {
                amountsToBuy[i] = (ONE * buyInAmountAfterFees) / finalQuotes[i];
            }
            totalQuote = totalQuote == 0 ? finalQuotes[i] : (totalQuote * finalQuotes[i]) / ONE;
        }
        if (totalQuote != 0) {
            payout = (buyInAmountAfterFees * ONE) / totalQuote;
        }
    }

    function _verifyMerkleTree(TradeData memory tradeDataItem) internal view {
        // Compute the merkle leaf from trade data
        bytes32 leaf = keccak256(
            abi.encodePacked(
                tradeDataItem.gameId,
                tradeDataItem.sportId,
                tradeDataItem.typeId,
                tradeDataItem.playerPropsTypeId,
                tradeDataItem.maturityDate,
                tradeDataItem.status,
                tradeDataItem.line,
                tradeDataItem.playerId,
                tradeDataItem.odds[0],
                tradeDataItem.odds[1],
                tradeDataItem.odds[2]
            )
        );
        // verify the proof is valid
        require(MerkleProof.verify(tradeDataItem.merkleProof, root, leaf), "Proof is not valid");
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
