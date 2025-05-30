// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2ResultManager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";
import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/IFreeBetsHolder.sol";
import "../interfaces/IStakingThalesBettingProxy.sol";

interface ISportsAMMV2 {
    enum TicketAction {
        Exercise,
        Cancel,
        MarkLost
    }

    struct CombinedPosition {
        uint16 typeId;
        uint8 position;
        int24 line;
    }

    struct TradeData {
        bytes32 gameId;
        uint16 sportId;
        uint16 typeId;
        uint maturity;
        uint8 status;
        int24 line;
        uint24 playerId;
        uint[] odds;
        bytes32[] merkleProof;
        uint8 position;
        CombinedPosition[][] combinedPositions;
    }

    function defaultCollateral() external view returns (IERC20);

    function manager() external view returns (ISportsAMMV2Manager);

    function resultManager() external view returns (ISportsAMMV2ResultManager);

    function safeBoxFee() external view returns (uint);

    function handleTicketResolving(address _ticket, ISportsAMMV2.TicketAction action) external;

    function riskManager() external view returns (ISportsAMMV2RiskManager);

    function freeBetsHolder() external view returns (IFreeBetsHolder);

    function stakingThalesBettingProxy() external view returns (IStakingThalesBettingProxy);

    function tradeLive(
        TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        address _recipient,
        address _referrer,
        address _collateral
    ) external returns (address _createdTicket);

    function trade(
        TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        bool _isEth
    ) external returns (address _createdTicket);

    function tradeSystemBet(
        TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedQuote,
        uint _additionalSlippage,
        address _referrer,
        address _collateral,
        bool _isEth,
        uint8 _systemBetDenominator
    ) external returns (address _createdTicket);

    function tradeSGP(
        ISportsAMMV2.TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _approvedQuote,
        address _recipient,
        address _referrer,
        address _collateral
    ) external returns (address _createdTicket);

    function rootPerGame(bytes32 game) external view returns (bytes32);

    function getRootsPerGames(bytes32[] calldata _games) external view returns (bytes32[] memory _roots);

    function paused() external view returns (bool);
}
