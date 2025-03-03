// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITicket {
    function setPaused(bool _paused) external;
    function isSystem() external view returns (bool);
    function isSGP() external view returns (bool);
}
