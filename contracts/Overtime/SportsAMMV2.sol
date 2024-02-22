// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
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
import "@thales-dao/contracts/contracts/interfaces/IStakingThales.sol";

import "./Ticket.sol";
import "../interfaces/ISportsAMMV2.sol";
import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";
import "../interfaces/ISportsAMMV2LiquidityPool.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2 is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== LIBRARIES ========== */

    using SafeERC20 for IERC20;
    using AddressSetLib for AddressSetLib.AddressSet;

    /* ========== CONST VARIABLES ========== */

    uint private constant ONE = 1e18;
    uint private constant MAX_APPROVAL = type(uint256).max;

    uint public constant CHILD_ID_SPREAD = 10001;
    uint public constant CHILD_ID_TOTAL = 10002;
    uint public constant CHILD_ID_PLAYER_PROPS = 10010;

    /* ========== STRUCT DEFINITION ========== */

    struct TradeData {
        bytes32 gameId;
        uint16 sportId;
        uint16 childId;
        uint16 playerPropsId;
        uint maturity;
        uint8 status;
        int24 line;
        uint16 playerId;
        uint[] odds;
        bytes32[] merkleProof;
        uint8 position;
    }

    /* ========== STATE VARIABLES ========== */

    // merkle tree root per game
    mapping(bytes32 => bytes32) public rootPerGame;

    // the default token used for payment
    IERC20 public defaultCollateral;

    // manager address
    ISportsAMMV2Manager public manager;

    // risk manager address
    ISportsAMMV2RiskManager public riskManager;

    // referrals address
    IReferrals public referrals;

    // ticket mastercopy address
    address public ticketMastercopy;

    // safe box address
    address public safeBox;

    // safe box fee paid on each trade
    uint public safeBoxFee;

    // safe box fee per specific address paid on each trade
    mapping(address => uint) public safeBoxFeePerAddress;

    // minimum ticket buy-in amount
    uint public minBuyInAmount;

    // maximum ticket size
    uint public maxTicketSize;

    // maximum supported payout amount
    uint public maxSupportedAmount;

    // maximum supported ticket odds
    uint public maxSupportedOdds;

    // stores game scores, game defined with gameId -> playerPropsId -> playerId
    mapping(bytes32 => mapping(uint => mapping(uint => ISportsAMMV2.GameScore))) public gameScores;

    // indicates is score set for game, game defined with gameId -> playerPropsId -> playerId
    mapping(bytes32 => mapping(uint => mapping(uint => bool))) public isScoreSetForGame;

    // indicates is game explicitly cancelled, game defined with gameId -> sportId -> childId -> playerPropsId -> playerId -> line
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => mapping(uint => mapping(int => bool))))))
        public isGameCancelled;

    // stores active tickets
    AddressSetLib.AddressSet internal knownTickets;

    // multi-collateral on/off ramp address
    IMultiCollateralOnOffRamp public multiCollateralOnOffRamp;

    // is multi-collateral enabled
    bool public multicollateralEnabled;

    // stores current risk per game and position, game defined with gameId -> sportId -> childId -> playerPropsId -> playerId -> line
    mapping(bytes32 => mapping(uint => mapping(uint => mapping(uint => mapping(uint => mapping(int => mapping(uint => uint)))))))
        public riskPerGameAndPosition;

    // the period of time in seconds before a game is matured and begins to be restricted for AMM trading
    uint public minimalTimeLeftToMaturity;

    // the period of time in seconds after mauturity when ticket expires
    uint public expiryDuration;

    // liquidity pool address
    ISportsAMMV2LiquidityPool public liquidityPool;

    // staking thales address
    IStakingThales public stakingThales;

    // spent on parent market together with all children markets
    mapping(bytes32 => uint) public spentPerParent;

    // stores active tickets per user
    mapping(address => AddressSetLib.AddressSet) internal activeTicketsPerUser;

    // stores resolved tickets per user
    mapping(address => AddressSetLib.AddressSet) internal resolvedTicketsPerUser;

    // stores tickets per game
    mapping(bytes32 => AddressSetLib.AddressSet) internal ticketsPerGame;

    /* ========== CONSTRUCTOR ========== */

    /// @notice initialize the storage in the proxy contract with the parameters
    /// @param _owner owner for using the onlyOwner functions
    /// @param _defaultCollateral the address of default token used for payment
    /// @param _manager the address of manager
    /// @param _riskManager the address of risk manager
    /// @param _referrals the address of referrals
    /// @param _stakingThales the address of staking thales
    /// @param _safeBox the address of safe box
    function initialize(
        address _owner,
        IERC20 _defaultCollateral,
        ISportsAMMV2Manager _manager,
        ISportsAMMV2RiskManager _riskManager,
        IReferrals _referrals,
        IStakingThales _stakingThales,
        address _safeBox
    ) public initializer {
        setOwner(_owner);
        initNonReentrant();
        defaultCollateral = _defaultCollateral;
        manager = _manager;
        riskManager = _riskManager;
        referrals = _referrals;
        stakingThales = _stakingThales;
        safeBox = _safeBox;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice gets trade quote
    /// @param _tradeData trade data with all game info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _collateral different collateral used for payment
    /// @return collateralQuote buy-in amount in different collateral
    /// @return buyInAmountAfterFees ticket buy-in amount without fees
    /// @return payout expected payout
    /// @return totalQuote total ticket quote
    /// @return finalQuotes final quotes per game
    /// @return amountsToBuy amounts per game
    function tradeQuote(
        TradeData[] calldata _tradeData,
        uint _buyInAmount,
        address _collateral
    )
        external
        view
        returns (
            uint collateralQuote,
            uint buyInAmountAfterFees,
            uint payout,
            uint totalQuote,
            uint[] memory finalQuotes,
            uint[] memory amountsToBuy
        )
    {
        (buyInAmountAfterFees, payout, totalQuote, finalQuotes, amountsToBuy) = _tradeQuote(_tradeData, _buyInAmount);

        collateralQuote = _collateral == address(0)
            ? _buyInAmount
            : multiCollateralOnOffRamp.getMinimumNeeded(_collateral, _buyInAmount);
    }

    /// @notice is provided ticket active
    /// @param _ticket ticket address
    /// @return isActiveTicket true/false
    function isActiveTicket(address _ticket) external view returns (bool) {
        return knownTickets.contains(_ticket);
    }

    /// @notice gets batch of active tickets
    /// @param _index start index
    /// @param _pageSize batch size
    /// @return activeTickets
    function getActiveTickets(uint _index, uint _pageSize) external view returns (address[] memory) {
        return knownTickets.getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets
    /// @return numOfActiveTickets
    function numOfActiveTickets() external view returns (uint) {
        return knownTickets.elements.length;
    }

    /// @notice gets batch of active tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get active tickets for
    /// @return activeTickets
    function getActiveTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return activeTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of active tickets per user
    /// @param _user to get number of active tickets for
    /// @return numOfActiveTickets
    function numOfActiveTicketsPerUser(address _user) external view returns (uint) {
        return activeTicketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of resolved tickets per user
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _user to get resolved tickets for
    /// @return resolvedTickets
    function getResolvedTicketsPerUser(uint _index, uint _pageSize, address _user) external view returns (address[] memory) {
        return resolvedTicketsPerUser[_user].getPage(_index, _pageSize);
    }

    /// @notice gets number of resolved tickets per user
    /// @param _user to get number of resolved tickets for
    /// @return numOfResolvedTickets
    function numOfResolvedTicketsPerUser(address _user) external view returns (uint) {
        return resolvedTicketsPerUser[_user].elements.length;
    }

    /// @notice gets batch of tickets per game
    /// @param _index start index
    /// @param _pageSize batch size
    /// @param _gameId to get tickets for
    /// @return resolvedTickets
    function getTicketsPerGame(uint _index, uint _pageSize, bytes32 _gameId) external view returns (address[] memory) {
        return ticketsPerGame[_gameId].getPage(_index, _pageSize);
    }

    /// @notice gets number of tickets per game
    /// @param _gameId to get number of tickets for
    /// @return numOfTickets
    function numOfTicketsPerGame(bytes32 _gameId) external view returns (uint) {
        return ticketsPerGame[_gameId].elements.length;
    }

    // TODO: remove, for test only
    function removeTicketsForUser(address user) external {
        address[] memory ticketsArray = activeTicketsPerUser[user].getPage(0, 200);
        for (uint i = 0; i < ticketsArray.length; i++) {
            if (activeTicketsPerUser[user].contains(ticketsArray[i])) {
                activeTicketsPerUser[user].remove(ticketsArray[i]);
            }
            if (knownTickets.contains(ticketsArray[i])) {
                knownTickets.remove(ticketsArray[i]);
            }
        }
    }

    // TODO: remove, for test only
    function removeTicketsForGame(bytes32 gameId) external {
        address[] memory ticketsArray = ticketsPerGame[gameId].getPage(0, 200);
        for (uint i = 0; i < ticketsArray.length; i++) {
            if (ticketsPerGame[gameId].contains(ticketsArray[i])) {
                ticketsPerGame[gameId].remove(ticketsArray[i]);
            }
            if (knownTickets.contains(ticketsArray[i])) {
                knownTickets.remove(ticketsArray[i]);
            }
        }
    }

    /// @notice is specific game resolved
    /// @param _gameId game ID
    /// @param _sportId game ID
    /// @param _childId child ID (total, spread, player props)
    /// @param _playerPropsId player props ID (0 if not player props game)
    /// @param _playerId player ID (0 if not player props game)
    /// @param _line line
    /// @return isGameResolved true/false
    function isGameResolved(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        uint16 _playerId,
        int24 _line
    ) external view returns (bool) {
        return _isGameResolved(_gameId, _sportId, _childId, _playerPropsId, _playerId, _line);
    }

    function getGameResult(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        uint16 _playerId,
        int24 _line
    ) external view returns (ISportsAMMV2.GameResult result) {
        if (
            isGameCancelled[_gameId][_sportId][_childId][_playerPropsId][_playerId][_line] ||
            !isScoreSetForGame[_gameId][_playerPropsId][_playerId]
        ) {
            return result;
        }

        ISportsAMMV2.GameScore memory gameScore = gameScores[_gameId][_playerPropsId][_playerId];

        if (_childId == CHILD_ID_SPREAD) {
            result = _getResultSpread(int24(gameScore.homeScore), int24(gameScore.awayScore), _line);
        } else if (_childId == CHILD_ID_TOTAL) {
            result = _getResultTotal(int24(gameScore.homeScore), int24(gameScore.awayScore), _line);
        } else if (_childId == CHILD_ID_PLAYER_PROPS) {
            result = _getResultPlayerProps(int24(gameScore.homeScore), _line);
        } else {
            result = _getResultMoneyline(int24(gameScore.homeScore), int24(gameScore.awayScore));
        }
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice make a trade and create a ticket
    /// @param _tradeData trade data with all game info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedPayout expected payout got from quote method
    /// @param _additionalSlippage slippage tolerance
    /// @param _differentRecipient different recipent of the ticket
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    /// @param _isEth pay with ETH
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
            referrals.setReferrer(_referrer, msg.sender);
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

    /// @notice set score for specific game
    /// @param _gameId game ID
    /// @param _playerPropsId player props ID (0 if not player props game)
    /// @param _playerId player ID (0 if not player props game)
    /// @param _homeScore home (first) team score
    /// @param _awayScore away (second) team score (0 if player props or game with one side)
    function setScoreForGame(
        bytes32 _gameId,
        uint16 _playerPropsId,
        uint16 _playerId,
        uint24 _homeScore,
        uint24 _awayScore
    ) external onlyOwner {
        require(!isScoreSetForGame[_gameId][_playerPropsId][_playerId], "Score already set for the game");
        gameScores[_gameId][_playerPropsId][_playerId] = ISportsAMMV2.GameScore(_homeScore, _awayScore);
        isScoreSetForGame[_gameId][_playerPropsId][_playerId] = true;
        emit ScoreSetForGame(_gameId, _playerPropsId, _playerId, _homeScore, _awayScore);
    }

    /// @notice cancel specific game
    /// @param _gameId game ID
    /// @param _sportId sport ID
    /// @param _childId child ID (total, spread, player props)
    /// @param _playerPropsId player props ID (0 if not player props game)
    /// @param _playerId player ID (0 if not player props game)
    /// @param _lineId line ID
    function cancelGame(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        int16 _lineId,
        uint16 _playerId
    ) external onlyOwner {
        require(!isGameCancelled[_gameId][_sportId][_childId][_playerPropsId][_playerId][_lineId], "Game already cancelled");
        isGameCancelled[_gameId][_sportId][_childId][_playerPropsId][_playerId][_lineId] = true;
        emit GameCancelled(_gameId, _sportId, _childId, _playerPropsId, _playerId);
    }

    /// @notice exercise specific ticket
    /// @param _ticket ticket address
    function exerciseTicket(address _ticket) external nonReentrant notPaused onlyKnownTickets(_ticket) {
        _exerciseTicket(_ticket);
    }

    /// @notice additional logic for ticket resolve (called only from ticket contact)
    /// @param _ticketOwner ticket owner
    /// @param _hasUserWon is winning ticket
    /// @param _cancelled is ticket cancelled (needed for referral and safe box fee)
    /// @param _buyInAmount ticket buy-in amount (needed for referral and safe box fee)
    /// @param _ticketCreator ticket creator (needed for referral and safe box fee)
    function resolveTicket(
        address _ticketOwner,
        bool _hasUserWon,
        bool _cancelled,
        uint _buyInAmount,
        address _ticketCreator
    ) external notPaused onlyKnownTickets(msg.sender) {
        if (!_cancelled) {
            _handleReferrerAndSB(_buyInAmount, _ticketCreator);
        }
        knownTickets.remove(msg.sender);
        if (activeTicketsPerUser[_ticketOwner].contains(msg.sender)) {
            activeTicketsPerUser[_ticketOwner].remove(msg.sender);
        }
        resolvedTicketsPerUser[_ticketOwner].add(msg.sender);
        emit TicketResolved(msg.sender, _ticketOwner, _hasUserWon);
    }

    /// @notice pause/unapause provided tickets
    /// @param _tickets array of tickets to be paused/unpaused
    /// @param _paused pause/unpause
    function setPausedTickets(address[] calldata _tickets, bool _paused) external onlyOwner {
        for (uint i = 0; i < _tickets.length; i++) {
            Ticket(_tickets[i]).setPaused(_paused);
        }
    }

    /// @notice expire provided tickets
    /// @param _tickets array of tickets to be expired
    function expireTickets(address[] calldata _tickets) external onlyOwner {
        for (uint i = 0; i < _tickets.length; i++) {
            if (Ticket(_tickets[i]).phase() == Ticket.Phase.Expiry) {
                Ticket(_tickets[i]).expire(payable(safeBox));
            }
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
        buyInAmountAfterFees = ((ONE - safeBoxFee) * _buyInAmount) / ONE;

        for (uint i = 0; i < numOfPositions; i++) {
            TradeData memory tradeDataItem = _tradeData[i];

            _verifyMerkleTree(tradeDataItem);

            if (tradeDataItem.odds.length > tradeDataItem.position) {
                finalQuotes[i] = tradeDataItem.odds[tradeDataItem.position];
            }
            if (finalQuotes[i] == 0) {
                totalQuote = 0;
                break;
            }
            amountsToBuy[i] = (ONE * buyInAmountAfterFees) / finalQuotes[i];
            totalQuote = totalQuote == 0 ? finalQuotes[i] : (totalQuote * finalQuotes[i]) / ONE;
        }
        if (totalQuote != 0) {
            payout = (buyInAmountAfterFees * ONE) / totalQuote;
        }

        // check if any game breaches cap
        for (uint i = 0; i < _tradeData.length; i++) {
            TradeData memory tradeDataItem = _tradeData[i];
            if (
                riskPerGameAndPosition[tradeDataItem.gameId][tradeDataItem.sportId][tradeDataItem.childId][
                    tradeDataItem.playerPropsId
                ][tradeDataItem.playerId][tradeDataItem.line][tradeDataItem.position] +
                    amountsToBuy[i] >
                riskManager.calculateCapToBeUsed(
                    tradeDataItem.gameId,
                    tradeDataItem.sportId,
                    tradeDataItem.childId,
                    tradeDataItem.playerPropsId,
                    tradeDataItem.playerId,
                    tradeDataItem.line,
                    tradeDataItem.maturity
                ) ||
                !riskManager.isTotalSpendingLessThanTotalRisk(
                    spentPerParent[tradeDataItem.gameId] + amountsToBuy[i],
                    tradeDataItem.gameId,
                    tradeDataItem.sportId,
                    tradeDataItem.childId,
                    tradeDataItem.playerPropsId,
                    tradeDataItem.playerId,
                    tradeDataItem.line,
                    tradeDataItem.maturity
                )
            ) {
                finalQuotes[i] = 0;
                totalQuote = 0;
            }
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
            defaultCollateral.safeTransfer(safeBox, exactReceived - _buyInAmount);
        }
    }

    function _trade(
        TradeData[] memory _tradeData,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        bool _sendDefaultCollateral
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

        _checkRisk(_tradeData, amountsToBuy);

        if (_sendDefaultCollateral) {
            defaultCollateral.safeTransferFrom(msg.sender, address(this), _buyInAmount);
        }

        // clone a ticket
        Ticket.GameData[] memory gameData = _getTicketData(_tradeData);
        Ticket ticket = Ticket(Clones.clone(ticketMastercopy));

        ticket.initialize(
            gameData,
            _buyInAmount,
            buyInAmountAfterFees,
            totalQuote,
            address(this),
            _differentRecipient,
            msg.sender,
            (block.timestamp + expiryDuration)
        );
        _saveTicketData(_tradeData, address(ticket), _differentRecipient);

        if (address(stakingThales) != address(0)) {
            stakingThales.updateVolume(_differentRecipient, _buyInAmount);
        }

        liquidityPool.commitTrade(address(ticket), payout - buyInAmountAfterFees);
        defaultCollateral.safeTransfer(address(ticket), payout);

        emit NewTicket(gameData, address(ticket), buyInAmountAfterFees, payout);
        emit TicketCreated(address(ticket), _differentRecipient, _buyInAmount, buyInAmountAfterFees, payout, totalQuote);
    }

    function _saveTicketData(TradeData[] memory _tradeData, address ticket, address user) internal {
        knownTickets.add(ticket);
        activeTicketsPerUser[user].add(ticket);

        for (uint i = 0; i < _tradeData.length; i++) {
            ticketsPerGame[_tradeData[i].gameId].add(ticket);
        }
    }

    function _getTicketData(TradeData[] memory _tradeData) internal pure returns (Ticket.GameData[] memory gameData) {
        gameData = new Ticket.GameData[](_tradeData.length);

        for (uint i = 0; i < _tradeData.length; i++) {
            TradeData memory tradeDataItem = _tradeData[i];

            gameData[i] = Ticket.GameData(
                tradeDataItem.gameId,
                tradeDataItem.sportId,
                tradeDataItem.childId,
                tradeDataItem.playerPropsId,
                tradeDataItem.maturity,
                tradeDataItem.status,
                tradeDataItem.line,
                tradeDataItem.playerId,
                tradeDataItem.position,
                tradeDataItem.odds[tradeDataItem.position]
            );
        }
    }

    function _checkRisk(TradeData[] memory _tradeData, uint[] memory _amountsToBuy) internal {
        for (uint i = 0; i < _tradeData.length; i++) {
            require(_isGameInAMMTrading(_tradeData[i]), "Not trading");
            require(_tradeData[i].odds.length > _tradeData[i].position, "Invalid position");

            riskPerGameAndPosition[_tradeData[i].gameId][_tradeData[i].sportId][_tradeData[i].childId][
                _tradeData[i].playerPropsId
            ][_tradeData[i].playerId][_tradeData[i].line][_tradeData[i].position] += _amountsToBuy[i];
            spentPerParent[_tradeData[i].gameId] += _amountsToBuy[i];
            require(
                riskPerGameAndPosition[_tradeData[i].gameId][_tradeData[i].sportId][_tradeData[i].childId][
                    _tradeData[i].playerPropsId
                ][_tradeData[i].playerId][_tradeData[i].line][_tradeData[i].position] <
                    riskManager.calculateCapToBeUsed(
                        _tradeData[i].gameId,
                        _tradeData[i].sportId,
                        _tradeData[i].childId,
                        _tradeData[i].playerPropsId,
                        _tradeData[i].playerId,
                        _tradeData[i].line,
                        _tradeData[i].maturity
                    ),
                "Risk per individual market and position exceeded"
            );
            require(
                riskManager.isTotalSpendingLessThanTotalRisk(
                    spentPerParent[_tradeData[i].gameId],
                    _tradeData[i].gameId,
                    _tradeData[i].sportId,
                    _tradeData[i].childId,
                    _tradeData[i].playerPropsId,
                    _tradeData[i].playerId,
                    _tradeData[i].line,
                    _tradeData[i].maturity
                ),
                "Risk is to high"
            );
        }
    }

    function _isGameInAMMTrading(TradeData memory tradeData) internal view returns (bool isTrading) {
        bool isResolved = _isGameResolved(
            tradeData.gameId,
            tradeData.sportId,
            tradeData.childId,
            tradeData.playerPropsId,
            tradeData.playerId,
            tradeData.line
        );
        if (tradeData.status == 0 && !isResolved) {
            if (tradeData.maturity >= block.timestamp) {
                isTrading = (tradeData.maturity - block.timestamp) > minimalTimeLeftToMaturity;
            }
        }
    }

    function _isGameResolved(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        uint16 _playerId,
        int24 _line
    ) internal view returns (bool) {
        return
            isScoreSetForGame[_gameId][_playerPropsId][_playerId] ||
            isGameCancelled[_gameId][_sportId][_childId][_playerPropsId][_playerId][_line];
    }

    function _handleReferrerAndSB(uint _buyInAmount, address _tickerCreator) internal returns (uint safeBoxAmount) {
        uint referrerShare;
        address referrer = referrals.sportReferrals(_tickerCreator);
        if (referrer != address(0)) {
            uint referrerFeeByTier = referrals.getReferrerFee(referrer);
            if (referrerFeeByTier > 0) {
                referrerShare = (_buyInAmount * referrerFeeByTier) / ONE;
                defaultCollateral.safeTransfer(referrer, referrerShare);
                emit ReferrerPaid(referrer, _tickerCreator, referrerShare, _buyInAmount);
            }
        }
        safeBoxAmount = _getSafeBoxAmount(_buyInAmount, _tickerCreator);
        defaultCollateral.safeTransfer(safeBox, safeBoxAmount - referrerShare);
        emit SafeBoxFeePaid(safeBoxFee, safeBoxAmount);
    }

    function _getSafeBoxAmount(uint _buyInAmount, address _toCheck) internal view returns (uint safeBoxAmount) {
        uint sbFee = _getSafeBoxFeePerAddress(_toCheck);
        safeBoxAmount = (_buyInAmount * sbFee) / ONE;
    }

    function _getSafeBoxFeePerAddress(address _toCheck) internal view returns (uint toReturn) {
        return safeBoxFeePerAddress[_toCheck] > 0 ? safeBoxFeePerAddress[_toCheck] : safeBoxFee;
    }

    function _verifyMerkleTree(TradeData memory tradeDataItem) internal view {
        // Compute the merkle leaf from trade data
        bytes32 leaf = keccak256(
            abi.encodePacked(
                tradeDataItem.gameId,
                uint(tradeDataItem.sportId),
                uint(tradeDataItem.childId),
                uint(tradeDataItem.playerPropsId),
                tradeDataItem.maturity,
                uint(tradeDataItem.status),
                int(tradeDataItem.line),
                uint(tradeDataItem.playerId),
                tradeDataItem.odds
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
        uint amount = defaultCollateral.balanceOf(address(this));
        if (amount > 0) {
            liquidityPool.transferToPool(_ticket, amount);
        }
    }

    function _getResultMoneyline(int24 _homeScore, int24 _awayScore) internal pure returns (ISportsAMMV2.GameResult) {
        return
            _homeScore == _awayScore
                ? ISportsAMMV2.GameResult.Draw
                : (_homeScore > _awayScore ? ISportsAMMV2.GameResult.Home : ISportsAMMV2.GameResult.Away);
    }

    function _getResultTotal(
        int24 _homeScore,
        int24 _awayScore,
        int24 _line
    ) internal pure returns (ISportsAMMV2.GameResult) {
        return
            (_homeScore + _awayScore) * 100 > _line
                ? ISportsAMMV2.GameResult.Home
                : (
                    (_homeScore + _awayScore) * 100 < _line
                        ? ISportsAMMV2.GameResult.Away
                        : ISportsAMMV2.GameResult.Cancelled
                );
    }

    function _getResultSpread(
        int24 _homeScore,
        int24 _awayScore,
        int24 _line
    ) internal pure returns (ISportsAMMV2.GameResult) {
        int24 homeScoreWithSpread = _homeScore * 100 + _line;
        int24 newAwayScore = _awayScore * 100;

        return
            homeScoreWithSpread > newAwayScore
                ? ISportsAMMV2.GameResult.Home
                : (homeScoreWithSpread < newAwayScore ? ISportsAMMV2.GameResult.Away : ISportsAMMV2.GameResult.Cancelled);
    }

    function _getResultPlayerProps(int24 _score, int24 _line) internal pure returns (ISportsAMMV2.GameResult) {
        return
            _score * 100 > _line
                ? ISportsAMMV2.GameResult.Home
                : (_score * 100 < _line ? ISportsAMMV2.GameResult.Away : ISportsAMMV2.GameResult.Cancelled);
    }

    /* ========== SETTERS ========== */

    /// @notice sets root of merkle tree
    /// @param _game game ID
    /// @param _root new root
    function setRootPerGame(bytes32 _game, bytes32 _root) public onlyOwner {
        rootPerGame[_game] = _root;
        emit GameRootUpdated(_game, _root);
    }

    /// @notice sets different amounts
    /// @param _safeBoxFee safe box fee paid on each trade
    /// @param _minBuyInAmount minimum ticket buy-in amount
    /// @param _maxTicketSize maximum ticket size
    /// @param _maxSupportedAmount maximum supported payout amount
    /// @param _maxSupportedOdds  maximum supported ticket odds
    function setAmounts(
        uint _safeBoxFee,
        uint _minBuyInAmount,
        uint _maxTicketSize,
        uint _maxSupportedAmount,
        uint _maxSupportedOdds
    ) external onlyOwner {
        safeBoxFee = _safeBoxFee;
        minBuyInAmount = _minBuyInAmount;
        maxTicketSize = _maxTicketSize;
        maxSupportedAmount = _maxSupportedAmount;
        maxSupportedOdds = _maxSupportedOdds;
        emit AmountsUpdated(_safeBoxFee, _minBuyInAmount, _maxTicketSize, _maxSupportedAmount, _maxSupportedOdds);
    }

    /// @notice sets main addresses
    /// @param _defaultCollateral the default token used for payment
    /// @param _manager manager address
    /// @param _riskManager risk manager address
    /// @param _referrals referrals address
    /// @param _stakingThales staking thales address
    /// @param _safeBox safeBox address
    function setAddresses(
        IERC20 _defaultCollateral,
        address _manager,
        address _riskManager,
        address _referrals,
        address _stakingThales,
        address _safeBox
    ) external onlyOwner {
        defaultCollateral = _defaultCollateral;
        manager = ISportsAMMV2Manager(_manager);
        riskManager = ISportsAMMV2RiskManager(_riskManager);
        referrals = IReferrals(_referrals);
        stakingThales = IStakingThales(_stakingThales);
        safeBox = _safeBox;

        emit AddressesUpdated(_defaultCollateral, _manager, _riskManager, _referrals, _stakingThales, _safeBox);
    }

    /// @notice sets different times/periods
    /// @param _minimalTimeLeftToMaturity  the period of time in seconds before a game is matured and begins to be restricted for AMM trading
    /// @param _expiryDuration the period of time in seconds after mauturity when ticket expires
    function setTimes(uint _minimalTimeLeftToMaturity, uint _expiryDuration) external onlyOwner {
        minimalTimeLeftToMaturity = _minimalTimeLeftToMaturity;
        expiryDuration = _expiryDuration;
        emit TimesUpdated(_minimalTimeLeftToMaturity, _expiryDuration);
    }

    /// @notice sets new Ticket Mastercopy address
    /// @param _ticketMastercopy new Ticket Mastercopy address
    function setTicketMastercopy(address _ticketMastercopy) external onlyOwner {
        ticketMastercopy = _ticketMastercopy;
        emit TicketMastercopyUpdated(_ticketMastercopy);
    }

    /// @notice sets new LP address
    /// @param _liquidityPool new LP address
    function setLiquidityPool(address _liquidityPool) external onlyOwner {
        if (address(liquidityPool) != address(0)) {
            defaultCollateral.approve(address(liquidityPool), 0);
        }
        liquidityPool = ISportsAMMV2LiquidityPool(_liquidityPool);
        defaultCollateral.approve(_liquidityPool, MAX_APPROVAL);
        emit SetLiquidityPool(_liquidityPool);
    }

    /// @notice sets multi-collateral on/off ramp contract and enable/disable
    /// @param _onOffRamper new multi-collateral on/off ramp address
    /// @param _enabled enable/disable multi-collateral on/off ramp
    function setMultiCollateralOnOffRamp(address _onOffRamper, bool _enabled) external onlyOwner {
        if (address(multiCollateralOnOffRamp) != address(0)) {
            defaultCollateral.approve(address(multiCollateralOnOffRamp), 0);
        }
        multiCollateralOnOffRamp = IMultiCollateralOnOffRamp(_onOffRamper);
        multicollateralEnabled = _enabled;
        if (_enabled) {
            defaultCollateral.approve(_onOffRamper, MAX_APPROVAL);
        }
        emit SetMultiCollateralOnOffRamp(_onOffRamper, _enabled);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyKnownTickets(address _ticket) {
        require(knownTickets.contains(_ticket), "Unknown ticket");
        _;
    }

    /* ========== EVENTS ========== */

    event NewTicket(Ticket.GameData[] tradeData, address ticket, uint buyInAmountAfterFees, uint payout);
    event TicketCreated(
        address ticket,
        address differentRecipient,
        uint buyInAmount,
        uint buyInAmountAfterFees,
        uint payout,
        uint totalQuote
    );

    event ScoreSetForGame(bytes32 gameId, uint16 playerPropsId, uint16 playerId, uint24 homeScore, uint24 awayScore);
    event GameCancelled(bytes32 gameId, uint16 sportId, uint16 childId, uint16 playerPropsId, uint16 playerId);

    event TicketResolved(address ticket, address ticketOwner, bool isUserTheWinner);
    event ReferrerPaid(address refferer, address trader, uint amount, uint volume);
    event SafeBoxFeePaid(uint safeBoxFee, uint safeBoxAmount);

    event GameRootUpdated(bytes32 game, bytes32 root);
    event AmountsUpdated(
        uint safeBoxFee,
        uint minBuyInAmount,
        uint maxTicketSize,
        uint maxSupportedAmount,
        uint maxSupportedOdds
    );
    event AddressesUpdated(
        IERC20 defaultCollateral,
        address manager,
        address riskManager,
        address referrals,
        address stakingThales,
        address safeBox
    );
    event TimesUpdated(uint minimalTimeLeftToMaturity, uint expiryDuration);
    event TicketMastercopyUpdated(address ticketMastercopy);
    event SetLiquidityPool(address liquidityPool);
    event SetMultiCollateralOnOffRamp(address onOffRamper, bool enabled);
}
