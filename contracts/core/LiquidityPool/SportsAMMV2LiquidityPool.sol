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
import "@thales-dao/contracts/contracts/interfaces/IAddressManager.sol";

import "./SportsAMMV2LiquidityPoolRound.sol";

import "../AMM/Ticket.sol";
import "../../interfaces/ISportsAMMV2Manager.sol";
import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2RiskManager.sol";

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
    uint private constant MAX_CURSOR_MOVES_PER_BATCH = 1000;

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

    address public poolRoundMastercopy;

    uint public totalDeposited;

    bool public roundClosingPrepared;
    uint public usersProcessedInRound;

    uint public utilizationRate;

    address public safeBox;
    uint public safeBoxImpact;

    IAddressManager public addressManager;

    bytes32 public collateralKey;

    mapping(uint => uint) public nextExerciseIndexPerRound;

    /* ========== CONSTRUCTOR ========== */

    function initialize(InitParams calldata params) external initializer {
        setOwner(params._owner);
        initNonReentrant();
        sportsAMM = ISportsAMMV2(params._sportsAMM);
        addressManager = IAddressManager(params._addressManager);

        collateral = params._collateral;
        collateralKey = params._collateralKey;
        roundLength = params._roundLength;

        _setMaxAllowedDeposit(params._maxAllowedDeposit);
        _setMinDepositAmount(params._minDepositAmount);
        _setMaxAllowedUsers(params._maxAllowedUsers);

        _setUtilizationRate(params._utilizationRate);
        _setSafeBoxParams(params._safeBox, params._safeBoxImpact);

        collateral.approve(params._sportsAMM, MAX_APPROVAL);
        round = 1;
    }

    /* ========== EXTERNAL WRITE FUNCTIONS ========== */

    /// @notice start pool and begin round #2
    function start() external onlyOwner {
        require(!started, "LPHasStarted");
        require(allocationPerRound[2] > 0, "CantStartWithoutDeposits");

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

        require(msg.sender != defaultLiquidityProvider, "CantDepositDirectlyAsDefaultLP");

        // new user enters the pool
        if (balancesPerRound[round][msg.sender] == 0 && balancesPerRound[nextRound][msg.sender] == 0) {
            require(usersCurrentlyInPool < maxAllowedUsers, "MaxUsersReached");
            usersPerRound[nextRound].push(msg.sender);
            usersCurrentlyInPool = usersCurrentlyInPool + 1;
        }

        balancesPerRound[nextRound][msg.sender] += amount;

        allocationPerRound[nextRound] += amount;
        totalDeposited += amount;

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
                "AmountExceedsUtilRate"
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
            require(ticketRound == 1, "InvalidRound");
            _provideAsDefault(amount);
        }
        tradingTicketsPerRound[ticketRound].push(ticket);
        isTradingTicketInARound[ticketRound][ticket] = true;
    }

    /// @notice transfer collateral amount from AMM to LP (ticket liquidity pool round)
    /// @param _ticket to trade
    function transferToPool(address _ticket, uint _amount) external whenNotPaused roundClosingNotPrepared onlyAMM {
        uint ticketRound = getTicketRound(_ticket);

        // if this is a past round, but not the default one, then we send the funds to the current round
        if (ticketRound > 1 && ticketRound < round) {
            ticketRound = round;
        }
        if (_amount > 0) {
            address liquidityPoolRound = ticketRound <= 1 ? defaultLiquidityProvider : _getOrCreateRoundPool(ticketRound);
            collateral.safeTransferFrom(address(sportsAMM), liquidityPoolRound, _amount);
        }
        if (isTradingTicketInARound[ticketRound][_ticket]) {
            ticketAlreadyExercisedInRound[ticketRound][_ticket] = true;
        }
    }

    /// @notice migrate ticket to next round
    /// @param _ticket ticket to migrate
    /// @param _newRound new round (0 for next round)
    /// @param _ticketIndexInRound index of ticket in round (use 0 to perform automatic lookup through the round array)
    function migrateTicketToAnotherRound(
        address _ticket,
        uint _newRound,
        uint _ticketIndexInRound
    ) external onlyWhitelistedAddresses(msg.sender) roundClosingNotPrepared {
        uint ticketRound = getTicketRound(_ticket);
        require(ticketRound == round, "TicketNotInCurrentRound");
        _migrateTicketToNewRound(_ticket, _newRound == 0 ? round + 1 : _newRound, _ticketIndexInRound);
    }

    /// @notice migrate batch of tickets to another round
    /// @param _tickets batch of tickets to migrate
    /// @param _newRound new round (0 for next round)
    /// @param _ticketsIndexInRound index of tickets in round (use 0 to perform automatic lookup through the round array)
    function migrateBatchOfTicketsToAnotherRound(
        address[] memory _tickets,
        uint _newRound,
        uint[] memory _ticketsIndexInRound
    ) external onlyWhitelistedAddresses(msg.sender) roundClosingNotPrepared {
        _newRound = _newRound == 0 ? round + 1 : _newRound;
        if (_ticketsIndexInRound.length == 0) {
            for (uint i; i < _tickets.length; i++) {
                _migrateTicketToNewRound(_tickets[i], _newRound, 0);
            }
        } else {
            require(_tickets.length == _ticketsIndexInRound.length, "ArraysLengthsMustMatch");
            uint tradingTicketsLength = tradingTicketsPerRound[round].length;
            for (uint i = 0; i < _tickets.length; i++) {
                require(_ticketsIndexInRound[i] > 0, "TicketIndexMustBeGreaterThan0");
                // check if the ticket index has not been migrated yet
                if (_ticketsIndexInRound[i] < tradingTicketsLength - i) {
                    _migrateTicketToNewRound(_tickets[i], _newRound, _ticketsIndexInRound[i]);
                } else {
                    // if the ticket index has been migrated, find the new index
                    // the new index is one of the ticket indexes in the _ticketsIndexInRound array
                    uint n;
                    bool found = false;
                    while (n < _ticketsIndexInRound.length) {
                        if (tradingTicketsPerRound[round][_ticketsIndexInRound[n]] == _tickets[i]) {
                            found = true;
                            break;
                        }
                        ++n;
                    }
                    require(found, "TicketNotFoundInInputArray");
                    _migrateTicketToNewRound(_tickets[i], _newRound, _ticketsIndexInRound[n]);
                }
            }
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
        require(_share >= ONE_PERCENT * 10 && _share <= ONE_PERCENT * 90, "InvalidWithdrawalValue");

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

    /// @notice prepare round closing - exercise tickets and ensure there are no tickets left unresolved, handle SB profit and calculate PnL
    function prepareRoundClosing() external nonReentrant whenNotPaused roundClosingNotPrepared {
        // do this first to move the cursor if needed
        exerciseTicketsReadyToBeExercised();

        require(canCloseCurrentRound(), "CantCloseRound");

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
            profitAndLossPerRound[round] = 1 ether;
        } else {
            profitAndLossPerRound[round] = (currentBalance * ONE) / allocationPerRound[round];
        }

        roundClosingPrepared = true;

        emit RoundClosingPrepared(round);
    }

    /// @notice process round closing batch - update balances and handle withdrawals
    /// @param _batchSize size of batch
    function processRoundClosingBatch(uint _batchSize) external nonReentrant whenNotPaused {
        require(roundClosingPrepared, "RoundClosingNotPrepared");
        require(usersProcessedInRound < usersPerRound[round].length, "AllUsersProcessed");
        require(_batchSize > 0, "BatchSizeZero");

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
        require(roundClosingPrepared, "RoundClosingNotPrepared");
        require(usersProcessedInRound == usersPerRound[round].length, "NotAllUsersProcessed");
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
    function exerciseTicketsReadyToBeExercised() public roundClosingNotPrepared whenNotPaused {
        _exerciseTicketsReadyToBeExercised(round);
    }

    /// @notice iterate all tickets in the default round and exercise those ready to be exercised
    function exerciseDefaultRoundTicketsReadyToBeExercised() external whenNotPaused {
        _exerciseTicketsReadyToBeExercised(1);
    }

    /// @notice iterate all tickets in the current round and exercise those ready to be exercised (batch)
    /// @param _batchSize number of tickets to be processed
    function exerciseTicketsReadyToBeExercisedBatch(
        uint _batchSize
    ) external nonReentrant whenNotPaused roundClosingNotPrepared {
        _exerciseTicketsReadyToBeExercisedBatch(_batchSize, round);
    }

    /// @notice iterate all default round tickets in the current round and exercise those ready to be exercised (batch)
    /// @param _batchSize number of tickets to be processed
    function exerciseDefaultRoundTicketsReadyToBeExercisedBatch(
        uint _batchSize
    ) external nonReentrant whenNotPaused roundClosingNotPrepared {
        _exerciseTicketsReadyToBeExercisedBatch(_batchSize, 1);
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

    /// @notice return the price of the pool collateral
    function getCollateralPrice() public view returns (uint) {
        return IPriceFeed(addressManager.getAddress("PriceFeed")).rateForCurrency(collateralKey);
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

        Ticket ticket;
        address ticketAddress;

        uint len = tradingTicketsPerRound[round].length;
        uint cursor = nextExerciseIndexPerRound[round];

        for (uint i = cursor; i < len; ++i) {
            ticketAddress = tradingTicketsPerRound[round][i];
            if (!ticketAlreadyExercisedInRound[round][ticketAddress]) {
                ticket = Ticket(ticketAddress);
                if (!ticket.areAllMarketsResolved()) {
                    return false;
                }
            }
        }
        return true;
    }

    /// @notice iterate all tickets in the current round and return true if at least one can be exercised
    /// @return bool
    function hasTicketsReadyToBeExercised() external view returns (bool) {
        return _hasTicketsReadyToBeExercised(round);
    }

    /// @notice iterate all tickets in the default round and return true if at least one can be exercised
    /// @return bool
    function hasDefaultRoundTicketsReadyToBeExercised() external view returns (bool) {
        return _hasTicketsReadyToBeExercised(1);
    }

    function _hasTicketsReadyToBeExercised(uint _round) internal view returns (bool) {
        Ticket ticket;
        address ticketAddress;

        uint len = tradingTicketsPerRound[_round].length;
        uint cursor = nextExerciseIndexPerRound[_round];

        // Only check from the current cursor onward
        for (uint i = cursor; i < len; i++) {
            ticketAddress = tradingTicketsPerRound[_round][i];
            if (!ticketAlreadyExercisedInRound[_round][ticketAddress]) {
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
            uint16 sportId;

            for (uint i = 0; i < ticket.numOfMarkets(); i++) {
                (, sportId, , maturity, , , , , ) = ticket.markets(i);
                bool isFuture = ISportsAMMV2RiskManager(addressManager.getAddress("SportsAMMV2RiskManager")).isSportIdFuture(
                    sportId
                );
                if (maturity > firstRoundStartTime && !isFuture) {
                    if (i == 0) {
                        ticketRound = (maturity - firstRoundStartTime) / roundLength + 2;
                    } else {
                        // if ticket is cross rounds, use the default round
                        if (((maturity - firstRoundStartTime) / roundLength + 2) != ticketRound) {
                            ticketRound = 1;
                            break;
                        }
                    }
                } else {
                    ticketRound = 1;
                    break;
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

    /// @notice Get the index of a ticket in a specific round's trading tickets array
    /// @param _ticket The address of the ticket to find
    /// @param _round The round number to search in
    /// @param _startIndex The starting index to search from
    /// @param _endIndex The ending index to search until
    /// @return index The index of the ticket if found, otherwise returns _endIndex
    /// @return found Whether the ticket was found
    function getTicketIndexInTicketRound(
        address _ticket,
        uint _round,
        uint _startIndex,
        uint _endIndex
    ) external view returns (uint index, bool found) {
        uint finalIndex = tradingTicketsPerRound[_round].length > _endIndex
            ? _endIndex
            : tradingTicketsPerRound[_round].length;
        for (uint i = _startIndex; i < finalIndex; ++i) {
            if (tradingTicketsPerRound[_round][i] == _ticket) {
                return (i, true);
            }
        }
        return (_endIndex, false);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _exerciseTicketsReadyToBeExercisedBatch(uint _batchSize, uint _roundNumber) internal {
        require(_batchSize > 0, "BatchSizeZero");

        uint len = tradingTicketsPerRound[_roundNumber].length;
        uint cursor = nextExerciseIndexPerRound[_roundNumber];
        uint cursorMoves;

        // 0) Pre-compaction: skip already exercised tickets, up to 1000 moves
        while (
            cursor < len &&
            ticketAlreadyExercisedInRound[_roundNumber][tradingTicketsPerRound[_roundNumber][cursor]] &&
            cursorMoves < MAX_CURSOR_MOVES_PER_BATCH
        ) {
            unchecked {
                ++cursor;
                ++cursorMoves;
            }
        }

        // ✅ Early exit if we spent this batch just moving the cursor
        if (cursorMoves >= MAX_CURSOR_MOVES_PER_BATCH) {
            nextExerciseIndexPerRound[_roundNumber] = cursor;
            return;
        }

        uint processed;

        // 1) Process at most _batchSize *exercised* tickets starting from the current cursor
        for (uint i = cursor; i < len && processed < _batchSize; ++i) {
            if (_exerciseTicket(_roundNumber, tradingTicketsPerRound[_roundNumber][i])) {
                unchecked {
                    ++processed;
                }
            }
        }

        // 2) Post-compaction: move cursor again, up to the same remaining allowance
        while (
            cursor < len &&
            ticketAlreadyExercisedInRound[_roundNumber][tradingTicketsPerRound[_roundNumber][cursor]] &&
            cursorMoves < MAX_CURSOR_MOVES_PER_BATCH
        ) {
            unchecked {
                ++cursor;
                ++cursorMoves;
            }
        }

        nextExerciseIndexPerRound[_roundNumber] = cursor;
    }

    function _exerciseTicketsReadyToBeExercised(uint _roundNumber) internal {
        uint len = tradingTicketsPerRound[_roundNumber].length;
        uint cursor = nextExerciseIndexPerRound[_roundNumber];

        // 0) Pre-compaction: skip over any tickets that were marked exercised
        // since last time (e.g. via transferToPool or batch calls)
        while (cursor < len && ticketAlreadyExercisedInRound[_roundNumber][tradingTicketsPerRound[_roundNumber][cursor]]) {
            unchecked {
                ++cursor;
            }
        }

        // 1) Process from the (updated) cursor onward
        for (uint i = cursor; i < len; ++i) {
            _exerciseTicket(_roundNumber, tradingTicketsPerRound[_roundNumber][i]);
        }

        // 2) Post-compaction: some tickets starting at `cursor` may now be exercised;
        // move cursor forward over that newly-exercised prefix.
        while (cursor < len && ticketAlreadyExercisedInRound[_roundNumber][tradingTicketsPerRound[_roundNumber][cursor]]) {
            unchecked {
                ++cursor;
            }
        }

        nextExerciseIndexPerRound[_roundNumber] = cursor;
    }

    function _exerciseTicket(uint _roundNumber, address ticketAddress) internal returns (bool exercised) {
        if (!ticketAlreadyExercisedInRound[_roundNumber][ticketAddress]) {
            Ticket ticket = Ticket(ticketAddress);
            bool isWinner = ticket.isUserTheWinner();

            bool isSystemExercisable = false;
            bool isSystem = false;
            if (_roundNumber > 1) {
                isSystem = ticket.isSystem();
            }
            // in case round needs to be closed, ensure all system bets are exercised too, as there could be money in those that needs to be returned to LP rounds
            if (isSystem && block.timestamp > getRoundEndTime(_roundNumber)) {
                isSystemExercisable = true;
            }
            if (ticket.isTicketExercisable() && (!isWinner || isSystemExercisable)) {
                sportsAMM.handleTicketResolving(ticketAddress, ISportsAMMV2.TicketAction.Exercise);
            }
            if ((isWinner && !isSystem) || ticket.resolved()) {
                ticketAlreadyExercisedInRound[_roundNumber][ticketAddress] = true;
                exercised = true;
            }
        }
    }

    function _depositAsDefault(uint _amount, address _roundPool, uint _round) internal {
        require(defaultLiquidityProvider != address(0), "DefaultLPNotSet");

        collateral.safeTransferFrom(defaultLiquidityProvider, _roundPool, _amount);

        balancesPerRound[_round][defaultLiquidityProvider] += _amount;
        allocationPerRound[_round] += _amount;

        emit Deposited(defaultLiquidityProvider, _amount, _round);
    }

    function _provideAsDefault(uint _amount) internal {
        require(defaultLiquidityProvider != address(0), "DefaultLPNotSet");

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
                require(poolRoundMastercopy != address(0), "RoundPoolMastercopyNotSet");
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

    function _migrateTicketToNewRound(address _ticket, uint _newRound, uint _ticketIndexInRound) internal {
        require(_newRound > round || _newRound == 1, "RoundAlreadyClosed");
        uint ticketRound = getTicketRound(_ticket);
        require(ticketRound == round, "TicketNotInRound");
        require(isTradingTicketInARound[ticketRound][_ticket], "TicketNotInCurrentRound");
        require(!ticketAlreadyExercisedInRound[ticketRound][_ticket], "TicketAlreadyExercised");
        require(!Ticket(_ticket).resolved(), "TicketAlreadyResolved");

        // removing from old round
        delete isTradingTicketInARound[ticketRound][_ticket];
        _removeTicketFromRound(ticketRound, _ticket, _ticketIndexInRound);

        // transfer funds from new pool to old pool
        address oldLiquidityPoolRound = _getOrCreateRoundPool(ticketRound);
        address newLiquidityPoolRound = _getOrCreateRoundPool(_newRound);
        uint transferAmountNewToOld = collateral.balanceOf(_ticket) - Ticket(_ticket).buyInAmount();
        uint newPoolBalance = collateral.balanceOf(newLiquidityPoolRound);
        if (transferAmountNewToOld > newPoolBalance) {
            uint differenceToLPAsDefault = transferAmountNewToOld - newPoolBalance;
            _depositAsDefault(differenceToLPAsDefault, newLiquidityPoolRound, _newRound);
        }
        collateral.safeTransferFrom(newLiquidityPoolRound, oldLiquidityPoolRound, transferAmountNewToOld);

        // adding ticket to new round
        roundPerTicket[_ticket] = _newRound;
        isTradingTicketInARound[_newRound][_ticket] = true;
        tradingTicketsPerRound[_newRound].push(_ticket);
        emit TicketMigratedToNextRound(_ticket, ticketRound, _newRound);
    }

    function _removeTicketFromRound(uint _round, address _ticket, uint _ticketIndexInRound) internal {
        // if _ticketIndexInRound is 0, we need to find the ticket in the round and remove it
        // lookup is performed by iterating through the array
        bool found;
        if (_ticketIndexInRound == 0) {
            for (uint i; i < tradingTicketsPerRound[_round].length; ++i) {
                if (tradingTicketsPerRound[_round][i] == _ticket) {
                    found = true;
                    _ticketIndexInRound = i;
                    break;
                }
            }
        } else {
            found =
                _ticketIndexInRound < tradingTicketsPerRound[_round].length &&
                tradingTicketsPerRound[_round][_ticketIndexInRound] == _ticket;
        }
        require(found, "TicketNotFound");

        // adjust cursor if needed so we don't skip anything
        uint cursor = nextExerciseIndexPerRound[_round];
        if (_ticketIndexInRound < cursor) {
            nextExerciseIndexPerRound[_round] = _ticketIndexInRound;
        }

        tradingTicketsPerRound[_round][_ticketIndexInRound] = tradingTicketsPerRound[_round][
            tradingTicketsPerRound[_round].length - 1
        ];
        tradingTicketsPerRound[_round].pop();
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
        require(_poolRoundMastercopy != address(0), "ZeroAddress");
        poolRoundMastercopy = _poolRoundMastercopy;
        emit PoolRoundMastercopyChanged(poolRoundMastercopy);
    }

    /// @notice Set max allowed deposit
    /// @param _maxAllowedDeposit Deposit value
    function setMaxAllowedDeposit(uint _maxAllowedDeposit) external onlyOwner {
        _setMaxAllowedDeposit(_maxAllowedDeposit);
    }

    /// @notice Set min allowed deposit
    /// @param _minDepositAmount Deposit value
    function setMinAllowedDeposit(uint _minDepositAmount) external onlyOwner {
        _setMinDepositAmount(_minDepositAmount);
    }

    /// @notice Set _maxAllowedUsers
    /// @param _maxAllowedUsers Deposit value
    function setMaxAllowedUsers(uint _maxAllowedUsers) external onlyOwner {
        _setMaxAllowedUsers(_maxAllowedUsers);
    }

    // ==================== INTERNAL HELPERS ====================

    function _setMaxAllowedDeposit(uint _maxAllowedDeposit) internal {
        maxAllowedDeposit = _maxAllowedDeposit;
        emit MaxAllowedDepositChanged(_maxAllowedDeposit);
    }

    function _setMinDepositAmount(uint _minDepositAmount) internal {
        minDepositAmount = _minDepositAmount;
        emit MinAllowedDepositChanged(_minDepositAmount);
    }

    function _setMaxAllowedUsers(uint _maxAllowedUsers) internal {
        maxAllowedUsers = _maxAllowedUsers;
        emit MaxAllowedUsersChanged(_maxAllowedUsers);
    }

    /// @notice Set SportsAMM contract
    /// @param _sportsAMM SportsAMM address
    function setSportsAMM(ISportsAMMV2 _sportsAMM) external onlyOwner {
        require(address(_sportsAMM) != address(0), "ZeroAddress");
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
        require(_defaultLiquidityProvider != address(0), "ZeroAddress");
        defaultLiquidityProvider = _defaultLiquidityProvider;
        emit DefaultLiquidityProviderChanged(_defaultLiquidityProvider);
    }

    /// @notice Set length of rounds
    /// @param _roundLength Length of a round in seconds
    function setRoundLength(uint _roundLength) external onlyOwner {
        require(!started, "CantChangeAfterPoolStart");
        roundLength = _roundLength;
        emit RoundLengthChanged(_roundLength);
    }

    /// @notice set utilization rate parameter
    /// @param _utilizationRate value as percentage
    function setUtilizationRate(uint _utilizationRate) external onlyOwner {
        _setUtilizationRate(_utilizationRate);
    }

    /// @notice set SafeBox params
    /// @param _safeBox where to send a profit reserved for protocol from each round
    /// @param _safeBoxImpact how much is the SafeBox percentage
    function setSafeBoxParams(address _safeBox, uint _safeBoxImpact) external onlyOwner {
        _setSafeBoxParams(_safeBox, _safeBoxImpact);
    }

    function _setUtilizationRate(uint _utilizationRate) internal {
        require(_utilizationRate <= ONE, "UtilRateTooHigh");
        utilizationRate = _utilizationRate;
        emit UtilizationRateChanged(_utilizationRate);
    }

    function _setSafeBoxParams(address _safeBox, uint _safeBoxImpact) internal {
        require(_safeBoxImpact <= ONE, "SafeBoxImpactTooHigh");
        safeBox = _safeBox;
        safeBoxImpact = _safeBoxImpact;
        emit SetSafeBoxParams(_safeBox, _safeBoxImpact);
    }

    /* ========== MODIFIERS ========== */

    modifier canDeposit(uint amount) {
        require(!withdrawalRequested[msg.sender], "CantDepositDuringWithdrawalRequested");
        require(totalDeposited + amount <= maxAllowedDeposit, "AmountExceedsLPCap");
        if (balancesPerRound[round][msg.sender] == 0 && balancesPerRound[round + 1][msg.sender] == 0) {
            require(amount >= minDepositAmount, "AmountLessThanMinDeposit");
        }
        _;
    }

    modifier canWithdraw() {
        require(started, "PoolNotStarted");
        require(!withdrawalRequested[msg.sender], "WithdrawalAlreadyRequested");
        require(balancesPerRound[round][msg.sender] > 0, "NothingToWithdraw");
        require(balancesPerRound[round + 1][msg.sender] == 0, "Can't withdraw as you already deposited for next round");
        _;
    }

    modifier onlyAMM() {
        require(msg.sender == address(sportsAMM), "OnlyFromAMM");
        _;
    }

    modifier roundClosingNotPrepared() {
        require(!roundClosingPrepared, "NotAllowedWhenRoundClosingPrepared");
        _;
    }

    modifier onlyWhitelistedAddresses(address sender) {
        require(
            sender == owner || sportsAMM.manager().isWhitelistedAddress(sender, ISportsAMMV2Manager.Role.MARKET_RESOLVING),
            "InvalidSender"
        );
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

    event TicketMigratedToNextRound(address ticket, uint oldRound, uint newRound);
}
