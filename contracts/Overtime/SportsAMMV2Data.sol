// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../utils/proxy/ProxyOwned.sol";
import "../utils/proxy/ProxyPausable.sol";
import "../interfaces/ISportsAMMV2.sol";

contract SportsAMMV2Data is Initializable, ProxyOwned, ProxyPausable {
    ISportsAMMV2 public sportsAMM;

    struct SportsAMMParameters {
        uint minBuyInAmount;
        uint maxTicketSize;
        uint maxSupportedAmount;
        uint maxSupportedOdds;
        uint safeBoxFee;
    }

    function initialize(address _owner, address _sportsAMM) external initializer {
        setOwner(_owner);
        sportsAMM = ISportsAMMV2(_sportsAMM);
    }

    function getSportsAMMParameters() external view returns (SportsAMMParameters memory) {
        return
            SportsAMMParameters(
                sportsAMM.minBuyInAmount(),
                sportsAMM.maxTicketSize(),
                sportsAMM.maxSupportedAmount(),
                sportsAMM.maxSupportedOdds(),
                sportsAMM.safeBoxFee()
            );
    }

    function setSportsAMM(ISportsAMMV2 _sportsAMM) external onlyOwner {
        sportsAMM = _sportsAMM;
        emit SportAMMChanged(address(_sportsAMM));
    }

    event SportAMMChanged(address sportsAMM);
}
