// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ICasinoCoreV2
/// @author Overtime
/// @notice Treasury + shared services used by every V2 casino game. Holds liquidity, VRF config,
/// supported collateral, free-bets and referrals wiring, plus a per-game P&L circuit breaker.
/// Games are registered by the owner and call into this contract for funds, randomness, and
/// settlement bookkeeping. Existing v1 games are NOT migrated — they keep their own balances
interface ICasinoCoreV2 {
    /* ========== ENUMS ========== */

    /// @notice Reasons a game may be inactive for new bets
    enum GameInactiveReason {
        NONE,
        NOT_REGISTERED,
        TREASURY_PAUSED,
        GAME_PAUSED,
        AUTO_PAUSED
    }

    /* ========== EVENTS ========== */

    event GameRegistered(address indexed game);
    event GameDeregistered(address indexed game);
    event GamePauseChanged(address indexed game, bool paused);
    event GameAutoPaused(address indexed game, int256 houseNetUsd, uint256 maxNetLossUsd);
    event GameCircuitBreakerReset(address indexed game);
    event MaxNetLossPerGameUsdChanged(address indexed game, uint256 value);
    event DefaultMaxNetLossPerGameUsdChanged(uint256 value);

    event CollateralConfigChanged(address indexed collateral, bytes32 currencyKey, bool supported);
    event RiskParamsChanged(uint256 maxProfitUsd, uint256 cancelTimeout);
    event AddressesChanged(
        address manager,
        address priceFeed,
        address vrfCoordinator,
        address freeBetsHolder,
        address referrals
    );
    event VrfConfigChanged(
        uint256 subscriptionId,
        bytes32 keyHash,
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        bool nativePayment
    );
    event WithdrawnCollateral(address indexed collateral, address indexed recipient, uint256 amount);

    event StakePulled(address indexed game, address indexed user, address indexed collateral, uint256 amount);
    event FreeBetUsed(address indexed game, address indexed user, address indexed collateral, uint256 amount);
    event ReservationChanged(address indexed game, address indexed collateral, int256 delta, uint256 totalReserved);
    event PayoutSent(
        address indexed game,
        address indexed user,
        address indexed collateral,
        uint256 amount,
        bool isFreeBet,
        uint256 originalStake
    );
    event SettlementRecorded(
        address indexed game,
        address indexed collateral,
        uint256 stake,
        uint256 payout,
        int256 newHouseNetUsd
    );
    event RandomWordsRequested(address indexed game, uint256 indexed requestId, uint32 numWords);
    event RandomWordsFulfilled(address indexed game, uint256 indexed requestId);

    event ReferrerSet(address indexed user, address indexed referrer);
    event ReferrerPaid(address indexed referrer, address indexed user, uint256 amount, uint256 stake, address collateral);
    event ReferrerPayoutFailed(
        address indexed referrer,
        address indexed user,
        uint256 amount,
        uint256 stake,
        address collateral
    );

    /// @notice Emitted when `confirmCasinoBetResolved` reverts on the FreeBetsHolder during a
    /// payout. The token transfer to FBH already happened — funds are stuck in FBH but the
    /// casino settlement completes
    event FreeBetConfirmFailed(
        address indexed game,
        address indexed user,
        address indexed collateral,
        uint256 amount,
        uint256 originalStake
    );

    /// @notice Emitted when `recordSettlement` couldn't convert collateral to USD (price feed
    /// reverted). The settlement bookkeeping still completes; the circuit-breaker gauge is
    /// not updated for this round
    event SettlementUsdConversionFailed(address indexed game, address indexed collateral, uint256 stake, uint256 payout);

    /* ========== GAME-FACING METHODS (only callable by registered active games) ========== */

    /// @notice Pulls `amount` of `collateral` from `user` into core. User must have approved core
    function pullFromUser(address user, address collateral, uint256 amount) external;

    /// @notice Routes a free-bet draw through core to the FreeBetsHolder
    function useFreeBet(address user, address collateral, uint256 amount) external;

    /// @notice Optionally records a referrer for a user before placing a bet
    function setReferrer(address referrer, address user) external;

    /// @notice Requests `numWords` random words from Chainlink VRF for the calling game.
    /// Treasury is the registered consumer; callback is dispatched back to the calling game
    function requestRandomWords(uint32 numWords) external returns (uint256 requestId);

    /// @notice Bumps the calling game's reservation for `collateral` by `amount`. Reverts if
    /// the resulting total reservation exceeds available bankroll
    function reserveOrRevert(address collateral, uint256 amount) external;

    /// @notice Releases `amount` from the calling game's reservation for `collateral`
    function releaseReservation(address collateral, uint256 amount) external;

    /// @notice Sends `amount` of `collateral` to `user`, or to FreeBetsHolder if `isFreeBet`
    /// @dev `originalStake` is forwarded to FreeBetsHolder.confirmCasinoBetResolved
    function payOut(address user, address collateral, uint256 amount, bool isFreeBet, uint256 originalStake) external;

    /// @notice Pays the user's referrer (if any), best-effort. Skipped on free-bet flows
    function payReferrer(address user, address collateral, uint256 stake) external;

    /// @notice Records a settled bet's stake and payout for circuit-breaker accounting.
    /// Triggers auto-pause if the calling game's running net loss exceeds its threshold
    function recordSettlement(address collateral, uint256 stake, uint256 payout) external;

    /* ========== PUBLIC VIEWS ========== */

    function isGameRegistered(address game) external view returns (bool);

    function gameInactiveReason(address game) external view returns (GameInactiveReason);

    function getCollateralPrice(address collateral) external view returns (uint256);

    function getUsdValue(address collateral, uint256 amount) external view returns (uint256);

    function getAvailableLiquidity(address collateral) external view returns (uint256);

    function reservedProfitPerCollateral(address collateral) external view returns (uint256);

    function reservedProfitPerGame(address game, address collateral) external view returns (uint256);

    function houseNetUsd(address game) external view returns (int256);

    function maxNetLossPerGameUsd(address game) external view returns (uint256);

    function gamePaused(address game) external view returns (bool);

    function gameAutoPaused(address game) external view returns (bool);

    function getRegisteredGames() external view returns (address[] memory);

    function freeBetsHolder() external view returns (address);

    function maxProfitUsd() external view returns (uint256);

    function cancelTimeout() external view returns (uint256);

    function supportedCollateral(address collateral) external view returns (bool);
}
