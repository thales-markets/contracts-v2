// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../interfaces/ISportsAMMV2.sol";
import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "../../interfaces/ISportsAMMV2LiquidityPool.sol";
import "@thales-dao/contracts/contracts/interfaces/IMultiCollateralOnOffRamp.sol";
import "@thales-dao/contracts/contracts/interfaces/IReferrals.sol";

contract SportsAMMV2Utils {
    uint private constant ONE = 1e18;

    error InvalidPosition();
    error ZeroAmount();
    error IllegalInputAmounts();

    struct TradeProcessingResult {
        uint _totalQuote;
        uint _payout;
        uint _fees;
        uint _payoutWithFees;
        uint _expectedPayout;
    }

    struct CalculateTradeParams {
        uint _buyInAmount;
        uint _expectedPayout;
        bool _isLive;
        bool _isSGP;
        uint _addedPayoutPercentage;
        uint _safeBoxFee;
    }

    struct TradeDataQuoteInternal {
        uint _buyInAmount;
        bool _shouldCheckRisks;
        uint _buyInAmountInDefaultCollateral;
        bool _isLive;
        bool _isSGP;
        uint _approvedQuote;
    }

    struct TradeQuoteParams {
        ISportsAMMV2RiskManager _riskManager;
        ISportsAMMV2 _amm;
        uint _addedPayoutPercentage;
        uint _safeBoxFee;
    }

    struct CollateralParams {
        address _defaultCollateral;
        uint _defaultCollateralDecimals;
        address _liquidityPool;
        IMultiCollateralOnOffRamp _multiCollateralOnOffRamp;
    }

    struct TradeQuoteCommonParams {
        ISportsAMMV2RiskManager _riskManager;
        ISportsAMMV2 _amm;
        uint _addedPayoutPercentage;
        uint _safeBoxFee;
        CollateralParams _collateralParams;
    }

    function tradeQuoteCommon(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint _buyInAmount,
        address _collateral,
        bool _isLive,
        uint8 _systemBetDenominator,
        TradeQuoteCommonParams memory _params
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
        uint useAmount;
        (useAmount, buyInAmountInDefaultCollateral) = _resolveCollateral(
            _buyInAmount,
            _collateral,
            _params._collateralParams
        );

        TradeQuoteParams memory qp = TradeQuoteParams(
            _params._riskManager,
            _params._amm,
            _params._addedPayoutPercentage,
            _params._safeBoxFee
        );
        (totalQuote, payout, fees, amountsToBuy, riskStatus) = _tradeQuote(
            _tradeData,
            TradeDataQuoteInternal(useAmount, true, buyInAmountInDefaultCollateral, _isLive, false, 0),
            _systemBetDenominator,
            qp
        );
    }

    function tradeQuote(
        ISportsAMMV2.TradeData[] memory _tradeData,
        TradeDataQuoteInternal memory _tradeDataQuoteInternal,
        uint8 _systemBetDenominator,
        TradeQuoteParams memory _params
    )
        external
        view
        returns (
            uint totalQuote,
            uint payout,
            uint fees,
            uint[] memory amountsToBuy,
            ISportsAMMV2RiskManager.RiskStatus riskStatus
        )
    {
        return _tradeQuote(_tradeData, _tradeDataQuoteInternal, _systemBetDenominator, _params);
    }

    function calculateTradeQuote(
        ISportsAMMV2.TradeData[] memory _tradeData,
        CalculateTradeParams memory _calc,
        uint8 _systemBetDenominator,
        TradeQuoteParams memory _params
    ) external view returns (TradeProcessingResult memory result) {
        if (!_calc._isLive) {
            (result._totalQuote, result._payout, result._fees, , ) = _tradeQuote(
                _tradeData,
                TradeDataQuoteInternal(
                    _calc._buyInAmount,
                    false,
                    0,
                    _calc._isLive,
                    _calc._isSGP,
                    _divWithDecimals(_calc._buyInAmount, _calc._expectedPayout)
                ),
                _systemBetDenominator,
                _params
            );
            result._expectedPayout = _calc._expectedPayout;
        } else {
            result = _calculateLiveQuote(_tradeData, _calc, _params);
        }

        result._payoutWithFees = result._payout + result._fees;
    }

    function checkLimitsWithTransform(
        ISportsAMMV2RiskManager _riskManager,
        uint _buyInAmount,
        uint _totalQuote,
        uint _payout,
        uint _expectedPayout,
        uint _additionalSlippage,
        uint _ticketSize,
        uint _collateralPriceInUSD,
        address _collateral,
        uint _defaultCollateralDecimals
    ) external view returns (uint buyInAmountUSD, uint payoutUSD) {
        buyInAmountUSD = _buyInAmount;
        payoutUSD = _payout;
        if (_collateralPriceInUSD > 0) {
            uint collateralDecimals = ISportsAMMV2Manager(_collateral).decimals();
            buyInAmountUSD = _transformToUSD(
                _buyInAmount,
                _collateralPriceInUSD,
                collateralDecimals,
                _defaultCollateralDecimals
            );
            payoutUSD = _transformToUSD(_payout, _collateralPriceInUSD, collateralDecimals, _defaultCollateralDecimals);
            _expectedPayout = _transformToUSD(
                _expectedPayout,
                _collateralPriceInUSD,
                collateralDecimals,
                _defaultCollateralDecimals
            );
        }
        _riskManager.checkLimits(buyInAmountUSD, _totalQuote, payoutUSD, _expectedPayout, _additionalSlippage, _ticketSize);
    }

    function _calculateLiveQuote(
        ISportsAMMV2.TradeData[] memory _tradeData,
        CalculateTradeParams memory _calc,
        TradeQuoteParams memory _params
    ) internal view returns (TradeProcessingResult memory result) {
        uint numOfMarkets = _tradeData.length;
        uint maxSupportedOdds = _params._riskManager.maxSupportedOdds();

        if (numOfMarkets == 1) {
            uint legOdd = _tradeData[0].odds[_tradeData[0].position];
            uint boosted = _applyBonusToOdd(legOdd, _calc._addedPayoutPercentage);
            if (boosted < maxSupportedOdds) boosted = maxSupportedOdds;
            result._totalQuote = boosted;
        } else {
            result._totalQuote = _calculateLiveParlay(_tradeData, _calc, maxSupportedOdds);
        }

        result._payout = _divWithDecimals(_calc._buyInAmount, result._totalQuote);
        result._fees = (_calc._buyInAmount * _params._safeBoxFee) / ONE;
        result._expectedPayout = result._payout;
    }

    function _calculateLiveParlay(
        ISportsAMMV2.TradeData[] memory _tradeData,
        CalculateTradeParams memory _calc,
        uint _minImplied
    ) internal pure returns (uint totalQuote) {
        uint numOfMarkets = _tradeData.length;
        uint baseQuote = 0;
        uint boostedQuote = 0;

        uint approvedBaseQuote = _calc._expectedPayout == 0
            ? 0
            : _divWithDecimals(_calc._buyInAmount, _calc._expectedPayout);

        for (uint i = 0; i < numOfMarkets; ++i) {
            ISportsAMMV2.TradeData memory td = _tradeData[i];
            if (td.odds.length <= td.position) revert InvalidPosition();
            uint legOdd = td.odds[td.position];
            if (legOdd == 0) revert ZeroAmount();

            baseQuote = (baseQuote == 0) ? legOdd : _mulWithDecimals(baseQuote, legOdd);

            uint boostedLeg = _applyBonusToOdd(legOdd, _calc._addedPayoutPercentage);
            boostedQuote = (boostedQuote == 0) ? boostedLeg : _mulWithDecimals(boostedQuote, boostedLeg);
        }

        uint relTol = 1e12; // 1 ppm
        if (approvedBaseQuote == 0) revert IllegalInputAmounts();

        if (boostedQuote < _minImplied) {
            uint diffClamp = _absDiff(_minImplied, approvedBaseQuote);
            if ((diffClamp * ONE) / approvedBaseQuote > relTol) revert IllegalInputAmounts();
        } else {
            uint diffBase = _absDiff(baseQuote, approvedBaseQuote);
            if ((diffBase * ONE) / approvedBaseQuote > relTol) revert IllegalInputAmounts();
        }

        totalQuote = boostedQuote;
        if (totalQuote < _minImplied) totalQuote = _minImplied;
    }

    function _resolveCollateral(
        uint _buyInAmount,
        address _collateral,
        CollateralParams memory _cp
    ) internal view returns (uint useAmount, uint buyInAmountInDefaultCollateral) {
        useAmount = _buyInAmount;
        buyInAmountInDefaultCollateral = _buyInAmount;

        if (_collateral != address(0) && _collateral != _cp._defaultCollateral) {
            if (_cp._liquidityPool == address(0)) {
                buyInAmountInDefaultCollateral = _cp._multiCollateralOnOffRamp.getMinimumReceived(_collateral, _buyInAmount);
                useAmount = buyInAmountInDefaultCollateral;
            } else {
                uint collateralPrice = ISportsAMMV2LiquidityPool(_cp._liquidityPool).getCollateralPrice();
                uint collateralDecimals = ISportsAMMV2Manager(_collateral).decimals();
                buyInAmountInDefaultCollateral = _transformToUSD(
                    _buyInAmount,
                    collateralPrice,
                    collateralDecimals,
                    _cp._defaultCollateralDecimals
                );
            }
        }

        if (useAmount == 0) revert ZeroAmount();
    }

    function _tradeQuote(
        ISportsAMMV2.TradeData[] memory _tradeData,
        TradeDataQuoteInternal memory _q,
        uint8 _systemBetDenominator,
        TradeQuoteParams memory _p
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
        uint maxSupportedOdds = _p._riskManager.maxSupportedOdds();
        bool isSystemBet = _systemBetDenominator > 1;

        for (uint i; i < numOfMarkets; ++i) {
            ISportsAMMV2.TradeData memory marketTradeData = _tradeData[i];

            _p._riskManager.verifyMerkleTree(marketTradeData, _p._amm.rootPerGame(marketTradeData.gameId));

            if (marketTradeData.odds.length <= marketTradeData.position) revert InvalidPosition();

            uint marketOdds = marketTradeData.odds[marketTradeData.position];
            marketOdds =
                (marketOdds * ONE) /
                ((ONE + _p._addedPayoutPercentage) - _mulWithDecimals(_p._addedPayoutPercentage, marketOdds));

            amountsToBuy[i] = _divWithDecimals(_q._buyInAmount, marketOdds) - _q._buyInAmount;
            if (isSystemBet) {
                amountsToBuy[i] = (amountsToBuy[i] * ONE * _systemBetDenominator) / (numOfMarkets * ONE);
            }
            totalQuote = totalQuote == 0 ? marketOdds : _mulWithDecimals(totalQuote, marketOdds);
        }
        if (totalQuote != 0) {
            if (isSystemBet) {
                (payout, totalQuote) = _p._riskManager.getMaxSystemBetPayout(
                    _tradeData,
                    _systemBetDenominator,
                    _q._buyInAmount,
                    _p._addedPayoutPercentage
                );
            } else {
                if (_q._isSGP) {
                    totalQuote = _q._approvedQuote;
                    totalQuote =
                        (totalQuote * ONE) /
                        ((ONE + _p._addedPayoutPercentage) - _mulWithDecimals(_p._addedPayoutPercentage, totalQuote));
                }
                payout = _divWithDecimals(_q._buyInAmount, totalQuote);
            }
            if (totalQuote < maxSupportedOdds) {
                totalQuote = maxSupportedOdds;
                payout = _divWithDecimals(_q._buyInAmount, totalQuote);
            }

            fees = (_q._buyInAmount * _p._safeBoxFee) / ONE;

            if (_q._shouldCheckRisks) {
                bool[] memory isMarketOutOfLiquidity;
                (riskStatus, isMarketOutOfLiquidity) = _p._riskManager.checkRisks(
                    _tradeData,
                    _q._buyInAmountInDefaultCollateral,
                    _q._isLive,
                    _systemBetDenominator
                );

                unchecked {
                    for (uint i; i < numOfMarkets; ++i) {
                        if (isMarketOutOfLiquidity[i]) amountsToBuy[i] = 0;
                    }
                }

                if (riskStatus != ISportsAMMV2RiskManager.RiskStatus.NoRisk) {
                    totalQuote = payout = 0;
                }
            }
        }
    }

    function _transformToUSD(
        uint _amountInCollateral,
        uint _collateralPriceInUSD,
        uint _collateralDecimals,
        uint _defaultCollateralDecimals
    ) internal pure returns (uint amountInUSD) {
        amountInUSD = _mulWithDecimals(_amountInCollateral, _collateralPriceInUSD);
        if (_collateralDecimals < _defaultCollateralDecimals) {
            amountInUSD = amountInUSD * 10 ** (_defaultCollateralDecimals - _collateralDecimals);
        } else if (_collateralDecimals > _defaultCollateralDecimals) {
            amountInUSD = amountInUSD / 10 ** (_collateralDecimals - _defaultCollateralDecimals);
        }
    }

    struct FeeResult {
        uint fees;
        uint referrerShare;
        uint safeBoxAmount;
        address referrer;
        address safeBoxTarget;
    }

    function calculateFees(
        uint _buyInAmount,
        address _ticketOwner,
        uint _ammBalance,
        uint _safeBoxFee,
        address _freeBetsHolder,
        address _safeBox,
        address _safeBoxPerCollateral,
        IReferrals _referrals
    ) external view returns (FeeResult memory result) {
        result.referrer = _referrals.sportReferrals(_ticketOwner);
        uint referrerShare;

        if (result.referrer != address(0) && _ticketOwner != _freeBetsHolder) {
            uint referrerFeeByTier = _referrals.getReferrerFee(result.referrer);
            if (referrerFeeByTier > 0) {
                referrerShare = _mulWithDecimals(_buyInAmount, referrerFeeByTier);
                if (_ammBalance >= referrerShare) {
                    result.referrerShare = referrerShare;
                    _ammBalance -= referrerShare;
                }
            }
        }

        result.fees = (_buyInAmount * _safeBoxFee) / ONE;
        if (result.fees > referrerShare) {
            uint safeBoxAmount = result.fees - referrerShare;
            if (_ammBalance >= safeBoxAmount) {
                result.safeBoxAmount = safeBoxAmount;
                result.safeBoxTarget = _safeBoxPerCollateral != address(0) ? _safeBoxPerCollateral : _safeBox;
            }
        }
    }

    function divWithDecimals(uint _dividend, uint _divisor) external pure returns (uint) {
        return _divWithDecimals(_dividend, _divisor);
    }

    function mulWithDecimals(uint _firstMul, uint _secondMul) external pure returns (uint) {
        return _mulWithDecimals(_firstMul, _secondMul);
    }

    function applyBonusToOdd(uint odd, uint addedPayoutPercentage) external pure returns (uint) {
        return _applyBonusToOdd(odd, addedPayoutPercentage);
    }

    function absDiff(uint a, uint b) external pure returns (uint) {
        return _absDiff(a, b);
    }

    function getFees(uint _buyInAmount, uint _safeBoxFee) external pure returns (uint) {
        return (_buyInAmount * _safeBoxFee) / ONE;
    }

    function _divWithDecimals(uint _dividend, uint _divisor) private pure returns (uint) {
        return (ONE * _dividend) / _divisor;
    }

    function _mulWithDecimals(uint _firstMul, uint _secondMul) private pure returns (uint) {
        return (_firstMul * _secondMul) / ONE;
    }

    function _applyBonusToOdd(uint odd, uint addedPayoutPercentage) private pure returns (uint) {
        return (odd * ONE) / ((ONE + addedPayoutPercentage) - _mulWithDecimals(addedPayoutPercentage, odd));
    }

    function _absDiff(uint a, uint b) private pure returns (uint) {
        return a >= b ? (a - b) : (b - a);
    }
}
