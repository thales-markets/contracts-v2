// SPDX-License-Identifier: MIT

pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

abstract contract ERC677 is ERC20 {
    constructor() {}

    function transferAndCall(address to, uint value, bytes calldata data) public virtual returns (bool success);

    event Transfer(address indexed from, address indexed to, uint value, bytes data);
}

abstract contract ERC677Receiver {
    function onTokenTransfer(address _sender, uint _value, bytes calldata _data) public virtual;
}

abstract contract ERC677Token is ERC677 {
    /**
     * @dev transfer token to a contract address with additional data if the recipient is a contact.
     * @param _to The address to transfer to.
     * @param _value The amount to be transferred.
     * @param _data The extra data to be passed to the receiving contract.
     */
    function transferAndCall(address _to, uint _value, bytes calldata _data) public override returns (bool success) {
        super.transfer(_to, _value);
        emit Transfer(msg.sender, _to, _value, _data);
        if (isContract(_to)) {
            contractFallback(_to, _value, _data);
        }
        return true;
    }

    // PRIVATE

    function contractFallback(address _to, uint _value, bytes calldata _data) private {
        ERC677Receiver receiver = ERC677Receiver(_to);
        receiver.onTokenTransfer(msg.sender, _value, _data);
    }

    function isContract(address _addr) private view returns (bool hasCode) {
        uint length;
        assembly {
            length := extcodesize(_addr)
        }
        return length > 0;
    }
}

contract OvertimePaymentToken is ERC677Token {
    string private __name = "Overtime Payment Token";
    string private __symbol = "OTP";
    uint8 private constant __decimals = 18;
    uint private constant INITIAL_TOTAL_SUPPLY = 1e7;

    constructor() ERC20(__name, __symbol) {
        _mint(msg.sender, INITIAL_TOTAL_SUPPLY * 1e18);
    }
}
