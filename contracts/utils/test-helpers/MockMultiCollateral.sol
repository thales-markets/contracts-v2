// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MockPriceFeed.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../interfaces/ISportsAMMV2Manager.sol";

contract MockMultiCollateralOnOffRamp {
    using SafeERC20 for IERC20;

    address public priceFeed;
    ISportsAMMV2Manager public manager;

    IERC20 public sUSD;
    mapping(address => bytes32) public collateralKey;
    mapping(bytes32 => address) public collateralAddress;
    mapping(address collateralFrom => mapping(address collateralTo => uint rate)) public swapRate;

    receive() external payable {}

    function setPriceFeed(address _priceFeed) external {
        priceFeed = _priceFeed;
    }

    function setPositionalManager(address _mockPositionalManager) external {
        manager = ISportsAMMV2Manager(_mockPositionalManager);
    }

    function setSUSD(address _sUSD) external {
        sUSD = IERC20(_sUSD);
    }

    function setCollateralKey(address _collateral, bytes32 _collateralKey) external {
        collateralKey[_collateral] = _collateralKey;
        collateralAddress[_collateralKey] = _collateral;
    }

    function onramp(address _collateral, uint _collateralAmount) external returns (uint convertedAmount) {
        // 1. Receive collateral amount from the sender
        // 2. Convert to the USD amount
        // 3. Send USD back to the sender
        // REQUIRED: Contract needs to hold enough USD amount to execute
        IERC20(_collateral).safeTransferFrom(msg.sender, address(this), _collateralAmount);
        convertedAmount = getMinimumReceived(_collateral, _collateralAmount);
        sUSD.safeTransfer(msg.sender, convertedAmount);
        emit OnRamp(_collateral, _collateralAmount, convertedAmount);
    }

    function onrampWithEth(uint amount) external payable returns (uint) {}

    function getMinimumReceived(address collateral, uint collateralAmount) public view returns (uint amountInUSD) {
        if (
            collateral == collateralAddress["USDC"] ||
            collateral == collateralAddress["USDC2"] ||
            collateral == collateralAddress["USDCT"]
        ) {
            amountInUSD = collateralAmount * (10 ** 12);
        } else {
            uint collateralInUSD = MockPriceFeed(priceFeed).rateForCurrency(collateralKey[collateral]);
            amountInUSD = (collateralAmount * collateralInUSD) / 1e18;
        }
        // instead of mocking needsTransformingCollateral
        // the check for decimals have been added in the mock
        // this conversion follows the defaultCollateral in SportsAMMV2
        // needsTransformingCollateral is in sync with it
        if (ISportsAMMV2Manager(address(sUSD)).decimals() == 6) {
            amountInUSD = amountInUSD / (10 ** 12);
        } else {
            amountInUSD = amountInUSD;
        }
    }

    function getMinimumNeeded(address collateral, uint amount) public view returns (uint collateralQuote) {
        // amount is buyInAmount,
        // take priceFeed from collateral and generate the collateralQuote = pricePerUSD/buyInAmount
        if (collateral == collateralAddress["USDC"]) {
            collateralQuote = amount / (10 ** 12);
        } else {
            uint collateralInUSD = MockPriceFeed(priceFeed).rateForCurrency(collateralKey[collateral]);
            collateralQuote = (amount * 1e18) / collateralInUSD;
        }
    }

    function WETH9() external view returns (address) {
        return collateralAddress["WETH"];
    }

    function offrampIntoEth(uint amount) external returns (uint offramped) {
        sUSD.safeTransferFrom(msg.sender, address(this), amount);
        offramped = _swapAmount(address(sUSD), collateralAddress["WETH"], amount);
        // (bool sent, ) = payable(msg.sender).call{value: offramped}("");
        bool sent = payable(msg.sender).send(offramped);
        require(sent, "Failed to send Ether");
    }

    function offramp(address collateralTo, uint amount) external returns (uint offramped) {
        sUSD.safeTransferFrom(msg.sender, address(this), amount);
        offramped = _swapAmount(address(sUSD), collateralTo, amount);
        IERC20(collateralTo).safeTransfer(msg.sender, offramped);
    }

    function offrampFromIntoEth(address collateralFrom, uint amount) external returns (uint offramped) {
        IERC20(collateralFrom).safeTransferFrom(msg.sender, address(this), amount);
        offramped = _swapAmount(collateralFrom, collateralAddress["WETH"], amount);
        (bool sent, ) = payable(msg.sender).call{value: offramped}("");
        // bool sent = payable(msg.sender).send(offramped);
        require(sent, "Failed to send Ether");
    }

    function offrampFrom(address collateralFrom, address collateralTo, uint amount) external returns (uint offramped) {
        IERC20(collateralFrom).safeTransferFrom(msg.sender, address(this), amount);
        offramped = _swapAmount(collateralFrom, collateralTo, amount);
        IERC20(collateralTo).safeTransfer(msg.sender, offramped);
    }

    function _swapAmount(address collateralFrom, address collateralTo, uint amount) internal view returns (uint) {
        // assumed amount is 18 decimal
        return (swapRate[collateralFrom][collateralTo] * amount) / 1e18;
    }

    function setSwapRate(address collateralFrom, address collateralTo, uint rate) external {
        swapRate[collateralFrom][collateralTo] = rate;
        swapRate[collateralTo][collateralFrom] = (1e18 * 1e18) / rate;
    }

    event OnRamp(address collateral, uint collateralAmount, uint convertedAmount);
}
