// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {OrganizationFixture} from "./fixtures/OrganizationFixture.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {BusinessPolicyVault} from "../src/BusinessPolicyVault.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract BusinessPolicyVaultTest is OrganizationFixture {
    BusinessPolicyVault internal vault;
    address internal recovery;
    address internal pauser;

    function setUp() public override {
        super.setUp();
        recovery = makeAddr("recovery-a");
        pauser = makeAddr("pauser-a");
        vault = new BusinessPolicyVault(address(usdc), keccak256("a"), ownerA, operatorA, pauser, recovery);
        usdc.mint(address(vault), 100e6);
    }

    function test_StartsWithImmutableIdentityAndNoSpendingAuthority() public view {
        assertEq(address(vault.token()), address(usdc));
        assertEq(vault.organizationDomain(), keccak256("a"));
        assertEq(vault.recoveryAddress(), recovery);
        assertTrue(vault.paused());
        assertEq(vault.singleMax(), 0);
        assertEq(vault.autonomousMax(), 0);
        assertEq(vault.organizationDailyMax(), 0);
        assertTrue(vault.hasRole(vault.OWNER_ROLE(), ownerA));
        assertTrue(vault.hasRole(vault.OPERATOR_ROLE(), operatorA));
    }

    function test_RejectsInvalidDeploymentBindings() public {
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        new BusinessPolicyVault(address(usdc), bytes32(0), ownerA, operatorA, pauser, recovery);
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        new BusinessPolicyVault(address(usdc), keccak256("a"), ownerA, ownerA, pauser, recovery);
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        new BusinessPolicyVault(address(usdc), keccak256("a"), ownerA, operatorA, pauser, address(0));
        vm.mockCall(address(usdc), abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        new BusinessPolicyVault(address(usdc), keccak256("a"), ownerA, operatorA, pauser, recovery);
    }

    function testFuzz_NonOwnerCannotAdministerOrRecover(address caller) public {
        vm.assume(caller != ownerA);
        bytes32 role = vault.OWNER_ROLE();
        bytes32 operatorRole = vault.OPERATOR_ROLE();
        bytes memory denied =
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, role);
        vm.startPrank(caller);
        vm.expectRevert(denied);
        vault.setLimits(1, 2, 3);
        vm.expectRevert(denied);
        vault.setVendor(ownerB, true, 1);
        vm.expectRevert(denied);
        vault.recoverUsdc(1);
        vm.expectRevert(denied);
        vault.unpause();
        vm.expectRevert(denied);
        vault.grantRole(operatorRole, caller);
        vm.stopPrank();
    }

    function test_PolicyAndEmergencyPauseBoundaries() public {
        vm.startPrank(ownerA);
        vm.expectRevert(BusinessPolicyVault.InvalidLimits.selector);
        vault.unpause();
        vm.expectRevert(BusinessPolicyVault.InvalidLimits.selector);
        vault.setLimits(3, 2, 1);
        vault.setLimits(0, 10e6, 20e6);
        vault.setVendor(ownerB, true, 5e6);
        (bool allowed, uint256 daily) = vault.vendorPolicies(ownerB);
        assertTrue(allowed);
        assertEq(daily, 5e6);
        vault.unpause();
        vm.expectRevert(Pausable.ExpectedPause.selector);
        vault.recoverUsdc(1);
        vm.stopPrank();
        vm.prank(pauser);
        vault.pause();
        assertTrue(vault.paused());
        vm.prank(ownerA);
        vault.setVendor(ownerB, false, 0);
        (allowed,) = vault.vendorPolicies(ownerB);
        assertFalse(allowed);
    }

    function test_RecoveryUsesFixedDestinationAndRejectsTokenFailure() public {
        vm.prank(ownerA);
        vm.expectRevert(BusinessPolicyVault.InvalidAmount.selector);
        vault.recoverUsdc(0);
        vm.prank(ownerA);
        vault.recoverUsdc(40e6);
        assertEq(usdc.balanceOf(recovery), 40e6);
        assertEq(usdc.balanceOf(address(vault)), 60e6);
        assertEq(usdc.balanceOf(ownerB), 10_000e6);
        usdc.setFailure(MockUSDC.Failure.ReturnFalse);
        vm.prank(ownerA);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
        vault.recoverUsdc(1);
        assertEq(usdc.balanceOf(address(vault)), 60e6);
        usdc.setFailure(MockUSDC.Failure.Revert);
        vm.prank(ownerA);
        vm.expectRevert(MockUSDC.TransferFailed.selector);
        vault.recoverUsdc(1);
    }

    function test_OwnerTransferRequiresAcceptanceAndPreservesRoleSeparation() public {
        bytes32 operatorRole = vault.OPERATOR_ROLE();
        vm.startPrank(ownerA);
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        vault.grantRole(operatorRole, ownerA);
        vault.beginDefaultAdminTransfer(operatorA);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(operatorA);
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        vault.acceptDefaultAdminTransfer();
        assertEq(vault.owner(), ownerA);
        address successor = makeAddr("successor");
        vm.prank(ownerA);
        vault.beginDefaultAdminTransfer(successor);
        assertEq(vault.owner(), ownerA);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(successor);
        vault.acceptDefaultAdminTransfer();
        assertEq(vault.owner(), successor);
        bytes32 ownerRole = vault.OWNER_ROLE();
        vm.prank(successor);
        vm.expectRevert(BusinessPolicyVault.OwnerRequired.selector);
        vault.renounceRole(ownerRole, successor);
    }
}
