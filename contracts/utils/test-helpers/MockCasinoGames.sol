// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test mocks that implement the read surface CasinoData consumes for each casino game.
/// Each mock stores per-id records and ordered id arrays so unit tests can drive the aggregator
/// end-to-end without spinning up the full game contracts

abstract contract MockBaseGame {
    struct BaseRecord {
        address user;
        address collateral;
        uint amount;
        uint payout;
    }

    mapping(uint => BaseRecord) internal _base;
    mapping(uint => bool) public isFreeBet;
    mapping(address => uint[]) internal _userIds;
    uint[] internal _allIds;
    uint public nextId;

    constructor() {
        nextId = 1;
    }

    function _record(uint id, address user, address collateral, uint amount, uint payout, bool free) internal {
        _base[id] = BaseRecord({user: user, collateral: collateral, amount: amount, payout: payout});
        if (free) isFreeBet[id] = true;
        _userIds[user].push(id);
        _allIds.push(id);
        if (id >= nextId) nextId = id + 1;
    }

    function _getRecent(uint offset, uint limit) internal view returns (uint[] memory ids) {
        uint len = _allIds.length;
        if (offset >= len) return new uint[](0);
        uint remaining = len - offset;
        uint count = remaining < limit ? remaining : limit;
        ids = new uint[](count);
        for (uint i; i < count; ++i) {
            ids[i] = _allIds[len - 1 - offset - i];
        }
    }

    function _getUser(address user, uint offset, uint limit) internal view returns (uint[] memory ids) {
        uint[] storage all = _userIds[user];
        uint len = all.length;
        if (offset >= len) return new uint[](0);
        uint remaining = len - offset;
        uint count = remaining < limit ? remaining : limit;
        ids = new uint[](count);
        for (uint i; i < count; ++i) {
            ids[i] = all[len - 1 - offset - i];
        }
    }
}

contract MockRouletteGame is MockBaseGame {
    struct RouletteFlags {
        uint8 status;
        bool won;
        uint8 result;
    }

    struct RoulettePick {
        uint8 betType;
        uint8 selection;
        bool won;
        uint amount;
        uint reservedProfit;
        uint payout;
    }

    mapping(uint => RouletteFlags) internal _flags;
    mapping(uint => RoulettePick[]) internal _picks;
    mapping(uint => uint) public placedAt;

    function setBet(
        uint id,
        address user,
        address collateral,
        uint amount,
        uint payout,
        uint8 status,
        bool won,
        bool free
    ) external {
        _record(id, user, collateral, amount, payout, free);
        _flags[id] = RouletteFlags({status: status, won: won, result: 0});
    }

    /// @notice Sets the wheel result and replaces the picks array. Picks are synthesized from
    /// (single primary betType/selection + amount + payout) when none are stored, matching the
    /// real Roulette.getBetDetails behavior
    function setBetExtras(uint id, uint8 result, uint placed, RoulettePick[] memory picks) external {
        _flags[id].result = result;
        placedAt[id] = placed;
        delete _picks[id];
        for (uint i; i < picks.length; ++i) _picks[id].push(picks[i]);
    }

    function getBetBase(
        uint id
    ) external view returns (address user, address collateral, uint amount, uint payout, uint, uint placed, uint, uint) {
        BaseRecord memory b = _base[id];
        user = b.user;
        collateral = b.collateral;
        amount = b.amount;
        payout = b.payout;
        placed = placedAt[id];
    }

    function getBetDetails(
        uint id
    ) external view returns (RoulettePick[] memory picks, uint8 status, uint8 result, bool won) {
        RouletteFlags memory f = _flags[id];
        RoulettePick[] storage stored = _picks[id];
        uint n = stored.length;
        if (n == 0) {
            BaseRecord memory b = _base[id];
            picks = new RoulettePick[](1);
            picks[0] = RoulettePick({
                betType: 0,
                selection: 0,
                won: f.won,
                amount: b.amount,
                reservedProfit: 0,
                payout: b.payout
            });
        } else {
            picks = new RoulettePick[](n);
            for (uint i; i < n; ++i) picks[i] = stored[i];
        }
        return (picks, f.status, f.result, f.won);
    }

    function nextBetId() external view returns (uint) {
        return nextId;
    }

    function getRecentBetIds(uint offset, uint limit) external view returns (uint[] memory) {
        return _getRecent(offset, limit);
    }

    function getUserBetIds(address user, uint offset, uint limit) external view returns (uint[] memory) {
        return _getUser(user, offset, limit);
    }
}

contract MockDiceGame is MockBaseGame {
    struct DiceFlags {
        uint8 status;
        bool won;
        uint8 betType;
        uint8 target;
        uint8 result;
    }

    mapping(uint => DiceFlags) internal _flags;
    mapping(uint => uint) public placedAt;

    function setBet(
        uint id,
        address user,
        address collateral,
        uint amount,
        uint payout,
        uint8 status,
        bool won,
        bool free
    ) external {
        _record(id, user, collateral, amount, payout, free);
        _flags[id] = DiceFlags({status: status, won: won, betType: 0, target: 0, result: 0});
    }

    function setBetExtras(uint id, uint8 betType, uint8 target, uint8 result, uint placed) external {
        DiceFlags storage f = _flags[id];
        f.betType = betType;
        f.target = target;
        f.result = result;
        placedAt[id] = placed;
    }

    function getBetBase(
        uint id
    ) external view returns (address user, address collateral, uint amount, uint payout, uint, uint placed, uint, uint) {
        BaseRecord memory b = _base[id];
        user = b.user;
        collateral = b.collateral;
        amount = b.amount;
        payout = b.payout;
        placed = placedAt[id];
    }

    function getBetDetails(
        uint id
    ) external view returns (uint8 betType, uint8 status, uint8 target, uint8 result, bool won) {
        DiceFlags memory f = _flags[id];
        return (f.betType, f.status, f.target, f.result, f.won);
    }

    function nextBetId() external view returns (uint) {
        return nextId;
    }

    function getRecentBetIds(uint offset, uint limit) external view returns (uint[] memory) {
        return _getRecent(offset, limit);
    }

    function getUserBetIds(address user, uint offset, uint limit) external view returns (uint[] memory) {
        return _getUser(user, offset, limit);
    }
}

contract MockBaccaratGame is MockBaseGame {
    struct BaccaratFlags {
        uint8 status;
        bool won;
        bool isPush;
        uint8 betType;
        uint8 playerTotal;
        uint8 bankerTotal;
    }

    mapping(uint => BaccaratFlags) internal _flags;
    mapping(uint => uint8[6]) internal _cards;
    mapping(uint => uint) public placedAt;

    function setBet(
        uint id,
        address user,
        address collateral,
        uint amount,
        uint payout,
        uint8 status,
        bool won,
        bool isPush,
        bool free
    ) external {
        _record(id, user, collateral, amount, payout, free);
        _flags[id] = BaccaratFlags({status: status, won: won, isPush: isPush, betType: 0, playerTotal: 0, bankerTotal: 0});
    }

    function setBetExtras(
        uint id,
        uint8 betType,
        uint8 playerTotal,
        uint8 bankerTotal,
        uint8[6] memory cards,
        uint placed
    ) external {
        BaccaratFlags storage f = _flags[id];
        f.betType = betType;
        f.playerTotal = playerTotal;
        f.bankerTotal = bankerTotal;
        _cards[id] = cards;
        placedAt[id] = placed;
    }

    function getBetBase(
        uint id
    ) external view returns (address user, address collateral, uint amount, uint payout, uint, uint placed, uint, uint) {
        BaseRecord memory b = _base[id];
        user = b.user;
        collateral = b.collateral;
        amount = b.amount;
        payout = b.payout;
        placed = placedAt[id];
    }

    function getBetDetails(
        uint id
    )
        external
        view
        returns (
            uint8 betType,
            uint8 status,
            uint8 result,
            bool won,
            bool isPush,
            uint8[6] memory cards,
            uint8 playerTotal,
            uint8 bankerTotal
        )
    {
        BaccaratFlags memory f = _flags[id];
        betType = f.betType;
        status = f.status;
        result = 0;
        won = f.won;
        isPush = f.isPush;
        cards = _cards[id];
        playerTotal = f.playerTotal;
        bankerTotal = f.bankerTotal;
    }

    function nextBetId() external view returns (uint) {
        return nextId;
    }

    function getRecentBetIds(uint offset, uint limit) external view returns (uint[] memory) {
        return _getRecent(offset, limit);
    }

    function getUserBetIds(address user, uint offset, uint limit) external view returns (uint[] memory) {
        return _getUser(user, offset, limit);
    }
}

contract MockSlotsGame is MockBaseGame {
    struct SlotsFlags {
        uint8 status;
        bool won;
    }

    mapping(uint => SlotsFlags) internal _flags;
    mapping(uint => uint8[3]) internal _reels;
    mapping(uint => uint) public placedAt;

    function setSpin(
        uint id,
        address user,
        address collateral,
        uint amount,
        uint payout,
        uint8 status,
        bool won,
        bool free
    ) external {
        _record(id, user, collateral, amount, payout, free);
        _flags[id] = SlotsFlags({status: status, won: won});
    }

    function setSpinExtras(uint id, uint8[3] memory reels, uint placed) external {
        _reels[id] = reels;
        placedAt[id] = placed;
    }

    function getSpinBase(
        uint id
    ) external view returns (address user, address collateral, uint amount, uint payout, uint, uint placed, uint, uint) {
        BaseRecord memory b = _base[id];
        user = b.user;
        collateral = b.collateral;
        amount = b.amount;
        payout = b.payout;
        placed = placedAt[id];
    }

    function getSpinDetails(uint id) external view returns (uint8 status, uint8[3] memory reels, bool won) {
        SlotsFlags memory f = _flags[id];
        return (f.status, _reels[id], f.won);
    }

    function nextSpinId() external view returns (uint) {
        return nextId;
    }

    function getRecentSpinIds(uint offset, uint limit) external view returns (uint[] memory) {
        return _getRecent(offset, limit);
    }

    function getUserSpinIds(address user, uint offset, uint limit) external view returns (uint[] memory) {
        return _getUser(user, offset, limit);
    }
}

contract MockBlackjackGame is MockBaseGame {
    struct BlackjackFlags {
        uint8 status;
        uint8 result;
        bool isDoubledDown;
    }

    struct SplitData {
        uint amount2;
        uint payout2;
        uint8 result2;
        bool isDoubled2;
    }

    mapping(uint => BlackjackFlags) internal _flags;
    mapping(uint => bool) public isSplit;
    mapping(uint => SplitData) internal _splits;
    mapping(uint => uint8[]) internal _playerCards;
    mapping(uint => uint8[]) internal _dealerCards;
    mapping(uint => uint8[]) internal _player2Cards;
    mapping(uint => uint) public lastRequestAt;
    mapping(uint => uint) public placedAt;

    function setHand(
        uint id,
        address user,
        address collateral,
        uint amount,
        uint payout,
        uint8 status,
        uint8 result,
        bool free
    ) external {
        _record(id, user, collateral, amount, payout, free);
        _flags[id] = BlackjackFlags({status: status, result: result, isDoubledDown: false});
    }

    function setSplit(uint id, uint amount2, uint payout2, uint8 result2) external {
        isSplit[id] = true;
        _splits[id] = SplitData({amount2: amount2, payout2: payout2, result2: result2, isDoubled2: false});
    }

    function setHandExtras(
        uint id,
        bool isDoubledDown,
        uint placed,
        uint requested,
        uint8[] memory playerCards,
        uint8[] memory dealerCards
    ) external {
        _flags[id].isDoubledDown = isDoubledDown;
        placedAt[id] = placed;
        lastRequestAt[id] = requested;
        _playerCards[id] = playerCards;
        _dealerCards[id] = dealerCards;
    }

    function setSplitExtras(uint id, bool isDoubled2, uint8[] memory player2Cards) external {
        _splits[id].isDoubled2 = isDoubled2;
        _player2Cards[id] = player2Cards;
    }

    function getHandBase(
        uint id
    ) external view returns (address user, address collateral, uint amount, uint payout, uint, uint placed, uint, uint) {
        BaseRecord memory b = _base[id];
        user = b.user;
        collateral = b.collateral;
        amount = b.amount;
        payout = b.payout;
        placed = placedAt[id];
    }

    function getHandDetails(uint id) external view returns (uint8 status, uint8 result, bool isDoubledDown, uint8, uint8) {
        BlackjackFlags memory f = _flags[id];
        return (f.status, f.result, f.isDoubledDown, 0, 0);
    }

    function getHandCards(uint id) external view returns (uint8[] memory playerCards, uint8[] memory dealerCards) {
        return (_playerCards[id], _dealerCards[id]);
    }

    function getSplitDetails(
        uint id
    )
        external
        view
        returns (uint amount2, uint payout2, uint8, uint8, bool, bool isDoubled2, uint8 result2, uint8[] memory cards)
    {
        SplitData memory s = _splits[id];
        amount2 = s.amount2;
        payout2 = s.payout2;
        isDoubled2 = s.isDoubled2;
        result2 = s.result2;
        cards = _player2Cards[id];
    }

    function nextHandId() external view returns (uint) {
        return nextId;
    }

    function getRecentHandIds(uint offset, uint limit) external view returns (uint[] memory) {
        return _getRecent(offset, limit);
    }

    function getUserHandIds(address user, uint offset, uint limit) external view returns (uint[] memory) {
        return _getUser(user, offset, limit);
    }
}
