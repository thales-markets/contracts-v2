// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../interfaces/ISportsAMMV2RiskManager.sol";
import "../../interfaces/ISportsAMMV2.sol";

contract MockRiskManager is ISportsAMMV2RiskManager {
    function minBuyInAmount() external pure override returns (uint) {
        return 1 ether;
    }

    function maxTicketSize() external pure override returns (uint) {
        return 1000 ether;
    }

    function maxSupportedAmount() external pure override returns (uint) {
        return 10000 ether;
    }

    function maxSupportedOdds() external pure override returns (uint) {
        // 0.005 * 1e18 = 5e15
        return 5000000000000000;
    }

    function maxAllowedSystemCombinations() external pure override returns (uint) {
        return 10;
    }

    function expiryDuration() external pure override returns (uint) {
        return 3600;
    }

    function liveTradingPerSportAndTypeEnabled(uint, uint) external pure override returns (bool) {
        return true;
    }

    function calculateCapToBeUsed(bytes32, uint16, uint16, uint24, int24, uint, bool) external pure override returns (uint) {
        return 100 ether;
    }

    function checkRisks(
        ISportsAMMV2.TradeData[] memory _tradeData,
        uint,
        bool,
        uint8
    ) external pure override returns (RiskStatus, bool[] memory) {
        bool[] memory liquidityFlags = new bool[](_tradeData.length);
        for (uint i = 0; i < _tradeData.length; i++) {
            require(_tradeData[i].position < _tradeData[i].odds.length, "Invalid position");
            require(_tradeData[i].odds[_tradeData[i].position] != 0, "Invalid odds");
            liquidityFlags[i] = false;
        }
        return (RiskStatus.NoRisk, liquidityFlags);
    }

    function checkLimits(uint, uint, uint, uint, uint, uint) external pure override {
        // No-op
    }

    function spentOnGame(bytes32) external pure override returns (uint) {
        return 0;
    }

    function riskPerMarketTypeAndPosition(bytes32, uint, uint, uint) external pure override returns (int) {
        return 0;
    }

    function checkAndUpdateRisks(ISportsAMMV2.TradeData[] memory, uint, uint, bool, uint8, bool) external pure override {
        // No-op
    }

    function verifyMerkleTree(ISportsAMMV2.TradeData memory, bytes32) external pure override {
        // No-op
    }

    function batchVerifyMerkleTree(ISportsAMMV2.TradeData[] memory, bytes32[] memory) external pure override {
        // No-op
    }

    function isSportIdFuture(uint16) external pure override returns (bool) {
        return false;
    }

    function sgpOnSportIdEnabled(uint16) external pure override returns (bool) {
        return true;
    }

    function getMaxSystemBetPayout(
        ISportsAMMV2.TradeData[] memory,
        uint8,
        uint,
        uint
    ) external pure override returns (uint, uint) {
        return (100 ether, 10 ether);
    }

    function generateCombinations(uint8 n, uint8 k) public pure returns (uint8[][] memory) {
        require(k > 1 && k < n, "BadRangeForK");

        uint combinationsCount = 1;
        for (uint8 i = 0; i < k; ++i) {
            combinationsCount = (combinationsCount * (n - i)) / (i + 1);
        }

        uint8[][] memory combinations = new uint8[][](combinationsCount);

        uint8[] memory indices = new uint8[](k);
        for (uint8 i = 0; i < k; ++i) {
            indices[i] = i;
        }

        uint index = 0;

        while (true) {
            uint8[] memory combination = new uint8[](k);
            for (uint8 i = 0; i < k; ++i) {
                combination[i] = indices[i];
            }
            combinations[index] = combination;
            index++;

            bool done = true;
            for (uint8 i = k; i > 0; i--) {
                if (indices[i - 1] < n - (k - (i - 1))) {
                    indices[i - 1]++;
                    for (uint8 j = i; j < k; j++) {
                        indices[j] = indices[j - 1] + 1;
                    }
                    done = false;
                    break;
                }
            }

            if (done) {
                break;
            }
        }

        return combinations;
    }
}
