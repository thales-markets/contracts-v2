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
import "../interfaces/ISportsAMMV2.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2 is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;
    using AddressSetLib for AddressSetLib.AddressSet;

    uint private constant ONE = 1e18;
    uint private constant MAX_APPROVAL = type(uint256).max;

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
        uint8 position;
    }

    /// Merkle tree root
    mapping(bytes32 => bytes32) public rootPerGame;

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

    mapping(bytes32 => mapping(uint => mapping(uint => ISportsAMMV2.GameScore))) public gameScores;
    mapping(bytes32 => mapping(uint => mapping(uint => bool))) public isScoreSetForGame;

    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => mapping(uint => bool))))) public isGameCanceled;

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
        TradeData[] calldata _tradeData,
        uint _buyInAmount
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
        (buyInAmountAfterFees, payout, totalQuote, finalQuotes, amountsToBuy) = _tradeQuote(_tradeData, _buyInAmount);
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

    function isGameResolved(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerPropsTypeId,
        uint16 _playerId
    ) external view returns (bool) {
        return
            isScoreSetForGame[_gameId][_playerPropsTypeId][_playerId] ||
            isGameCanceled[_gameId][_sportId][_typeId][_playerPropsTypeId][_playerId];
    }

    function getGameResult(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerPropsTypeId,
        uint16 _playerId,
        int24 _line
    ) external view returns (uint result) {
        if (isGameCanceled[_gameId][_sportId][_typeId][_playerPropsTypeId][_playerId]) {
            return result;
        }

        ISportsAMMV2.GameScore memory gameScore = gameScores[_gameId][_playerPropsTypeId][_playerId];

        if (_typeId == 0) {
            if (gameScore.homeScore == gameScore.awayScore) {
                result = 0;
            }
            result = gameScore.homeScore > gameScore.awayScore ? 1 : 2;
        } else {
            if (_playerPropsTypeId == 0) {
                if (_typeId == 10001) {
                    result = _getResultSpread(int24(gameScore.homeScore), int24(gameScore.awayScore), _line);
                } else {
                    result = _getResultTotal(int24(gameScore.homeScore), int24(gameScore.awayScore), _line);
                }
            } else {
                result = _getResultPlayerProps(int24(gameScore.homeScore), _line);
            }
        }
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    function trade(
        TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        address _referrer,
        address _collateral,
        bool _isEth
    ) external payable nonReentrant notPaused {
        if (_referrer != address(0)) {
            IReferrals(referrals).setReferrer(_referrer, msg.sender);
        }

        if (_differentRecipient == address(0)) {
            _differentRecipient = msg.sender;
        }

        if (_collateral != address(0)) {
            _handleDifferentCollateral(_buyInAmount, _collateral, _isEth);
        }

        _trade(
            _tradeData,
            _buyInAmount,
            _expectedPayout,
            _additionalSlippage,
            _differentRecipient,
            _collateral == address(0)
        );
    }

    function setScoreForGame(
        bytes32 _gameId,
        uint16 _playerPropsTypeId,
        uint16 _playerId,
        uint24 _homeScore,
        uint24 _awayScore
    ) external onlyOwner {
        require(!isScoreSetForGame[_gameId][_playerPropsTypeId][_playerId], "Score already set for the game");
        gameScores[_gameId][_playerPropsTypeId][_playerId] = ISportsAMMV2.GameScore(_homeScore, _awayScore);
        isScoreSetForGame[_gameId][_playerPropsTypeId][_playerId] = true;
        emit ScoreSetForGame(_gameId, _playerPropsTypeId, _playerId, _homeScore, _awayScore);
    }

    function cancelGame(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _typeId,
        uint16 _playerPropsTypeId,
        uint16 _playerId
    ) external onlyOwner {
        require(!isGameCanceled[_gameId][_sportId][_typeId][_playerPropsTypeId][_playerId], "Game already canceled");
        isGameCanceled[_gameId][_sportId][_typeId][_playerPropsTypeId][_playerId] = true;
        emit GameCanceled(_gameId, _sportId, _typeId, _playerPropsTypeId, _playerId);
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
        TradeData[] memory _tradeData,
        uint _buyInAmount
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
        uint numOfPositions = _tradeData.length;
        finalQuotes = new uint[](numOfPositions);
        amountsToBuy = new uint[](numOfPositions);
        buyInAmountAfterFees = ((ONE - ((safeBoxFee + lpFee))) * _buyInAmount) / ONE;

        for (uint i = 0; i < numOfPositions; i++) {
            TradeData memory tradeDataItem = _tradeData[i];

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

    function _handleDifferentCollateral(
        uint _buyInAmount,
        address _collateral,
        bool _isEth
    ) internal nonReentrant notPaused {
        require(multicollateralEnabled, "Multi collateral not enabled");
        uint collateralQuote = multiCollateralOnOffRamp.getMinimumNeeded(_collateral, _buyInAmount);

        uint exactReceived;

        if (_isEth) {
            require(_collateral == multiCollateralOnOffRamp.WETH9(), "Wrong collateral sent");
            require(msg.value >= collateralQuote, "Not enough ETH sent");
            exactReceived = multiCollateralOnOffRamp.onrampWithEth{value: msg.value}(msg.value);
        } else {
            IERC20(_collateral).safeTransferFrom(msg.sender, address(this), collateralQuote);
            IERC20(_collateral).approve(address(multiCollateralOnOffRamp), collateralQuote);
            exactReceived = multiCollateralOnOffRamp.onramp(_collateral, collateralQuote);
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
        bool _sendDefaultPaymentToken
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

        if (_sendDefaultPaymentToken) {
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
                uint(tradeDataItem.sportId),
                uint(tradeDataItem.typeId),
                uint(tradeDataItem.playerPropsTypeId),
                tradeDataItem.maturityDate,
                uint(tradeDataItem.status),
                int(tradeDataItem.line),
                uint(tradeDataItem.playerId),
                tradeDataItem.odds[0],
                tradeDataItem.odds[1],
                tradeDataItem.odds[2]
            )
        );
        // verify the proof is valid
        require(
            MerkleProof.verify(tradeDataItem.merkleProof, rootPerGame[tradeDataItem.gameId], leaf),
            "Proof is not valid"
        );
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

    function _getResultTotal(int24 _homeScore, int24 _awayScore, int24 _line) internal pure returns (uint) {
        return (_homeScore + _awayScore) * 100 > _line ? 1 : (_homeScore + _awayScore) * 100 < _line ? 2 : 0;
    }

    function _getResultSpread(int24 _homeScore, int24 _awayScore, int24 _line) internal pure returns (uint) {
        int24 homeScoreWithSpread = _homeScore * 100 + _line;
        int24 newAwayScore = _awayScore * 100;

        return homeScoreWithSpread > newAwayScore ? 1 : homeScoreWithSpread < newAwayScore ? 2 : 0;
    }

    function _getResultPlayerProps(int24 _score, int24 _line) internal pure returns (uint) {
        return _score * 100 > _line ? 1 : _score * 100 < _line ? 2 : 0;
    }

    /* ========== SETTERS ========== */

    /// @notice Set root of merkle tree
    /// @param _game Game ID
    /// @param _root New root
    function setRootPerGame(bytes32 _game, bytes32 _root) public onlyOwner {
        rootPerGame[_game] = _root;
        emit NewRoot(_game, _root);
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

    function setMultiCollateralOnOffRamp(address _onOffRamper, bool _enabled) external onlyOwner {
        if (address(multiCollateralOnOffRamp) != address(0)) {
            defaultPaymentToken.approve(address(multiCollateralOnOffRamp), 0);
        }
        multiCollateralOnOffRamp = IMultiCollateralOnOffRamp(_onOffRamper);
        multicollateralEnabled = _enabled;
        defaultPaymentToken.approve(_onOffRamper, MAX_APPROVAL);
        emit SetMultiCollateralOnOffRamp(_onOffRamper, _enabled);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyKnownTickets(address _ticket) {
        require(knownTickets.contains(_ticket), "Unknown ticket");
        _;
    }

    /* ========== EVENTS ========== */

    event NewRoot(bytes32 game, bytes32 root);
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
    event ScoreSetForGame(bytes32 gameId, uint16 playerPropsTypeId, uint16 playerId, uint24 homeScore, uint24 awayScore);
    event GameCanceled(bytes32 gameId, uint16 sportId, uint16 typeId, uint16 playerPropsTypeId, uint16 playerId);
    event SetMultiCollateralOnOffRamp(address onOffRamper, bool enabled);
}
