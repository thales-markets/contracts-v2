// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISportsAMMV2RiskManager {
    function calculateCapToBeUsed(
        bytes32 _gameId,
        uint16 _sportId,
        uint16 _childId,
        uint16 _playerPropsId,
        uint16 _playerId,
        uint _maturity
    ) external view returns (uint cap);
}
