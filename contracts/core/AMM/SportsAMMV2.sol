// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

// internal
import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";
import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";
import "@thales-dao/contracts/contracts/interfaces/IMultiCollateralOnOffRamp.sol";
import "@thales-dao/contracts/contracts/interfaces/IStakingThales.sol";
import "@thales-dao/contracts/contracts/interfaces/IPriceFeed.sol";

import "./Ticket.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "../../interfaces/ISportsAMMV2ResultManager.sol";
import "../../interfaces/ISportsAMMV2LiquidityPool.sol";
import "../../interfaces/IWeth.sol";
import "../../interfaces/IFreeBetsHolder.sol";

/// @title Sports AMM V2 contract
/// @author vladan
contract SportsAMMV2 is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    /* ========== LIBRARIES ========== */

    using SafeERC20 for IERC20;

    /* ========== CONST VARIABLES ========== */

    uint private constant ONE = 1e18;
    uint private constant MAX_APPROVAL = type(uint256).max;

    /* ========== STRUCT VARIABLES ========== */
    struct TradeDataInternal {
        uint _buyInAmount;
        uint _expectedPayout;
        uint _additionalSlippage;
        address _recipient;
        bool _isLive;
        address _collateral;
        address _collateralPool;
        uint _collateralPriceInUSD;
    }

    /* ========== STATE VARIABLES ========== */

    // merkle tree root per game
    mapping(bytes32 => bytes32) public rootPerGame;

    // the default token used for payment
    IERC20 public defaultCollateral;

    // Liquidity pool instance for the given collateral
    mapping(address => address) public liquidityPoolForCollateral;

    // decimals of the default collateral
    uint private defaultCollateralDecimals;

    // manager address
    ISportsAMMV2Manager public manager;

    // risk manager address
    ISportsAMMV2RiskManager public riskManager;

    // result manager address
    ISportsAMMV2ResultManager public resultManager;

    // referrals address
    IReferrals public referrals;

    // ticket mastercopy address
    address public ticketMastercopy;

    // safe box address
    address public safeBox;

    // safe box fee paid on each trade
    uint public safeBoxFee;

    // multi-collateral on/off ramp address
    IMultiCollateralOnOffRamp public multiCollateralOnOffRamp;

    // is multi-collateral enabled
    bool public multicollateralEnabled;

    // staking thales address
    IStakingThales public stakingThales;

    // CL client that processes live requests
    address public liveTradingProcessor;

    // the contract that processes all free bets
    address public freeBetsHolder;

    // support bonus payouts for some collaterals (e.g. THALES)
    mapping(address => uint) public addedPayoutPercentagePerCollateral;

    // support different SB per collateral, namely THALES as a collateral will be directly burned
    mapping(address => address) public safeBoxPerCollateral;

    // declare that it can receive eth
    receive() external payable {}

    /* ========== CONSTRUCTOR ========== */

    /// @notice initialize the storage in the proxy contract with the parameters
    /// @param _owner owner for using the onlyOwner functions
    /// @param _defaultCollateral the address of default token used for payment
    /// @param _manager the address of manager
    /// @param _riskManager the address of risk manager
    /// @param _riskManager the address of result manager
    /// @param _referrals the address of referrals
    /// @param _stakingThales the address of staking thales
    /// @param _safeBox the address of safe box
    function initialize(
        address _owner,
        IERC20 _defaultCollateral,
        ISportsAMMV2Manager _manager,
        ISportsAMMV2RiskManager _riskManager,
        ISportsAMMV2ResultManager _resultManager,
        IReferrals _referrals,
        IStakingThales _stakingThales,
        address _safeBox
    ) public initializer {
        setOwner(_owner);
        initNonReentrant();
        defaultCollateral = _defaultCollateral;
        defaultCollateralDecimals = ISportsAMMV2Manager(address(defaultCollateral)).decimals();
        manager = _manager;
        riskManager = _riskManager;
        resultManager = _resultManager;
        referrals = _referrals;
        stakingThales = _stakingThales;
        safeBox = _safeBox;
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice get roots for the list of games
    /// @param _games to return roots for
    function getRootsPerGames(bytes32[] calldata _games) external view returns (bytes32[] memory _roots) {
        _roots = new bytes32[](_games.length);
        for (uint i; i < _games.length; i++) {
            _roots[i] = rootPerGame[_games[i]];
        }
    }

    /// @notice gets trade quote
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _collateral different collateral used for payment
    /// @return totalQuote total ticket quote
    /// @return payout expected payout
    /// @return fees ticket fees
    /// @return amountsToBuy amounts per market
    /// @return buyInAmountInDefaultCollateral buy-in amount in default collateral
    /// @return riskStatus risk status
    function tradeQuote(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        address _collateral
    )
        external
        view
        returns (
            uint totalQuote,
            uint payout,
            uint fees,
            uint[] memory amountsToBuy,
            uint buyInAmountInDefaultCollateral,
            ISportsAMMV2RiskManager.RiskStatus riskStatus
        )
    {
        uint useAmount = _buyInAmount;
        buyInAmountInDefaultCollateral = _buyInAmount;

        // TODO: Might prefer insisting on always sending the collateral
        if (_collateral != address(0) && _collateral != address(defaultCollateral)) {
            if (liquidityPoolForCollateral[_collateral] == address(0)) {
                buyInAmountInDefaultCollateral = multiCollateralOnOffRamp.getMinimumReceived(_collateral, _buyInAmount);
                useAmount = buyInAmountInDefaultCollateral;
            } else {
                uint collateralDecimals = ISportsAMMV2Manager(address(_collateral)).decimals();
                uint priceInUSD = ISportsAMMV2LiquidityPool(liquidityPoolForCollateral[_collateral]).getCollateralPrice();

                buyInAmountInDefaultCollateral = _transformToUSD(
                    _buyInAmount,
                    priceInUSD,
                    defaultCollateralDecimals,
                    collateralDecimals
                );
            }
        }

        require(useAmount > 0, "Can't trade 0 amount");

        (totalQuote, payout, fees, amountsToBuy, riskStatus) = _tradeQuote(
            _tradeData,
            useAmount,
            true,
            buyInAmountInDefaultCollateral,
            _collateral
        );
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice make a trade and create a ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedQuote expected payout got from quote method
    /// @param _additionalSlippage slippage tolerance
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    /// @param _isEth pay with ETH
    /// @return _createdTicket the address of the created ticket
    function trade(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        bool _isEth
    ) external payable nonReentrant notPaused returns (address _createdTicket) {
        require(_expectedQuote > 0 && _buyInAmount > 0, "Illegal input amounts");

        if (_referrer != address(0)) {
            referrals.setReferrer(_referrer, msg.sender);
        }

        address useLPpool;
        uint collateralPriceInUSD;
        (useLPpool, collateralPriceInUSD, _buyInAmount, _collateral) = _handleCollateral(
            _buyInAmount,
            _collateral,
            msg.sender,
            _isEth
        );
        _createdTicket = _trade(
            _tradeData,
            TradeDataInternal(
                _buyInAmount,
                (ONE * _buyInAmount) / _expectedQuote, // quote to expected payout
                _additionalSlippage,
                msg.sender,
                false,
                _collateral,
                useLPpool,
                collateralPriceInUSD
            )
        );
    }

    /// @notice make a live trade and create a ticket
    /// @param _tradeData trade data with all market info needed for ticket
    /// @param _buyInAmount ticket buy-in amount
    /// @param _expectedQuote expected payout got from LiveTradingProcessor method
    /// @param _recipient different recipient of the ticket
    /// @param _referrer referrer to get referral fee
    /// @param _collateral different collateral used for payment
    /// @return _createdTicket the address of the created ticket
    function tradeLive(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        address _recipient,
        address _referrer,
        address _collateral
    ) external nonReentrant notPaused returns (address _createdTicket) {
        require(msg.sender == liveTradingProcessor, "OnlyLiveTradingProcessor");

        if (_referrer != address(0)) {
            referrals.setReferrer(_referrer, _recipient);
        }

        require(_recipient != address(0), "UndefinedRecipient");
        address useLPpool;
        uint collateralPriceInUSD;
        (useLPpool, collateralPriceInUSD, _buyInAmount, _collateral) = _handleCollateral(
            _buyInAmount,
            _collateral,
            _recipient,
            false
        );
        _createdTicket = _trade(
            _tradeData,
            TradeDataInternal(
                _buyInAmount,
                (ONE * _buyInAmount) / _expectedQuote, // quote to expected payout,
                0, // no additional slippage allowed as the amount comes from the LiveTradingProcessor
                _recipient,
                true,
                _collateral,
                useLPpool,
                collateralPriceInUSD
            )
        );
    }

    /// @notice exercise specific ticket
    /// @param _ticket ticket address
    function exerciseTicket(address _ticket) external nonReentrant notPaused onlyKnownTickets(_ticket) {
        _exerciseTicket(_ticket, address(0), false);
    }

    /// @notice exercise specific ticket to an off ramp collateral
    /// @param _ticket ticket address
    /// @param _exerciseCollateral collateral address to off ramp to
    /// @param _inEth offramp with ETH
    function exerciseTicketOffRamp(
        address _ticket,
        address _exerciseCollateral,
        bool _inEth
    ) external nonReentrant notPaused onlyKnownTickets(_ticket) {
        require(msg.sender == Ticket(_ticket).ticketOwner(), "Caller not the ticket owner");
        _exerciseTicket(_ticket, _exerciseCollateral, _inEth);
    }

    /// @notice expire provided tickets
    /// @param _tickets array of tickets to be expired
    function expireTickets(address[] calldata _tickets) external onlyOwner {
        for (uint i = 0; i < _tickets.length; i++) {
            Ticket(_tickets[i]).expire(msg.sender);
        }
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _tradeQuote(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _buyInAmount,
        bool _shouldCheckRisks,
        uint _buyInAmountInDefaultCollateral,
        address _collateral
    )
        internal
        view
        returns (
            uint totalQuote,
            uint payout,
            uint fees,
            uint[] memory amountsToBuy,
            ISportsAMMV2RiskManager.RiskStatus riskStatus
        )
    {
        uint numOfMarkets = _tradeData.length;
        amountsToBuy = new uint[](numOfMarkets);
        uint maxSupportedOdds = riskManager.maxSupportedOdds();

        uint addedPayoutPercentage = addedPayoutPercentagePerCollateral[_collateral];

        for (uint i = 0; i < numOfMarkets; i++) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];

            riskManager.verifyMerkleTree(marketTradeData, rootPerGame[marketTradeData.gameId]);

            require(marketTradeData.odds.length > marketTradeData.position, "Invalid position");
            uint marketOdds = marketTradeData.odds[marketTradeData.position];
            marketOdds = marketOdds - ((addedPayoutPercentage * marketOdds) / ONE);

            amountsToBuy[i] = (ONE * _buyInAmount) / marketOdds;
            totalQuote = totalQuote == 0 ? marketOdds : (totalQuote * marketOdds) / ONE;
        }
        if (totalQuote != 0) {
            if (totalQuote < maxSupportedOdds) {
                totalQuote = maxSupportedOdds;
            }

            payout = (_buyInAmount * ONE) / totalQuote;
            fees = _getFees(_buyInAmount);

            if (_shouldCheckRisks) {
                bool[] memory isMarketOutOfLiquidity;
                (riskStatus, isMarketOutOfLiquidity) = riskManager.checkRisks(_tradeData, _buyInAmountInDefaultCollateral);

                for (uint i = 0; i < numOfMarkets; i++) {
                    if (isMarketOutOfLiquidity[i]) {
                        amountsToBuy[i] = 0;
                    }
                }
                if (riskStatus != ISportsAMMV2RiskManager.RiskStatus.NoRisk) {
                    totalQuote = 0;
                }
            }
        }
    }

    function _handleCollateral(
        uint _buyInAmount,
        address _collateral,
        address _fromAddress,
        bool _isEth
    ) internal returns (address lqPool, uint collateralPrice, uint buyInAmount, address collateralAfterOnramp) {
        buyInAmount = _buyInAmount;
        collateralAfterOnramp = _collateral;
        if (_collateral != address(0) && _collateral != address(defaultCollateral)) {
            if (_isEth) {
                // wrap ETH
                require(_collateral == multiCollateralOnOffRamp.WETH9() && msg.value >= _buyInAmount, "Insuff ETH sent");
                IWeth(_collateral).deposit{value: msg.value}();
            } else {
                // Generic case for any collateral used (THALES/ARB/OP)
                IERC20(_collateral).safeTransferFrom(_fromAddress, address(this), _buyInAmount);
            }

            lqPool = liquidityPoolForCollateral[_collateral];
            if (lqPool != address(0)) {
                collateralPrice = ISportsAMMV2LiquidityPool(lqPool).getCollateralPrice();
                require(collateralPrice > 0, "PriceFeed returned 0 for collateral");
            } else {
                require(multicollateralEnabled, "Multi-collat not enabled");
                uint buyInAmountInDefaultCollateral = multiCollateralOnOffRamp.getMinimumReceived(_collateral, _buyInAmount);
                IERC20(_collateral).approve(address(multiCollateralOnOffRamp), _buyInAmount);
                uint exactReceived = multiCollateralOnOffRamp.onramp(_collateral, _buyInAmount);
                require(exactReceived >= buyInAmountInDefaultCollateral, "Not enough received");

                buyInAmount = exactReceived;
                collateralAfterOnramp = address(defaultCollateral);
            }
        } else {
            collateralAfterOnramp = address(defaultCollateral);
            defaultCollateral.safeTransferFrom(_fromAddress, address(this), _buyInAmount);
        }
        lqPool = liquidityPoolForCollateral[collateralAfterOnramp];
    }

    function _trade(
        ISportsAMMV2.TradeData[] memory _tradeData,
        TradeDataInternal memory _tradeDataInternal
    ) internal returns (address) {
        uint totalQuote = (ONE * _tradeDataInternal._buyInAmount) / _tradeDataInternal._expectedPayout;
        uint payout = _tradeDataInternal._expectedPayout;
        uint fees = _getFees(_tradeDataInternal._buyInAmount);

        if (!_tradeDataInternal._isLive) {
            (totalQuote, payout, fees, , ) = _tradeQuote(
                _tradeData,
                _tradeDataInternal._buyInAmount,
                false,
                0,
                _tradeDataInternal._collateral
            );
        }
        //TODO: ensure added payout is added on Live trading too

        uint payoutWithFees = payout + fees;
        _checkRisksLimitsAndUpdateStakingVolume(_tradeData, totalQuote, payout, _tradeDataInternal);

        // clone a ticket
        Ticket.MarketData[] memory markets = _getTicketMarkets(_tradeData);
        Ticket ticket = Ticket(Clones.clone(ticketMastercopy));

        ticket.initialize(
            Ticket.TicketInit(
                markets,
                _tradeDataInternal._buyInAmount,
                fees,
                totalQuote,
                address(this),
                _tradeDataInternal._recipient,
                IERC20(_tradeDataInternal._collateral),
                (block.timestamp + riskManager.expiryDuration()),
                _tradeDataInternal._isLive
            )
        );
        manager.addNewKnownTicket(_tradeData, address(ticket), _tradeDataInternal._recipient);

        ISportsAMMV2LiquidityPool(_tradeDataInternal._collateralPool).commitTrade(
            address(ticket),
            payoutWithFees - _tradeDataInternal._buyInAmount
        );
        IERC20(_tradeDataInternal._collateral).safeTransfer(address(ticket), payoutWithFees);

        emit NewTicket(markets, address(ticket), _tradeDataInternal._buyInAmount, payout);
        emit TicketCreated(
            address(ticket),
            _tradeDataInternal._recipient,
            _tradeDataInternal._buyInAmount,
            fees,
            payout,
            totalQuote
        );

        return address(ticket);
    }

    // Transform collateral to USD
    function _transformToUSD(
        uint _amountInCollateral,
        uint _collateralPriceInUSD,
        uint _defaultCollateralDecimals,
        uint _collateralDecimals
    ) internal pure returns (uint amountInUSD) {
        amountInUSD = (_amountInCollateral * _collateralPriceInUSD) / ONE;
        if (_collateralDecimals < _defaultCollateralDecimals) {
            amountInUSD = amountInUSD * 10 ** (_defaultCollateralDecimals - _collateralDecimals);
        } else if (_collateralDecimals > _defaultCollateralDecimals) {
            amountInUSD = amountInUSD / 10 ** (_collateralDecimals - _defaultCollateralDecimals);
        }
    }

    // Checks risk and updates Staking Volume
    function _checkRisksLimitsAndUpdateStakingVolume(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _totalQuote,
        uint _payout,
        TradeDataInternal memory _tradeDataInternal
    ) internal {
        uint _buyInAmount = _tradeDataInternal._buyInAmount;
        uint _collateralPriceInUSD = _tradeDataInternal._collateralPriceInUSD;
        uint _expectedPayout = _tradeDataInternal._expectedPayout;
        if (_collateralPriceInUSD > 0) {
            uint collateralDecimals = ISportsAMMV2Manager(_tradeDataInternal._collateral).decimals();
            _buyInAmount = _transformToUSD(
                _buyInAmount,
                _collateralPriceInUSD,
                defaultCollateralDecimals,
                collateralDecimals
            );
            _payout = _transformToUSD(_payout, _collateralPriceInUSD, defaultCollateralDecimals, collateralDecimals);
            _expectedPayout = _transformToUSD(
                _expectedPayout,
                _collateralPriceInUSD,
                defaultCollateralDecimals,
                collateralDecimals
            );
        }
        riskManager.checkAndUpdateRisks(_tradeData, _buyInAmount);
        riskManager.checkLimits(_buyInAmount, _totalQuote, _payout, _expectedPayout, _tradeDataInternal._additionalSlippage);
        if (address(stakingThales) != address(0)) {
            stakingThales.updateVolumeAtAmountDecimals(
                _tradeDataInternal._recipient,
                _buyInAmount,
                defaultCollateralDecimals
            );
        }
    }

    function _getTicketMarkets(
        ISportsAMMV2.TradeData[] memory _tradeData
    ) internal pure returns (Ticket.MarketData[] memory markets) {
        markets = new Ticket.MarketData[](_tradeData.length);

        for (uint i = 0; i < _tradeData.length; i++) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];

            markets[i] = Ticket.MarketData(
                marketTradeData.gameId,
                marketTradeData.sportId,
                marketTradeData.typeId,
                marketTradeData.maturity,
                marketTradeData.status,
                marketTradeData.line,
                marketTradeData.playerId,
                marketTradeData.position,
                marketTradeData.odds[marketTradeData.position],
                marketTradeData.combinedPositions[marketTradeData.position]
            );
        }
    }

    function _handleFees(uint _buyInAmount, address _tickerOwner, IERC20 _collateral) internal returns (uint fees) {
        uint referrerShare;
        address referrer = referrals.sportReferrals(_tickerOwner);
        uint ammBalance = _collateral.balanceOf(address(this));

        if (referrer != address(0)) {
            uint referrerFeeByTier = referrals.getReferrerFee(referrer);
            if (referrerFeeByTier > 0) {
                referrerShare = (_buyInAmount * referrerFeeByTier) / ONE;
                if (ammBalance >= referrerShare) {
                    _collateral.safeTransfer(referrer, referrerShare);
                    emit ReferrerPaid(referrer, _tickerOwner, referrerShare, _buyInAmount);
                    ammBalance -= referrerShare;
                }
            }
        }
        fees = _getFees(_buyInAmount);
        if (fees > referrerShare) {
            uint safeBoxAmount = fees - referrerShare;
            if (ammBalance >= safeBoxAmount) {
                _collateral.safeTransfer(
                    safeBoxPerCollateral[address(_collateral)] != address(0)
                        ? safeBoxPerCollateral[address(_collateral)]
                        : safeBox,
                    safeBoxAmount
                );
                emit SafeBoxFeePaid(safeBoxFee, safeBoxAmount);
            }
        }
    }

    function _getFees(uint _buyInAmount) internal view returns (uint fees) {
        fees = (_buyInAmount * safeBoxFee) / ONE;
    }

    function _exerciseTicket(address _ticket, address _exerciseCollateral, bool _inEth) internal {
        Ticket ticket = Ticket(_ticket);
        uint userWonAmount = ticket.exercise(_exerciseCollateral);
        IERC20 ticketCollateral = ticket.collateral();
        address ticketOwner = ticket.ticketOwner();

        if (ticketOwner == freeBetsHolder) {
            IFreeBetsHolder(freeBetsHolder).confirmTicketResolved(_ticket);
        }

        if (!ticket.cancelled()) {
            _handleFees(ticket.buyInAmount(), ticketOwner, ticketCollateral);
        }
        manager.resolveKnownTicket(_ticket, ticketOwner);
        emit TicketResolved(_ticket, ticketOwner, ticket.isUserTheWinner());

        if (userWonAmount > 0 && _exerciseCollateral != address(0) && _exerciseCollateral != address(ticketCollateral)) {
            require(ticketCollateral == defaultCollateral, "Offramp only default collateral");
            uint offramped;
            if (_inEth) {
                offramped = multiCollateralOnOffRamp.offrampIntoEth(userWonAmount);
                (bool sent, ) = payable(ticketOwner).call{value: offramped}("");
                require(sent, "Failed to send Ether");
            } else {
                offramped = multiCollateralOnOffRamp.offramp(_exerciseCollateral, userWonAmount);
                IERC20(_exerciseCollateral).safeTransfer(ticketOwner, offramped);
            }
        }

        // if the ticket was lost or if for any reason there is surplus in SportsAMM after the ticket is exercised, send it all to Liquidity Pool
        uint amount = ticketCollateral.balanceOf(address(this));
        if (amount > 0) {
            ISportsAMMV2LiquidityPool(liquidityPoolForCollateral[address(ticketCollateral)]).transferToPool(_ticket, amount);
        }
    }

    /* ========== SETTERS ========== */

    /// @notice set roots of merkle tree
    /// @param _games game IDs
    /// @param _roots new roots
    function setRootsPerGames(bytes32[] memory _games, bytes32[] memory _roots) public onlyWhitelistedAddresses {
        require(_games.length == _roots.length, "Invalid length");
        for (uint i; i < _games.length; i++) {
            rootPerGame[_games[i]] = _roots[i];
            emit GameRootUpdated(_games[i], _roots[i]);
        }
    }

    /// @notice sets different amounts
    /// @param _safeBoxFee safe box fee paid on each trade
    function setAmounts(uint _safeBoxFee) external onlyOwner {
        require(_safeBoxFee <= 1e17, "Safe Box fee can't exceed 10%");
        safeBoxFee = _safeBoxFee;
        emit AmountsUpdated(_safeBoxFee);
    }

    /// @notice sets main addresses
    /// @param _defaultCollateral the default token used for payment
    /// @param _manager manager address
    /// @param _riskManager risk manager address
    /// @param _resultManager result manager address
    /// @param _referrals referrals address
    /// @param _stakingThales staking thales address
    /// @param _safeBox safeBox address
    function setAddresses(
        IERC20 _defaultCollateral,
        address _manager,
        address _riskManager,
        address _resultManager,
        address _referrals,
        address _stakingThales,
        address _safeBox
    ) external onlyOwner {
        defaultCollateral = _defaultCollateral;
        defaultCollateralDecimals = ISportsAMMV2Manager(address(defaultCollateral)).decimals();
        manager = ISportsAMMV2Manager(_manager);
        riskManager = ISportsAMMV2RiskManager(_riskManager);
        resultManager = ISportsAMMV2ResultManager(_resultManager);
        referrals = IReferrals(_referrals);
        stakingThales = IStakingThales(_stakingThales);
        safeBox = _safeBox;

        emit AddressesUpdated(
            _defaultCollateral,
            _manager,
            _riskManager,
            _resultManager,
            _referrals,
            _stakingThales,
            _safeBox
        );
    }

    /// @notice sets the LiveTradingProcessor, required for any live trading
    function setLiveTradingProcessor(address _liveTradingProcessor) external onlyOwner {
        liveTradingProcessor = _liveTradingProcessor;
        emit SetLiveTradingProcessor(_liveTradingProcessor);
    }

    /// @notice sets the FreeBetsHolder address, required for handling ticket claiming via FreeBetsHolder
    function setFreeBetsHolder(address _freeBetsHolder) external onlyOwner {
        freeBetsHolder = _freeBetsHolder;
        emit SetFreeBetsHolder(_freeBetsHolder);
    }

    /// @notice sets new Ticket Mastercopy address
    /// @param _ticketMastercopy new Ticket Mastercopy address
    function setTicketMastercopy(address _ticketMastercopy) external onlyOwner {
        ticketMastercopy = _ticketMastercopy;
        emit TicketMastercopyUpdated(_ticketMastercopy);
    }

    /// @notice sets new LP Pool with LP address and the supported collateral
    /// @param _collateralAddress collateral address that is supported by the pool
    /// @param _liquidityPool new LP address
    function setLiquidityPoolForCollateral(address _collateralAddress, address _liquidityPool) external onlyOwner {
        if (liquidityPoolForCollateral[_collateralAddress] != address(0)) {
            IERC20(_collateralAddress).approve(liquidityPoolForCollateral[_collateralAddress], 0);
        }
        liquidityPoolForCollateral[_collateralAddress] = _liquidityPool;
        if (_liquidityPool != address(0)) {
            IERC20(_collateralAddress).approve(_liquidityPool, MAX_APPROVAL);
        }
        emit SetLiquidityPoolForCollateral(_liquidityPool, _collateralAddress);
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

    /// @notice sets additional payout percentage for certain collaterals
    /// @param _collateral to add extra payout for
    /// @param _addedPayout percentage amount for extra payout
    function setAddedPayoutPercentagePerCollateral(address _collateral, uint _addedPayout) external onlyOwner {
        addedPayoutPercentagePerCollateral[_collateral] = _addedPayout;
        emit SetAddedPayoutPercentagePerCollateral(_collateral, _addedPayout);
    }

    /// @notice sets dedicated SafeBox per collateral
    /// @param _collateral to set dedicated SafeBox for
    /// @param _safeBox for the given collateral
    function setSafeBoxPerCollateral(address _collateral, address _safeBox) external onlyOwner {
        safeBoxPerCollateral[_collateral] = _safeBox;
        emit SetSafeBoxPerCollateral(_collateral, _safeBox);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyKnownTickets(address _ticket) {
        require(manager.isKnownTicket(_ticket), "Unknown ticket");
        _;
    }

    modifier onlyWhitelistedAddresses() {
        require(
            msg.sender == owner || manager.isWhitelistedAddress(msg.sender, ISportsAMMV2Manager.Role.ROOT_SETTING),
            "Invalid sender"
        );
        _;
    }

    /* ========== EVENTS ========== */

    event NewTicket(Ticket.MarketData[] markets, address ticket, uint buyInAmount, uint payout);
    event TicketCreated(address ticket, address recipient, uint buyInAmount, uint fees, uint payout, uint totalQuote);

    event TicketResolved(address ticket, address ticketOwner, bool isUserTheWinner);
    event ReferrerPaid(address refferer, address trader, uint amount, uint volume);
    event SafeBoxFeePaid(uint safeBoxFee, uint safeBoxAmount);

    event GameRootUpdated(bytes32 game, bytes32 root);
    event AmountsUpdated(uint safeBoxFee);
    event AddressesUpdated(
        IERC20 defaultCollateral,
        address manager,
        address riskManager,
        address resultManager,
        address referrals,
        address stakingThales,
        address safeBox
    );
    event TicketMastercopyUpdated(address ticketMastercopy);
    event SetLiquidityPoolForCollateral(address liquidityPool, address collateral);
    event SetMultiCollateralOnOffRamp(address onOffRamper, bool enabled);
    event SetLiveTradingProcessor(address liveTradingProcessor);
    event SetFreeBetsHolder(address freeBetsHolder);
    event SetAddedPayoutPercentagePerCollateral(address _collateral, uint _addedPayout);
    event SetSafeBoxPerCollateral(address _collateral, address _safeBox);
}
