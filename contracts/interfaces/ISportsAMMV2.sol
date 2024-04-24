// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/ISportsAMMV2Manager.sol";
import "../interfaces/ISportsAMMV2ResultManager.sol";
import "../interfaces/ISportsAMMV2RiskManager.sol";
import "../interfaces/ISportsAMMV2Manager.sol";

interface ISportsAMMV2 {
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
        uint16 playerId;
        uint[] odds;
        bytes32[] merkleProof;
        uint8 position;
        CombinedPosition[][] combinedPositions;
    }

    struct TradeParams {
        uint _buyInAmount;
        uint _expectedPayout;
        uint _additionalSlippage;
        address _differentRecipient;
        address _collateral;
        address _collateralPool;
        uint _collateralPriceInUSD;
    }

    function defaultCollateral() external view returns (IERC20);

    function manager() external view returns (ISportsAMMV2Manager);

    function resultManager() external view returns (ISportsAMMV2ResultManager);

    function safeBoxFee() external view returns (uint);

    function exerciseTicket(address _ticket) external;

    function riskManager() external view returns (ISportsAMMV2RiskManager);

    function tradeLive(
        TradeData[] calldata _tradeData,
        address _requester,
        uint _buyInAmount,
        uint _expectedPayout,
        address _differentRecipient,
        address _referrer,
        address _collateral
    ) external returns (address _createdTicket);

    function trade(
        TradeData[] calldata _tradeData,
        uint _buyInAmount,
        uint _expectedPayout,
        uint _additionalSlippage,
        address _differentRecipient,
        address _referrer,
        address _collateral,
        bool _isEth
    ) external returns (address _createdTicket);
}
