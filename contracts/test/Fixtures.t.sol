// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {OrganizationFixture} from "./fixtures/OrganizationFixture.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract FixturesTest is OrganizationFixture {
    function testFuzz_TransferPreservesAtomicUnitsAndOtherOrganization(uint256 amount) public {
        amount = bound(amount, 1, 10_000e6);
        assertEq(usdc.decimals(), 6);
        vm.prank(ownerA);
        assertTrue(usdc.transfer(operatorA, amount));
        assertEq(usdc.balanceOf(operatorA), amount);
        assertEq(usdc.balanceOf(ownerA), 10_000e6 - amount);
        assertEq(usdc.balanceOf(ownerB), 10_000e6);
        assertEq(usdc.balanceOf(operatorB), 0);
    }

    function test_AllowanceCannotBeUsedByOtherOrganization() public {
        vm.prank(ownerA);
        usdc.approve(operatorA, 1);
        vm.prank(operatorB);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, operatorB, 0, 1));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdc.transferFrom(ownerA, operatorB, 1);
        vm.prank(operatorA);
        assertTrue(usdc.transferFrom(ownerA, operatorA, 1));
        assertEq(usdc.allowance(ownerA, operatorA), 0);
    }

    function test_FailuresPreserveFundsAndAllowance() public {
        vm.prank(ownerA);
        usdc.approve(operatorA, 1);
        usdc.setFailure(MockUSDC.Failure.ReturnFalse);
        vm.prank(ownerA);
        assertFalse(usdc.transfer(operatorA, 1));
        vm.prank(operatorA);
        assertFalse(usdc.transferFrom(ownerA, operatorA, 1));
        usdc.setFailure(MockUSDC.Failure.Revert);
        vm.prank(ownerA);
        vm.expectRevert(MockUSDC.TransferFailed.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdc.transfer(operatorA, 1);
        vm.prank(operatorA);
        vm.expectRevert(MockUSDC.TransferFailed.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdc.transferFrom(ownerA, operatorA, 1);
        assertEq(usdc.balanceOf(ownerA), 10_000e6);
        assertEq(usdc.balanceOf(operatorA), 0);
        assertEq(usdc.allowance(ownerA, operatorA), 1);
    }
}
