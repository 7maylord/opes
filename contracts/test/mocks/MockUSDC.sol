// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only token. Permissionless minting and failure switches must never be deployed as USDC.
contract MockUSDC is ERC20 {
    enum Failure {
        None,
        ReturnFalse,
        Revert
    }

    Failure public failure;
    error TransferFailed();

    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setFailure(Failure mode) external {
        failure = mode;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (failure == Failure.Revert) revert TransferFailed();
        if (failure == Failure.ReturnFalse) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (failure == Failure.Revert) revert TransferFailed();
        if (failure == Failure.ReturnFalse) return false;
        return super.transferFrom(from, to, amount);
    }
}
