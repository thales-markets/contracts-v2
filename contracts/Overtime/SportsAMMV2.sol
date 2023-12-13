// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

// internal
import "../utils/proxy/ProxyReentrancyGuard.sol";
import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";

import "./Ticket.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2 is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    uint private constant ONE = 1e18;

    struct TradeData {
        bytes32 gameId;
        uint sportId;
        uint typeId;
        uint playerPropsTypeId;
        uint maturityDate;
        uint status;
        uint line;
        uint playerId;
        uint[] odds;
        bytes32[] merkleProof;
        uint position;
    }

    /// Merkle tree root
    bytes32 public root;

    /// The default token used for payment
    IERC20 public defaultPaymentToken;

    address public ticketMastercopy;
    address public safeBox;
    address public referrals;

    uint public lpFee;
    uint public safeBoxFee;

    uint public minBuyInAmount;
    uint public maxTicketSize;
    uint public maxSupportedAmount;
    uint public maxSupportedOdds;

    /// @notice Initialize the storage in the proxy contract with the parameters.
    /// @param _owner Owner for using the onlyOwner functions
    /// @param _defaultPaymentToken The address of default token used for payment
    function initialize(
        address _owner,
        IERC20 _defaultPaymentToken,
        address _safeBox,
        address _referrals,
        uint _minBuyInAmount,
        uint _maxTicketSize,
        uint _maxSupportedAmount,
        uint _maxSupportedOdds,
        uint _lpFee,
        uint _safeBoxFee
    ) public initializer {
        setOwner(_owner);
        initNonReentrant();
        defaultPaymentToken = _defaultPaymentToken;
        safeBox = _safeBox;
        referrals = _referrals;
        minBuyInAmount = _minBuyInAmount;
        maxTicketSize = _maxTicketSize;
        maxSupportedAmount = _maxSupportedAmount;
        maxSupportedOdds = _maxSupportedOdds;
        lpFee = _lpFee;
        safeBoxFee = _safeBoxFee;
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
        (buyInAmountAfterFees, payout, totalQuote, finalQuotes, amountsToBuy) = _tradeQuote(tradeData, buyInAmount);
    }

    function trade(
        TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient
    ) external nonReentrant notPaused {
        uint payout;
        uint totalQuote;
        uint[] memory amountsToBuy = new uint[](_tradeData.length);
        uint[] memory finalQuotes = new uint[](_tradeData.length);
        uint buyInAmountAfterFees;
        (buyInAmountAfterFees, payout, totalQuote, finalQuotes, amountsToBuy) = _tradeQuote(_tradeData, _buyInAmount);

        // apply all checks
        require(_buyInAmount >= minBuyInAmount, "Low buy-in amount");
        require(totalQuote >= maxSupportedOdds, "Exceeded max supported odds");
        require((payout - _buyInAmount) <= maxSupportedAmount, "Exceeded max supported amount");
        require(((ONE * _expectedPayout) / payout) <= (ONE + _additionalSlippage), "Slippage too high");

        if (_differentRecipient == address(0)) {
            _differentRecipient = msg.sender;
        }

        defaultPaymentToken.safeTransferFrom(msg.sender, address(this), _buyInAmount);

        // clone a ticket
        Ticket.GameData[] memory gameData = new Ticket.GameData[](_tradeData.length);

        for (uint i = 0; i < _tradeData.length; i++) {
            TradeData memory tradeDataItem = _tradeData[i];

            gameData[i] = Ticket.GameData(
                tradeDataItem.gameId,
                tradeDataItem.sportId,
                tradeDataItem.typeId,
                tradeDataItem.playerPropsTypeId,
                tradeDataItem.maturityDate,
                tradeDataItem.status,
                tradeDataItem.line,
                tradeDataItem.playerId,
                tradeDataItem.position,
                tradeDataItem.odds[tradeDataItem.position]
            );
        }

        Ticket ticket = Ticket(Clones.clone(ticketMastercopy));
        ticket.initialize(gameData, buyInAmountAfterFees, payout, totalQuote, address(this), _differentRecipient);

        defaultPaymentToken.safeTransfer(address(ticket), payout);

        emit TicketCreated(
            gameData,
            address(ticket),
            _differentRecipient,
            _buyInAmount,
            buyInAmountAfterFees,
            payout,
            totalQuote
        );
    }

    function _tradeQuote(
        TradeData[] memory tradeData,
        uint buyInAmount
    )
        internal
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
        buyInAmountAfterFees = ((ONE - ((safeBoxFee + lpFee))) * buyInAmount) / ONE;

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

    function setAmounts(
        uint _minBuyInAmount,
        uint _maxTicketSize,
        uint _maxSupportedAmount,
        uint _maxSupportedOdds,
        uint _lpFee,
        uint _safeBoxFee
    ) external onlyOwner {
        minBuyInAmount = _minBuyInAmount;
        maxTicketSize = _maxTicketSize;
        maxSupportedAmount = _maxSupportedAmount;
        maxSupportedOdds = _maxSupportedOdds;
        lpFee = _lpFee;
        safeBoxFee = _safeBoxFee;
        emit SetAmounts(_minBuyInAmount, _maxTicketSize, _maxSupportedAmount, _maxSupportedOdds, _lpFee, _safeBoxFee);
    }

    /// @notice Setting the main addresses for SportsAMMV2
    /// @param _defaultPaymentToken Address of the default payment token
    function setAddresses(IERC20 _defaultPaymentToken, address _safeBox, address _referrals) external onlyOwner {
        defaultPaymentToken = _defaultPaymentToken;
        safeBox = _safeBox;
        referrals = _referrals;

        emit AddressesUpdated(_defaultPaymentToken, _safeBox, _referrals);
    }

    function setTicketMastercopy(address _ticketMastercopy) external onlyOwner {
        ticketMastercopy = _ticketMastercopy;
        emit NewTicketMastercopy(_ticketMastercopy);
    }

    event NewRoot(bytes32 root);
    event SetAmounts(
        uint minBuyInAmount,
        uint maxTicketSize,
        uint maxSupportedAmount,
        uint maxSupportedOdds,
        uint lpFee,
        uint safeBoxFee
    );
    event AddressesUpdated(IERC20 defaultPaymentToken, address safeBox, address referrals);
    event NewTicketMastercopy(address ticketMastercopy);
    event TicketCreated(
        Ticket.GameData[] tradeData,
        address ticket,
        address differentRecipient,
        uint buyInAmount,
        uint buyInAmountAfterFees,
        uint payout,
        uint totalQuote
    );
}
