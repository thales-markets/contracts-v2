// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";

import "@thales-dao/contracts/contracts/interfaces/IStakingThales.sol";
import "@thales-dao/contracts/contracts/interfaces/IPriceFeed.sol";

import "./SportsAMMV2LiquidityPoolRound.sol";
import "../Ticket.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ICollateralUtility.sol";

contract SportsAMMV2LiquidityPool is Initializable, ProxyOwned, PausableUpgradeable, ProxyReentrancyGuard {
    /* ========== LIBRARIES ========== */

    using SafeERC20 for IERC20;

    /* ========== STRUCT DEFINITION ========== */

    struct InitParams {
        address _owner;
        address _sportsAMM;
        address _addressManager;
        IERC20 _collateral;
        uint _roundLength;
        uint _maxAllowedDeposit;
        uint _minDepositAmount;
        uint _maxAllowedUsers;
        uint _utilizationRate;
        address _safeBox;
        uint _safeBoxImpact;
        bytes32 _collateralKey;
    }

    /* ========== CONSTANTS ========== */

    uint private constant ONE = 1e18;
    uint private constant ONE_PERCENT = 1e16;
    uint private constant MAX_APPROVAL = type(uint256).max;

    /* ========== STATE VARIABLES ========== */

    ISportsAMMV2 public sportsAMM;
    IERC20 public collateral;

    bool public started;

    uint public round;
    uint public roundLength;
    // actually second round, as first one is default for mixed round and never closes
    uint public firstRoundStartTime;

    mapping(uint => address) public roundPools;

    mapping(uint => address[]) public usersPerRound;
    mapping(uint => mapping(address => bool)) public userInRound;
    mapping(uint => mapping(address => uint)) public balancesPerRound;
    mapping(uint => uint) public allocationPerRound;

    mapping(address => bool) public withdrawalRequested;
    mapping(address => uint) public withdrawalShare;

    mapping(uint => address[]) public tradingTicketsPerRound;
    mapping(uint => mapping(address => bool)) public isTradingTicketInARound;
    mapping(uint => mapping(address => bool)) public ticketAlreadyExercisedInRound;
    mapping(address => uint) public roundPerTicket;

    mapping(uint => uint) public profitAndLossPerRound;
    mapping(uint => uint) public cumulativeProfitAndLoss;

    uint public maxAllowedDeposit;
    uint public minDepositAmount;
    uint public maxAllowedUsers;
    uint public usersCurrentlyInPool;

    address public defaultLiquidityProvider;

    // IStakingThales public stakingThales;

    address public poolRoundMastercopy;

    uint public totalDeposited;

    bool public roundClosingPrepared;
    uint public usersProcessedInRound;

    uint public utilizationRate;

    address public safeBox;
    uint public safeBoxImpact;

    ICollateralUtility public addressManager;

    bytes32 public collateralKey;

    bool public isDefaultCollateral;

    /* ========== CONSTRUCTOR ========== */

    function initialize(InitParams calldata params) external initializer {
        setOwner(params._owner);
        initNonReentrant();
        sportsAMM = ISportsAMMV2(params._sportsAMM);
        addressManager = ICollateralUtility(params._addressManager);

        collateral = params._collateral;
        collateralKey = params._collateralKey;
        roundLength = params._roundLength;
        maxAllowedDeposit = params._maxAllowedDeposit;
        minDepositAmount = params._minDepositAmount;
        maxAllowedUsers = params._maxAllowedUsers;
        utilizationRate = params._utilizationRate;
        safeBox = params._safeBox;
        safeBoxImpact = params._safeBoxImpact;
        isDefaultCollateral = address(sportsAMM.defaultCollateral()) == address(params._collateral);

        collateral.approve(params._sportsAMM, MAX_APPROVAL);
        round = 1;
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice start pool and begin round #2
    function start() external onlyOwner {
        require(!started, "LP has already started");
        require(allocationPerRound[2] > 0, "Can not start with 0 deposits");

        firstRoundStartTime = block.timestamp;
        round = 2;

        address roundPool = _getOrCreateRoundPool(2);
        SportsAMMV2LiquidityPoolRound(roundPool).updateRoundTimes(firstRoundStartTime, getRoundEndTime(2));

        started = true;
        emit PoolStarted();
    }

    /// @notice deposit funds from user into pool for the next round
    /// @param amount value to be deposited
    function deposit(uint amount) external canDeposit(amount) nonReentrant whenNotPaused roundClosingNotPrepared {
        _deposit(amount);
    }

    /// @notice deposit funds from user into pool for the next round
    /// @param amount value to be deposited
    function _deposit(uint amount) internal {
        uint nextRound = round + 1;
        address roundPool = _getOrCreateRoundPool(nextRound);
        collateral.safeTransferFrom(msg.sender, roundPool, amount);

        require(msg.sender != defaultLiquidityProvider, "Can't deposit directly as default LP");

        // new user enters the pool
        if (balancesPerRound[round][msg.sender] == 0 && balancesPerRound[nextRound][msg.sender] == 0) {
            require(usersCurrentlyInPool < maxAllowedUsers, "Max amount of users reached");
            usersPerRound[nextRound].push(msg.sender);
            usersCurrentlyInPool = usersCurrentlyInPool + 1;
        }

        balancesPerRound[nextRound][msg.sender] += amount;

        allocationPerRound[nextRound] += amount;
        totalDeposited += amount;
        address stakingThales = addressManager.getAddress("StakingThales");
        if (stakingThales != address(0)) {
            if (isDefaultCollateral) {
                IStakingThales(stakingThales).updateVolume(msg.sender, amount);
            } else {
                uint collateralPriceInUSD = IPriceFeed(addressManager.getAddress("PriceFeed")).rateForCurrency(
                    collateralKey
                );
                uint amountInUSD = _transformToUSD(amount, collateralPriceInUSD);
                IStakingThales(stakingThales).updateVolume(msg.sender, amountInUSD);
            }
        }

        emit Deposited(msg.sender, amount, round);
    }

    /// @notice get collateral amount needed for trade and store ticket as trading in the round
    /// @param ticket to trade
    /// @param amount amount to get
    function commitTrade(address ticket, uint amount) external nonReentrant whenNotPaused onlyAMM roundClosingNotPrepared {
        require(started, "Pool has not started");
        require(amount > 0, "Can't commit a zero trade");
        uint ticketRound = getTicketRound(ticket);
        roundPerTicket[ticket] = ticketRound;
        address liquidityPoolRound = _getOrCreateRoundPool(ticketRound);
        if (ticketRound == round) {
            collateral.safeTransferFrom(liquidityPoolRound, address(sportsAMM), amount);
            require(
                collateral.balanceOf(liquidityPoolRound) >=
                    (allocationPerRound[round] - ((allocationPerRound[round] * utilizationRate) / ONE)),
                "Amount exceeds available utilization for round"
            );
        } else if (ticketRound > round) {
            uint poolBalance = collateral.balanceOf(liquidityPoolRound);
            if (poolBalance >= amount) {
                collateral.safeTransferFrom(liquidityPoolRound, address(sportsAMM), amount);
            } else {
                uint differenceToLPAsDefault = amount - poolBalance;
                _depositAsDefault(differenceToLPAsDefault, liquidityPoolRound, ticketRound);
                collateral.safeTransferFrom(liquidityPoolRound, address(sportsAMM), amount);
            }
        } else {
            require(ticketRound == 1, "Invalid round");
            _provideAsDefault(amount);
        }
        tradingTicketsPerRound[ticketRound].push(ticket);
        isTradingTicketInARound[ticketRound][ticket] = true;
    }

    /// @notice transfer collateral amount from AMM to LP (ticket liquidity pool round)
    /// @param _ticket to trade
    function transferToPool(address _ticket, uint _amount) external whenNotPaused roundClosingNotPrepared onlyAMM {
        uint ticketRound = getTicketRound(_ticket);
        address liquidityPoolRound = ticketRound <= 1 ? defaultLiquidityProvider : _getOrCreateRoundPool(ticketRound);
        collateral.safeTransferFrom(address(sportsAMM), liquidityPoolRound, _amount);
        if (isTradingTicketInARound[ticketRound][_ticket]) {
            ticketAlreadyExercisedInRound[ticketRound][_ticket] = true;
        }
    }

    /// @notice request withdrawal from the LP
    function withdrawalRequest() external nonReentrant canWithdraw whenNotPaused roundClosingNotPrepared {
        if (totalDeposited > balancesPerRound[round][msg.sender]) {
            totalDeposited -= balancesPerRound[round][msg.sender];
        } else {
            totalDeposited = 0;
        }

        usersCurrentlyInPool = usersCurrentlyInPool - 1;
        withdrawalRequested[msg.sender] = true;
        emit WithdrawalRequested(msg.sender);
    }

    /// @notice request partial withdrawal from the LP
    /// @param _share the percentage the user is wihdrawing from his total deposit
    function partialWithdrawalRequest(uint _share) external nonReentrant canWithdraw whenNotPaused roundClosingNotPrepared {
        require(_share >= ONE_PERCENT * 10 && _share <= ONE_PERCENT * 90, "Share has to be between 10% and 90%");

        uint toWithdraw = (balancesPerRound[round][msg.sender] * _share) / ONE;
        if (totalDeposited > toWithdraw) {
            totalDeposited -= toWithdraw;
        } else {
            totalDeposited = 0;
        }

        withdrawalRequested[msg.sender] = true;
        withdrawalShare[msg.sender] = _share;
        emit WithdrawalRequested(msg.sender);
    }

    /// @notice prepare round closing - excercise tickets and ensure there are no tickets left unresolved, handle SB profit and calculate PnL
    function prepareRoundClosing() external nonReentrant whenNotPaused roundClosingNotPrepared {
        require(canCloseCurrentRound(), "Can't close current round");
        // excercise tickets
        exerciseTicketsReadyToBeExercised();

        address roundPool = roundPools[round];
        // final balance is the final amount of collateral in the round pool
        uint currentBalance = collateral.balanceOf(roundPool);

        // send profit reserved for SafeBox if positive round
        if (currentBalance > allocationPerRound[round]) {
            uint safeBoxAmount = ((currentBalance - allocationPerRound[round]) * safeBoxImpact) / ONE;
            collateral.safeTransferFrom(roundPool, safeBox, safeBoxAmount);
            currentBalance = currentBalance - safeBoxAmount;
            emit SafeBoxSharePaid(safeBoxImpact, safeBoxAmount);
        }

        // calculate PnL

        // if no allocation for current round
        if (allocationPerRound[round] == 0) {
            profitAndLossPerRound[round] = 1;
        } else {
            profitAndLossPerRound[round] = (currentBalance * ONE) / allocationPerRound[round];
        }

        roundClosingPrepared = true;

        emit RoundClosingPrepared(round);
    }

    /// @notice process round closing batch - update balances and handle withdrawals
    /// @param _batchSize size of batch
    function processRoundClosingBatch(uint _batchSize) external nonReentrant whenNotPaused {
        require(roundClosingPrepared, "Round closing not prepared");
        require(usersProcessedInRound < usersPerRound[round].length, "All users already processed");
        require(_batchSize > 0, "Batch size has to be greater than 0");

        IStakingThales stakingThales = IStakingThales(addressManager.getAddress("StakingThales"));
        address roundPool = roundPools[round];

        uint endCursor = usersProcessedInRound + _batchSize;
        if (endCursor > usersPerRound[round].length) {
            endCursor = usersPerRound[round].length;
        }

        for (uint i = usersProcessedInRound; i < endCursor; i++) {
            address user = usersPerRound[round][i];
            uint balanceAfterCurRound = (balancesPerRound[round][user] * profitAndLossPerRound[round]) / ONE;
            if (!withdrawalRequested[user] && (profitAndLossPerRound[round] > 0)) {
                balancesPerRound[round + 1][user] = balancesPerRound[round + 1][user] + balanceAfterCurRound;
                usersPerRound[round + 1].push(user);
                if (address(stakingThales) != address(0)) {
                    if (isDefaultCollateral) {
                        IStakingThales(stakingThales).updateVolume(msg.sender, balanceAfterCurRound);
                    } else {
                        uint collateralPriceInUSD = IPriceFeed(addressManager.getAddress("PriceFeed")).rateForCurrency(
                            collateralKey
                        );
                        uint amountInUSD = _transformToUSD(balanceAfterCurRound, collateralPriceInUSD);
                        IStakingThales(stakingThales).updateVolume(msg.sender, amountInUSD);
                    }
                }
            } else {
                if (withdrawalShare[user] > 0) {
                    uint amountToClaim = (balanceAfterCurRound * withdrawalShare[user]) / ONE;
                    collateral.safeTransferFrom(roundPool, user, amountToClaim);
                    emit Claimed(user, amountToClaim);
                    withdrawalRequested[user] = false;
                    withdrawalShare[user] = 0;
                    usersPerRound[round + 1].push(user);
                    balancesPerRound[round + 1][user] = balanceAfterCurRound - amountToClaim;
                } else {
                    balancesPerRound[round + 1][user] = 0;
                    collateral.safeTransferFrom(roundPool, user, balanceAfterCurRound);
                    withdrawalRequested[user] = false;
                    emit Claimed(user, balanceAfterCurRound);
                }
            }
            usersProcessedInRound = usersProcessedInRound + 1;
        }

        emit RoundClosingBatchProcessed(round, _batchSize);
    }

    /// @notice close current round and begin next round - calculate cumulative PnL
    function closeRound() external nonReentrant whenNotPaused {
        require(roundClosingPrepared, "Round closing not prepared");
        require(usersProcessedInRound == usersPerRound[round].length, "Not all users processed yet");
        // set for next round to false
        roundClosingPrepared = false;

        address roundPool = roundPools[round];

        // always claim for defaultLiquidityProvider
        if (balancesPerRound[round][defaultLiquidityProvider] > 0) {
            uint balanceAfterCurRound = (balancesPerRound[round][defaultLiquidityProvider] * profitAndLossPerRound[round]) /
                ONE;
            collateral.safeTransferFrom(roundPool, defaultLiquidityProvider, balanceAfterCurRound);
            emit Claimed(defaultLiquidityProvider, balanceAfterCurRound);
        }

        if (round == 2) {
            cumulativeProfitAndLoss[round] = profitAndLossPerRound[round];
        } else {
            cumulativeProfitAndLoss[round] = (cumulativeProfitAndLoss[round - 1] * profitAndLossPerRound[round]) / ONE;
        }

        // start next round
        ++round;

        //add all carried over collateral
        allocationPerRound[round] += collateral.balanceOf(roundPool);

        totalDeposited = allocationPerRound[round] - balancesPerRound[round][defaultLiquidityProvider];

        address roundPoolNewRound = _getOrCreateRoundPool(round);

        collateral.safeTransferFrom(roundPool, roundPoolNewRound, collateral.balanceOf(roundPool));

        usersProcessedInRound = 0;

        emit RoundClosed(round - 1, profitAndLossPerRound[round - 1]);
    }

    /// @notice iterate all tickets in the current round and exercise those ready to be exercised
    function exerciseTicketsReadyToBeExercised() public roundClosingNotPrepared {
        Ticket ticket;
        address ticketAddress;
        for (uint i = 0; i < tradingTicketsPerRound[round].length; i++) {
            ticketAddress = tradingTicketsPerRound[round][i];
            if (!ticketAlreadyExercisedInRound[round][ticketAddress]) {
                ticket = Ticket(ticketAddress);
                if (ticket.isTicketExercisable() && !ticket.isUserTheWinner()) {
                    sportsAMM.exerciseTicket(ticketAddress);
                }
                if (ticket.isUserTheWinner() || ticket.resolved()) {
                    ticketAlreadyExercisedInRound[round][ticketAddress] = true;
                }
            }
        }
    }

    /// @notice iterate all tickets in the current round and exercise those ready to be exercised (batch)
    /// @param _batchSize number of tickets to be processed
    function exerciseTicketsReadyToBeExercisedBatch(
        uint _batchSize
    ) external nonReentrant whenNotPaused roundClosingNotPrepared {
        require(_batchSize > 0, "Batch size has to be greater than 0");
        uint count = 0;
        Ticket ticket;
        for (uint i = 0; i < tradingTicketsPerRound[round].length; i++) {
            if (count == _batchSize) break;
            address ticketAddress = tradingTicketsPerRound[round][i];
            if (!ticketAlreadyExercisedInRound[round][ticketAddress]) {
                ticket = Ticket(ticketAddress);
                if (ticket.isTicketExercisable() && !ticket.isUserTheWinner()) {
                    sportsAMM.exerciseTicket(ticketAddress);
                }
                if (ticket.isUserTheWinner() || ticket.resolved()) {
                    ticketAlreadyExercisedInRound[round][ticketAddress] = true;
                    count += 1;
                }
            }
        }
    }

    function updateDefaultCollateral() external {
        isDefaultCollateral = address(sportsAMM.defaultCollateral()) == address(collateral);
    }

    /* ========== EXTERNAL READ FUNCTIONS ========== */

    /// @notice whether the user is currently LPing
    /// @param _user to check
    /// @return isUserInLP whether the user is currently LPing
    function isUserLPing(address _user) external view returns (bool isUserInLP) {
        isUserInLP =
            (balancesPerRound[round][_user] > 0 || balancesPerRound[round + 1][_user] > 0) &&
            (!withdrawalRequested[_user] || withdrawalShare[_user] > 0);
    }

    /// @notice get the pool address for the ticket
    /// @param _ticket to check
    /// @return roundPool the pool address for the ticket
    function getTicketPool(address _ticket) external view returns (address roundPool) {
        roundPool = roundPools[getTicketRound(_ticket)];
    }

    /// @notice checks if all conditions are met to close the round
    /// @return bool
    function canCloseCurrentRound() public view returns (bool) {
        if (!started || block.timestamp < getRoundEndTime(round)) {
            return false;
        }

        // TODO: uncomment, for test only
        // Ticket ticket;
        // address ticketAddress;
        // for (uint i = 0; i < tradingTicketsPerRound[round].length; i++) {
        //     ticketAddress = tradingTicketsPerRound[round][i];
        //     if (!ticketAlreadyExercisedInRound[round][ticketAddress]) {
        //         ticket = Ticket(ticketAddress);
        //         if (!ticket.areAllMarketsResolved()) {
        //             return false;
        //         }
        //     }
        // }
        return true;
    }

    /// @notice iterate all ticket in the current round and return true if at least one can be exercised
    /// @return bool
    function hasTicketsReadyToBeExercised() public view returns (bool) {
        Ticket ticket;
        address ticketAddress;
        for (uint i = 0; i < tradingTicketsPerRound[round].length; i++) {
            ticketAddress = tradingTicketsPerRound[round][i];
            if (!ticketAlreadyExercisedInRound[round][ticketAddress]) {
                ticket = Ticket(ticketAddress);
                if (ticket.isTicketExercisable() && !ticket.isUserTheWinner()) {
                    return true;
                }
            }
        }
        return false;
    }

    /// @notice return multiplied PnLs between rounds
    /// @param _roundA round number from
    /// @param _roundB round number to
    /// @return uint
    function cumulativePnLBetweenRounds(uint _roundA, uint _roundB) public view returns (uint) {
        return (cumulativeProfitAndLoss[_roundB] * profitAndLossPerRound[_roundA]) / cumulativeProfitAndLoss[_roundA];
    }

    /// @notice return the start time of the passed round
    /// @param _round number
    /// @return uint the start time of the given round
    function getRoundStartTime(uint _round) public view returns (uint) {
        return firstRoundStartTime + (_round - 2) * roundLength;
    }

    /// @notice return the end time of the passed round
    /// @param _round number
    /// @return uint the end time of the given round
    function getRoundEndTime(uint _round) public view returns (uint) {
        return firstRoundStartTime + (_round - 1) * roundLength;
    }

    /// @notice return the round to which a ticket belongs to
    /// @param _ticket to get the round for
    /// @return ticketRound the min round which the ticket belongs to
    function getTicketRound(address _ticket) public view returns (uint ticketRound) {
        ticketRound = roundPerTicket[_ticket];
        if (ticketRound == 0) {
            Ticket ticket = Ticket(_ticket);
            uint maturity;
            for (uint i = 0; i < ticket.numOfMarkets(); i++) {
                (, , , maturity, , , , , ) = ticket.markets(i);
                if (maturity > firstRoundStartTime) {
                    if (i == 0) {
                        ticketRound = (maturity - firstRoundStartTime) / roundLength + 2;
                    } else {
                        if (((maturity - firstRoundStartTime) / roundLength + 2) != ticketRound) {
                            ticketRound = 1;
                            break;
                        }
                    }
                } else {
                    ticketRound = 1;
                }
            }
        }
    }

    /// @notice return the count of users in current round
    /// @return uint the count of users in current round
    function getUsersCountInCurrentRound() external view returns (uint) {
        return usersPerRound[round].length;
    }

    /// @notice return the number of tickets in current rount
    /// @return numOfTickets the number of tickets in urrent rount
    function getNumberOfTradingTicketsPerRound(uint _round) external view returns (uint numOfTickets) {
        numOfTickets = tradingTicketsPerRound[_round].length;
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _depositAsDefault(uint _amount, address _roundPool, uint _round) internal {
        require(defaultLiquidityProvider != address(0), "Default LP not set");

        collateral.safeTransferFrom(defaultLiquidityProvider, _roundPool, _amount);

        balancesPerRound[_round][defaultLiquidityProvider] += _amount;
        allocationPerRound[_round] += _amount;

        emit Deposited(defaultLiquidityProvider, _amount, _round);
    }

    function _provideAsDefault(uint _amount) internal {
        require(defaultLiquidityProvider != address(0), "Default LP not set");

        collateral.safeTransferFrom(defaultLiquidityProvider, address(sportsAMM), _amount);

        balancesPerRound[1][defaultLiquidityProvider] += _amount;
        allocationPerRound[1] += _amount;

        emit Deposited(defaultLiquidityProvider, _amount, 1);
    }

    function _getOrCreateRoundPool(uint _round) internal returns (address roundPool) {
        roundPool = roundPools[_round];
        if (roundPool == address(0)) {
            if (_round == 1) {
                roundPools[_round] = defaultLiquidityProvider;
                roundPool = defaultLiquidityProvider;
            } else {
                require(poolRoundMastercopy != address(0), "Round pool mastercopy not set");
                SportsAMMV2LiquidityPoolRound newRoundPool = SportsAMMV2LiquidityPoolRound(
                    Clones.clone(poolRoundMastercopy)
                );
                newRoundPool.initialize(
                    address(this),
                    collateral,
                    _round,
                    getRoundEndTime(_round - 1),
                    getRoundEndTime(_round)
                );
                roundPool = address(newRoundPool);
                roundPools[_round] = roundPool;
                emit RoundPoolCreated(_round, roundPool);
            }
        }
    }

    function _transformToUSD(uint _amountInCollateral, uint _collateralPriceInUSD) internal pure returns (uint amountInUSD) {
        amountInUSD = (_amountInCollateral * _collateralPriceInUSD) / ONE;
    }

    /* ========== SETTERS ========== */

    /// @notice Pause/unpause LP
    /// @param _setPausing true/false
    function setPaused(bool _setPausing) external onlyOwner {
        _setPausing ? _pause() : _unpause();
    }

    /// @notice Set _poolRoundMastercopy
    /// @param _poolRoundMastercopy to clone round pools from
    function setPoolRoundMastercopy(address _poolRoundMastercopy) external onlyOwner {
        require(_poolRoundMastercopy != address(0), "Can not set a zero address!");
        poolRoundMastercopy = _poolRoundMastercopy;
        emit PoolRoundMastercopyChanged(poolRoundMastercopy);
    }

    /// @notice Set max allowed deposit
    /// @param _maxAllowedDeposit Deposit value
    function setMaxAllowedDeposit(uint _maxAllowedDeposit) external onlyOwner {
        maxAllowedDeposit = _maxAllowedDeposit;
        emit MaxAllowedDepositChanged(_maxAllowedDeposit);
    }

    /// @notice Set min allowed deposit
    /// @param _minDepositAmount Deposit value
    function setMinAllowedDeposit(uint _minDepositAmount) external onlyOwner {
        minDepositAmount = _minDepositAmount;
        emit MinAllowedDepositChanged(_minDepositAmount);
    }

    /// @notice Set _maxAllowedUsers
    /// @param _maxAllowedUsers Deposit value
    function setMaxAllowedUsers(uint _maxAllowedUsers) external onlyOwner {
        maxAllowedUsers = _maxAllowedUsers;
        emit MaxAllowedUsersChanged(_maxAllowedUsers);
    }

    /// @notice Set SportsAMM contract
    /// @param _sportsAMM SportsAMM address
    function setSportsAMM(ISportsAMMV2 _sportsAMM) external onlyOwner {
        require(address(_sportsAMM) != address(0), "Can not set a zero address!");
        if (address(sportsAMM) != address(0)) {
            collateral.approve(address(sportsAMM), 0);
        }
        sportsAMM = _sportsAMM;
        collateral.approve(address(sportsAMM), MAX_APPROVAL);
        emit SportAMMChanged(address(_sportsAMM));
    }

    /// @notice Set defaultLiquidityProvider wallet
    /// @param _defaultLiquidityProvider default liquidity provider
    function setDefaultLiquidityProvider(address _defaultLiquidityProvider) external onlyOwner {
        require(_defaultLiquidityProvider != address(0), "Can not set a zero address!");
        defaultLiquidityProvider = _defaultLiquidityProvider;
        emit DefaultLiquidityProviderChanged(_defaultLiquidityProvider);
    }

    /// @notice Set length of rounds
    /// @param _roundLength Length of a round in miliseconds
    function setRoundLength(uint _roundLength) external onlyOwner {
        require(!started, "Can't change round length after start");
        roundLength = _roundLength;
        emit RoundLengthChanged(_roundLength);
    }

    /// @notice set utilization rate parameter
    /// @param _utilizationRate value as percentage
    function setUtilizationRate(uint _utilizationRate) external onlyOwner {
        utilizationRate = _utilizationRate;
        emit UtilizationRateChanged(_utilizationRate);
    }

    /// @notice set SafeBox params
    /// @param _safeBox where to send a profit reserved for protocol from each round
    /// @param _safeBoxImpact how much is the SafeBox percentage
    function setSafeBoxParams(address _safeBox, uint _safeBoxImpact) external onlyOwner {
        safeBox = _safeBox;
        safeBoxImpact = _safeBoxImpact;
        emit SetSafeBoxParams(_safeBox, _safeBoxImpact);
    }

    /* ========== MODIFIERS ========== */

    modifier canDeposit(uint amount) {
        require(!withdrawalRequested[msg.sender], "Withdrawal is requested, cannot deposit");
        require(totalDeposited + amount <= maxAllowedDeposit, "Deposit amount exceeds AMM LP cap");
        if (balancesPerRound[round][msg.sender] == 0 && balancesPerRound[round + 1][msg.sender] == 0) {
            require(amount >= minDepositAmount, "Amount less than minDepositAmount");
        }
        _;
    }

    modifier canWithdraw() {
        require(started, "Pool has not started");
        require(!withdrawalRequested[msg.sender], "Withdrawal already requested");
        require(balancesPerRound[round][msg.sender] > 0, "Nothing to withdraw");
        require(balancesPerRound[round + 1][msg.sender] == 0, "Can't withdraw as you already deposited for next round");
        _;
    }

    modifier onlyAMM() {
        require(msg.sender == address(sportsAMM), "Only the AMM may perform these methods");
        _;
    }

    modifier roundClosingNotPrepared() {
        require(!roundClosingPrepared, "Not allowed during roundClosingPrepared");
        _;
    }

    /* ========== EVENTS ========== */

    event PoolStarted();
    event RoundPoolCreated(uint round, address roundPool);
    event Deposited(address user, uint amount, uint round);
    event WithdrawalRequested(address user);

    event SafeBoxSharePaid(uint safeBoxShare, uint safeBoxAmount);
    event RoundClosingPrepared(uint round);
    event Claimed(address user, uint amount);
    event RoundClosingBatchProcessed(uint round, uint batchSize);
    event RoundClosed(uint round, uint roundPnL);

    event PoolRoundMastercopyChanged(address newMastercopy);
    event SportAMMChanged(address sportAMM);
    event DefaultLiquidityProviderChanged(address newProvider);

    event RoundLengthChanged(uint roundLength);
    event MaxAllowedDepositChanged(uint maxAllowedDeposit);
    event MinAllowedDepositChanged(uint minAllowedDeposit);
    event MaxAllowedUsersChanged(uint maxAllowedUsersChanged);
    event UtilizationRateChanged(uint utilizationRate);
    event SetSafeBoxParams(address safeBox, uint safeBoxImpact);
}
