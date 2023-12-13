// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// internal
import "../utils/OwnedWithInit.sol";
import "./SportsAMMV2.sol";

contract Ticket is OwnedWithInit {
    struct GameData {
        bytes32 gameId;
        uint sportId;
        uint typeId;
        uint playerPropsTypeId;
        uint maturityDate;
        uint status;
        uint line;
        uint playerId;
        uint position;
        uint odd;
    }

    SportsAMMV2 public sportsAMM;
    address public ticketOwner;

    // uint public expiry;
    uint public buyInAmount;
    uint public payout;
    uint public totalQuote;
    uint public numOfGames;

    bool public resolved;
    bool public paused;
    bool public parlayAlreadyLost;
    bool public initialized;

    mapping(uint => GameData) public games;

    // mapping(address => uint) private _gameIndex;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        GameData[] calldata _parameters,
        uint _buyInAmount,
        uint _payout,
        uint _totalQuote,
        address _sportsAMM,
        address _ticketOwner
    ) external {
        require(!initialized, "Ticket already initialized");
        initialized = true;
        initOwner(msg.sender);
        sportsAMM = SportsAMMV2(_sportsAMM);
        numOfGames = _parameters.length;
        for (uint i = 0; i < numOfGames; i++) {
            games[i] = _parameters[i];
        }
        buyInAmount = _buyInAmount;
        payout = _payout;
        totalQuote = _totalQuote;
        ticketOwner = _ticketOwner;
    }

    //===================== VIEWS ===========================

    // function isParlayLost() public view returns (bool) {
    //     bool marketWinning;
    //     bool marketResolved;
    //     bool hasPendingWinningMarkets;
    //     for (uint i = 0; i < numOfSportMarkets; i++) {
    //         (marketWinning, marketResolved) = _isWinningPosition(sportMarket[i].sportAddress, sportMarket[i].position);
    //         if (marketResolved && !marketWinning) {
    //             return true;
    //         }
    //     }
    //     return false;
    // }

    // function areAllPositionsResolved() public view returns (bool) {
    //     for (uint i = 0; i < numOfSportMarkets; i++) {
    //         if (!ISportPositionalMarket(sportMarket[i].sportAddress).resolved()) {
    //             return false;
    //         }
    //     }
    //     return true;
    // }

    // function isUserTheWinner() external view returns (bool hasUserWon) {
    //     if (areAllPositionsResolved()) {
    //         hasUserWon = !isParlayLost();
    //     }
    // }

    // function phase() public view returns (Phase) {
    //     if (resolved) {
    //         if (resolved && expiry < block.timestamp) {
    //             return Phase.Expiry;
    //         } else {
    //             return Phase.Maturity;
    //         }
    //     } else {
    //         return Phase.Trading;
    //     }
    // }

    // //exercisedOrExercisableMarkets left for legacy support
    // function isParlayExercisable() public view returns (bool isExercisable, bool[] memory exercisedOrExercisableMarkets) {
    //     isExercisable = !resolved && (areAllPositionsResolved() || isParlayLost());
    // }

    //============================== UPDATE PARAMETERS ===========================

    function setPaused(bool _paused) external onlyAMM {
        require(paused != _paused, "State not changed");
        paused = _paused;
        emit PauseUpdated(_paused);
    }

    //============================== EXERCISE ===================================

    // function exerciseWiningSportMarkets() external onlyAMM {
    //     require(!paused, "Market paused");
    //     (bool isExercisable, ) = isParlayExercisable();
    //     require(isExercisable, "Parlay not exercisable yet");
    //     uint totalSUSDamount = parlayMarketsAMM.sUSD().balanceOf(address(this));
    //     if (isParlayLost()) {
    //         if (totalSUSDamount > 0) {
    //             parlayMarketsAMM.sUSD().transfer(address(parlayMarketsAMM), totalSUSDamount);
    //         }
    //     } else {
    //         uint finalPayout = parlayMarketsAMM.sUSD().balanceOf(address(this));
    //         for (uint i = 0; i < numOfSportMarkets; i++) {
    //             address _sportMarket = sportMarket[i].sportAddress;
    //             ISportPositionalMarket currentSportMarket = ISportPositionalMarket(_sportMarket);
    //             uint result = uint(currentSportMarket.result());
    //             if (result == 0) {
    //                 finalPayout = (finalPayout * sportMarket[i].odd) / ONE;
    //             }
    //         }
    //         parlayMarketsAMM.sUSD().transfer(address(parlayOwner), finalPayout);
    //         parlayMarketsAMM.sUSD().transfer(address(parlayMarketsAMM), parlayMarketsAMM.sUSD().balanceOf(address(this)));
    //     }

    //     _resolve(!isParlayLost());
    // }

    //============================== INTERNAL FUNCTIONS ===================================

    function _resolve(bool _userWon) internal {
        parlayAlreadyLost = !_userWon;
        resolved = true;
        // parlayMarketsAMM.triggerResolvedEvent(parlayOwner, _userWon);
        emit Resolved(_userWon);
    }

    // function _isWinningPosition(
    //     address _sportMarket,
    //     uint _userPosition
    // ) internal view returns (bool isWinning, bool isResolved) {
    //     ISportPositionalMarket currentSportMarket = ISportPositionalMarket(_sportMarket);
    //     isResolved = currentSportMarket.resolved();
    //     if (
    //         isResolved &&
    //         (uint(currentSportMarket.result()) == (_userPosition + 1) ||
    //             currentSportMarket.result() == ISportPositionalMarket.Side.Cancelled)
    //     ) {
    //         isWinning = true;
    //     }
    // }

    //============================== ON EXPIRY FUNCTIONS ===================================

    // function withdrawCollateral(address recipient) external onlyAMM {
    //     parlayMarketsAMM.sUSD().transfer(recipient, parlayMarketsAMM.sUSD().balanceOf(address(this)));
    // }

    // function expire(address payable beneficiary) external onlyAMM {
    //     require(phase() == Phase.Expiry, "Ticket Expired");
    //     require(!resolved, "Can't expire resolved parlay.");
    //     emit Expired(beneficiary);
    //     _selfDestruct(beneficiary);
    // }

    // function _selfDestruct(address payable beneficiary) internal {
    //     uint balance = parlayMarketsAMM.sUSD().balanceOf(address(this));
    //     if (balance != 0) {
    //         parlayMarketsAMM.sUSD().transfer(beneficiary, balance);
    //     }

    //     // Destroy the option tokens before destroying the market itself.
    //     // selfdestruct(beneficiary);
    // }

    modifier onlyAMM() {
        require(msg.sender == address(sportsAMM), "Only the AMM may perform these methods");
        _;
    }

    event Resolved(bool isUserTheWinner);
    // event Expired(address beneficiary);
    event PauseUpdated(bool _paused);
}
