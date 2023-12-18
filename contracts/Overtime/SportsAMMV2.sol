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
import "../utils/libraries/AddressSetLib.sol";

import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";
import "@thales-dao/contracts/contracts/interfaces/IMultiCollateralOnOffRamp.sol";

import "./Ticket.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2 is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;
    using AddressSetLib for AddressSetLib.AddressSet;

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

    mapping(address => uint) public lpFeePerAddress;
    mapping(address => uint) public safeBoxFeePerAddress;

    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => uint)))) public gameResults;
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => bool)))) public isGameResolved;

    AddressSetLib.AddressSet internal knownTickets;

    IMultiCollateralOnOffRamp public multiCollateralOnOffRamp;
    bool public multicollateralEnabled;

    /* ========== CONSTRUCTOR ========== */

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

    /* ========== EXTERNAL READ FUNCTIONS ========== */

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

    function isActiveTicket(address _ticket) external view returns (bool) {
        return knownTickets.contains(_ticket);
    }

    function getActiveTickets(uint _index, uint _pageSize) external view returns (address[] memory) {
        return knownTickets.getPage(_index, _pageSize);
    }

    function numOfActiveTickets() external view returns (uint) {
        return knownTickets.elements.length;
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    function trade(
        TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        address _referrer,
        address collateral,
        bool isEth
    ) external payable nonReentrant notPaused {
        if (_referrer != address(0)) {
            IReferrals(referrals).setReferrer(_referrer, msg.sender);
        }

        if (_differentRecipient == address(0)) {
            _differentRecipient = msg.sender;
        }

        if (collateral != address(0)) {
            _handleDifferentCollateral(_buyInAmount, collateral, isEth);
        }

        _trade(
            _tradeData,
            _buyInAmount,
            _expectedPayout,
            _additionalSlippage,
            _differentRecipient,
            collateral == address(0)
        );
    }

    function resolveGame(
        bytes32 _gameId,
        uint _sportId,
        uint _typeId,
        uint _playerPropsTypeId,
        uint _result
    ) external onlyOwner {
        require(!isGameResolved[_gameId][_sportId][_typeId][_playerPropsTypeId], "Game already resolved");
        gameResults[_gameId][_sportId][_typeId][_playerPropsTypeId] = _result;
        isGameResolved[_gameId][_sportId][_typeId][_playerPropsTypeId] = true;
        emit GameResolved(_gameId, _sportId, _typeId, _playerPropsTypeId, _result);
    }

    function exerciseTicket(address _ticket) external nonReentrant notPaused onlyKnownTickets(_ticket) {
        _exerciseTicket(_ticket);
    }

    function resolveTicket(address _account, bool _hasUserWon) external notPaused onlyKnownTickets(msg.sender) {
        knownTickets.remove(msg.sender);
        emit TicketResolved(msg.sender, _account, _hasUserWon);
    }

    function setPausedTickets(address[] calldata _tickets, bool _paused) external onlyOwner {
        for (uint i = 0; i < _tickets.length; i++) {
            Ticket(_tickets[i]).setPaused(_paused);
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

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

    function _handleDifferentCollateral(uint _buyInAmount, address collateral, bool isEth) internal nonReentrant notPaused {
        uint collateralQuote = multiCollateralOnOffRamp.getMinimumNeeded(collateral, _buyInAmount);

        uint exactReceived;

        if (isEth) {
            require(collateral == multiCollateralOnOffRamp.WETH9(), "Wrong collateral sent");
            require(msg.value >= collateralQuote, "Not enough ETH sent");
            exactReceived = multiCollateralOnOffRamp.onrampWithEth{value: msg.value}(msg.value);
        } else {
            IERC20(collateral).safeTransferFrom(msg.sender, address(this), collateralQuote);
            IERC20(collateral).approve(address(multiCollateralOnOffRamp), collateralQuote);
            exactReceived = multiCollateralOnOffRamp.onramp(collateral, collateralQuote);
        }

        require(exactReceived >= _buyInAmount, "Not enough default payment token received");

        //send the surplus to SB
        if (exactReceived > _buyInAmount) {
            defaultPaymentToken.safeTransfer(safeBox, exactReceived - _buyInAmount);
        }
    }

    function _trade(
        TradeData[] memory _tradeData,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        bool sendDefaultPaymentToken
    ) internal {
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

        if (sendDefaultPaymentToken) {
            defaultPaymentToken.safeTransferFrom(msg.sender, address(this), _buyInAmount);
        }

        uint safeBoxAmount = _handleReferrerAndSB(_buyInAmount, buyInAmountAfterFees);

        // clone a ticket
        Ticket.GameData[] memory gameData = _getTicketData(_tradeData);
        Ticket ticket = Ticket(Clones.clone(ticketMastercopy));
        ticket.initialize(gameData, buyInAmountAfterFees, totalQuote, address(this), _differentRecipient);
        knownTickets.add(address(ticket));

        defaultPaymentToken.safeTransfer(address(ticket), payout);

        emit NewTicket(gameData, address(ticket), buyInAmountAfterFees, payout);
        emit TicketCreated(
            address(ticket),
            _differentRecipient,
            _buyInAmount,
            buyInAmountAfterFees,
            payout,
            totalQuote,
            safeBoxAmount
        );
    }

    function _getTicketData(TradeData[] memory _tradeData) internal pure returns (Ticket.GameData[] memory gameData) {
        gameData = new Ticket.GameData[](_tradeData.length);

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
    }

    function _handleReferrerAndSB(uint _buyInAmount, uint _buyInAmountAfterFees) internal returns (uint safeBoxAmount) {
        uint referrerShare;
        address referrer = IReferrals(referrals).sportReferrals(msg.sender);
        if (referrer != address(0)) {
            uint referrerFeeByTier = IReferrals(referrals).getReferrerFee(referrer);
            if (referrerFeeByTier > 0) {
                referrerShare = (_buyInAmount * referrerFeeByTier) / ONE;
                defaultPaymentToken.safeTransfer(referrer, referrerShare);
                emit ReferrerPaid(referrer, msg.sender, referrerShare, _buyInAmount);
            }
        }
        safeBoxAmount = _getSafeBoxAmount(_buyInAmount, _buyInAmountAfterFees, msg.sender);
        defaultPaymentToken.safeTransfer(safeBox, safeBoxAmount - referrerShare);
    }

    function _getSafeBoxAmount(
        uint _buyInAmount,
        uint _buyInAmountAfterFees,
        address _toCheck
    ) internal view returns (uint safeBoxAmount) {
        uint sbFee = _getSafeBoxFeePerAddress(_toCheck);
        safeBoxAmount = ((_buyInAmount - _buyInAmountAfterFees) * sbFee) / (sbFee + _getLpFeePerAddress(_toCheck));
    }

    function _getSafeBoxFeePerAddress(address _toCheck) internal view returns (uint toReturn) {
        return safeBoxFeePerAddress[_toCheck] > 0 ? safeBoxFeePerAddress[_toCheck] : safeBoxFee;
    }

    function _getLpFeePerAddress(address _toCheck) internal view returns (uint toReturn) {
        return lpFeePerAddress[_toCheck] > 0 ? lpFeePerAddress[_toCheck] : lpFee;
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

    function _exerciseTicket(address _ticket) internal {
        Ticket ticket = Ticket(_ticket);
        ticket.exercise();
        // TODO: LP
        // uint amount = sUSD.balanceOf(address(this));
        // if (amount > 0) {
        //     IParlayAMMLiquidityPool(parlayLP).transferToPool(_parlayMarket, amount);
        // }
    }

    /* ========== SETTERS ========== */

    /// @notice Set root of merkle tree
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

    /* ========== MODIFIERS ========== */

    modifier onlyKnownTickets(address _ticket) {
        require(knownTickets.contains(_ticket), "Unknown ticket");
        _;
    }

    /* ========== EVENTS ========== */

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
    event NewTicket(Ticket.GameData[] tradeData, address ticket, uint buyInAmountAfterFees, uint payout);
    event TicketCreated(
        address ticket,
        address differentRecipient,
        uint buyInAmount,
        uint buyInAmountAfterFees,
        uint payout,
        uint totalQuote,
        uint safeBoxAmount
    );
    event TicketResolved(address ticket, address ticketOwner, bool isUserTheWinner);
    event ReferrerPaid(address refferer, address trader, uint amount, uint volume);
    event GameResolved(bytes32 gameId, uint sportId, uint typeId, uint playerPropsTypeId, uint result);
}
