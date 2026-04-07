// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../utils/proxy/ProxyReentrancyGuard.sol";
import "../../utils/proxy/ProxyOwned.sol";
import "../../utils/proxy/ProxyPausable.sol";

/// @title CasinoFreeBetsHolder
/// @author Overtime
/// @notice Holds free bet balances for casino games. Casino contracts call useFreeBet() to
///         consume a user's balance and receive the tokens. On freebet wins, casino contracts
///         send the original stake back here; the owner can withdraw accumulated stakes.
contract CasinoFreeBetsHolder is Initializable, ProxyOwned, ProxyPausable, ProxyReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ========== ERRORS ========== */

    error InvalidAddress();
    error InvalidAmount();
    error InvalidSender();
    error InsufficientBalance();
    error FreeBetExpired();

    /* ========== STATE ========== */

    /// @notice Free bet balance per user per collateral
    mapping(address => mapping(address => uint)) public balancePerUserAndCollateral;

    /// @notice Expiration timestamp per user per collateral
    mapping(address => mapping(address => uint)) public expirationPerUserAndCollateral;

    /// @notice Whether an address is a whitelisted casino contract
    mapping(address => bool) public whitelistedCasino;

    /// @notice Default expiration period for new free bets (in seconds)
    uint public expirationPeriod;

    /* ========== INIT ========== */

    function initialize(address _owner, uint _expirationPeriod) external initializer {
        if (_owner == address(0)) revert InvalidAddress();

        setOwner(_owner);
        initNonReentrant();
        expirationPeriod = _expirationPeriod;
    }

    /* ========== FUNDING ========== */

    /// @notice Fund a single user with free bet balance
    function fund(address user, address collateral, uint amount) external nonReentrant notPaused {
        if (user == address(0) || collateral == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        IERC20(collateral).safeTransferFrom(msg.sender, address(this), amount);

        balancePerUserAndCollateral[user][collateral] += amount;

        if (expirationPerUserAndCollateral[user][collateral] == 0) {
            expirationPerUserAndCollateral[user][collateral] = block.timestamp + expirationPeriod;
        }

        emit UserFunded(user, collateral, amount, msg.sender);
    }

    /// @notice Fund multiple users with equal amounts
    function fundBatch(address[] calldata users, address collateral, uint amountPerUser) external nonReentrant notPaused {
        if (collateral == address(0)) revert InvalidAddress();
        if (amountPerUser == 0) revert InvalidAmount();

        uint total = amountPerUser * users.length;
        IERC20(collateral).safeTransferFrom(msg.sender, address(this), total);

        for (uint i = 0; i < users.length; i++) {
            if (users[i] == address(0)) revert InvalidAddress();
            balancePerUserAndCollateral[users[i]][collateral] += amountPerUser;
            if (expirationPerUserAndCollateral[users[i]][collateral] == 0) {
                expirationPerUserAndCollateral[users[i]][collateral] = block.timestamp + expirationPeriod;
            }
            emit UserFunded(users[i], collateral, amountPerUser, msg.sender);
        }
    }

    /// @notice Remove a user's free bet funding (owner only)
    function removeUserFunding(address user, address collateral) external onlyOwner {
        uint balance = balancePerUserAndCollateral[user][collateral];
        if (balance == 0) revert InvalidAmount();

        balancePerUserAndCollateral[user][collateral] = 0;
        expirationPerUserAndCollateral[user][collateral] = 0;

        IERC20(collateral).safeTransfer(owner, balance);

        emit UserFundingRemoved(user, collateral, balance);
    }

    /// @notice Remove expired free bet funding (callable by anyone)
    function removeExpiredFunding(address user, address collateral) external {
        uint expiry = expirationPerUserAndCollateral[user][collateral];
        if (expiry == 0 || block.timestamp < expiry) revert FreeBetExpired();

        uint balance = balancePerUserAndCollateral[user][collateral];
        if (balance == 0) revert InvalidAmount();

        balancePerUserAndCollateral[user][collateral] = 0;
        expirationPerUserAndCollateral[user][collateral] = 0;

        IERC20(collateral).safeTransfer(owner, balance);

        emit UserFundingRemoved(user, collateral, balance);
    }

    /* ========== CASINO INTEGRATION ========== */

    /// @notice Called by whitelisted casino contracts to consume a user's free bet
    function useFreeBet(address user, address collateral, uint amount) external nonReentrant {
        if (!whitelistedCasino[msg.sender]) revert InvalidSender();
        if (amount == 0) revert InvalidAmount();

        uint expiry = expirationPerUserAndCollateral[user][collateral];
        if (expiry != 0 && block.timestamp >= expiry) revert FreeBetExpired();

        uint balance = balancePerUserAndCollateral[user][collateral];
        if (balance < amount) revert InsufficientBalance();

        balancePerUserAndCollateral[user][collateral] = balance - amount;

        IERC20(collateral).safeTransfer(msg.sender, amount);

        emit FreeBetUsed(user, collateral, amount, msg.sender);
    }

    /// @notice Withdraw accumulated returned stakes (owner only)
    function withdrawCollateral(address collateral, address recipient, uint amount) external onlyOwner {
        address to = recipient == address(0) ? owner : recipient;
        IERC20(collateral).safeTransfer(to, amount);
        emit WithdrawnCollateral(collateral, to, amount);
    }

    /* ========== SETTERS ========== */

    function setWhitelistedCasino(address casino, bool enabled) external onlyOwner {
        if (casino == address(0)) revert InvalidAddress();
        whitelistedCasino[casino] = enabled;
        emit WhitelistedCasinoChanged(casino, enabled);
    }

    function setExpirationPeriod(uint _period) external onlyOwner {
        expirationPeriod = _period;
        emit ExpirationPeriodChanged(_period);
    }

    function setPausedByOwner(bool _paused) external onlyOwner {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) lastPauseTime = block.timestamp;
            emit PauseChanged(_paused);
        }
    }

    /* ========== EVENTS ========== */

    event UserFunded(address indexed user, address indexed collateral, uint amount, address funder);
    event UserFundingRemoved(address indexed user, address indexed collateral, uint amount);
    event FreeBetUsed(address indexed user, address indexed collateral, uint amount, address indexed casino);
    event WhitelistedCasinoChanged(address indexed casino, bool enabled);
    event ExpirationPeriodChanged(uint period);
    event WithdrawnCollateral(address indexed collateral, address indexed recipient, uint amount);
}
