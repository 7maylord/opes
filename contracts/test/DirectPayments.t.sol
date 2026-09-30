// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {OrganizationFixture} from "./fixtures/OrganizationFixture.sol";
import {BusinessPolicyVault} from "../src/BusinessPolicyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract DirectPaymentsTest is OrganizationFixture {
    BusinessPolicyVault internal vault;
    address internal recovery;
    address internal pauser;
    bytes32 internal constant CONTEXT = keccak256("verified-evidence-v1");
    uint64 internal expiry;

    function setUp() public override {
        super.setUp();
        recovery = makeAddr("recovery");
        pauser = makeAddr("pauser");
        vault = new BusinessPolicyVault(address(usdc), keccak256("a"), ownerA, operatorA, pauser, recovery);
        usdc.mint(address(vault), 100e6);
        expiry = uint64(vm.getBlockTimestamp() + 2 days);
        vm.startPrank(ownerA);
        vault.setLimits(10e6, 30e6, 50e6);
        vault.setVendor(ownerB, true, 40e6);
        vault.unpause();
        vm.stopPrank();
    }

    function expectedHash(bytes32 key, uint256 amount) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                uint256(1),
                block.chainid,
                address(vault),
                keccak256("a"),
                address(usdc),
                uint8(1),
                key,
                ownerB,
                amount,
                expiry,
                bytes32(0),
                bytes32(0),
                uint32(0),
                CONTEXT
            )
        );
    }

    function pay(bytes32 key, uint256 amount) internal {
        bytes32 hash = expectedHash(key, amount);
        vm.prank(operatorA);
        vault.executeDirectPayment(hash, key, CONTEXT, key, ownerB, amount, expiry);
    }

    function approve(bytes32 key, uint256 amount) internal returns (bytes32 hash) {
        hash = vault.hashDirectPayment(key, CONTEXT, ownerB, amount, expiry);
        vm.prank(ownerA);
        vault.approveDecision(hash, expiry);
    }

    function test_PaysAutonomouslyOnceAcrossDecisionVersions() public {
        bytes32 key = bytes32(uint256(1));
        pay(key, 10e6);
        assertEq(usdc.balanceOf(ownerB), 10_010e6);
        assertEq(vault.dailySpent(vm.getBlockTimestamp() / 1 days), 10e6);
        bytes32 changed = keccak256("corrected-evidence");
        bytes32 hash = vault.hashDirectPayment(key, changed, ownerB, 10e6, expiry);
        vm.prank(operatorA);
        vm.expectRevert(BusinessPolicyVault.ObligationAlreadyPaid.selector);
        vault.executeDirectPayment(hash, key, changed, key, ownerB, 10e6, expiry);
    }

    function test_ApprovalIsConsumedAndLimitsStillApply() public {
        bytes32 key = bytes32(uint256(1));
        vm.expectRevert(BusinessPolicyVault.ApprovalRequired.selector);
        pay(key, 30e6);
        bytes32 hash = approve(key, 30e6);
        pay(key, 30e6);
        (address approver,) = vault.approvals(hash);
        assertEq(approver, address(0));
        approve(bytes32(uint256(2)), 30e6);
        vm.expectRevert(BusinessPolicyVault.LimitExceeded.selector);
        pay(bytes32(uint256(2)), 30e6);
    }

    function testFuzz_ChangedExecutionFieldsCannotReuseHash(uint8 field) public {
        bytes32 key = bytes32(uint256(1));
        bytes32 hash = approve(key, 20e6);
        bytes32 context = CONTEXT;
        address recipient = ownerB;
        uint256 amount = 20e6;
        uint64 deadline = expiry;
        field = uint8(bound(field, 0, 5));
        if (field == 0) recipient = ownerA;
        if (field == 1) amount++;
        if (field == 2) deadline++;
        if (field == 3) context = keccak256("changed");
        if (field == 4) key = bytes32(uint256(2));
        if (field == 5) vm.chainId(block.chainid + 1);
        vm.prank(operatorA);
        vm.expectRevert(BusinessPolicyVault.InvalidDecision.selector);
        vault.executeDirectPayment(hash, key, context, key, recipient, amount, deadline);
    }

    function test_HashSchemaAndVaultDomain() public {
        bytes32 key = bytes32(uint256(1));
        bytes32 expected = keccak256(
            abi.encode(
                uint256(1),
                block.chainid,
                address(vault),
                keccak256("a"),
                address(usdc),
                uint8(1),
                key,
                ownerB,
                uint256(1),
                expiry,
                bytes32(0),
                bytes32(0),
                uint32(0),
                CONTEXT
            )
        );
        assertEq(vault.hashDirectPayment(key, CONTEXT, ownerB, 1, expiry), expected);
        BusinessPolicyVault other =
            new BusinessPolicyVault(address(usdc), keccak256("b"), ownerA, operatorA, pauser, recovery);
        assertNotEq(other.hashDirectPayment(key, CONTEXT, ownerB, 1, expiry), expected);
    }

    function test_FailedTokenTransferRollsBackApprovalReplayAndSpend() public {
        bytes32 key = bytes32(uint256(1));
        bytes32 hash = approve(key, 20e6);
        usdc.setFailure(MockUSDC.Failure.ReturnFalse);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(usdc)));
        pay(key, 20e6);
        assertFalse(vault.usedIdempotencyKeys(key));
        assertEq(vault.dailySpent(vm.getBlockTimestamp() / 1 days), 0);
        assertEq(vault.vendorDailySpent(ownerB, vm.getBlockTimestamp() / 1 days), 0);
        (address approver,) = vault.approvals(hash);
        assertEq(approver, ownerA);
        usdc.setFailure(MockUSDC.Failure.None);
        pay(key, 20e6);
    }

    function test_DailyRolloverResetsSpendNotReplay() public {
        approve(bytes32(uint256(1)), 30e6);
        pay(bytes32(uint256(1)), 30e6);
        pay(bytes32(uint256(2)), 10e6);
        vm.expectRevert(BusinessPolicyVault.LimitExceeded.selector);
        pay(bytes32(uint256(3)), 1);
        vm.warp((vm.getBlockTimestamp() / 1 days + 1) * 1 days);
        pay(bytes32(uint256(3)), 1);
        assertEq(vault.vendorDailySpent(ownerB, vm.getBlockTimestamp() / 1 days), 1);
        vm.expectRevert(BusinessPolicyVault.ObligationAlreadyPaid.selector);
        pay(bytes32(uint256(1)), 1);
    }

    function test_ApprovalExpiryAndIndependentHardCaps() public {
        bytes32 key = bytes32(uint256(1));
        bytes32 hash = expectedHash(key, 20e6);
        vm.prank(ownerA);
        vault.approveDecision(hash, uint64(vm.getBlockTimestamp() + 1));
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(BusinessPolicyVault.ApprovalRequired.selector);
        pay(key, 20e6);
        vm.prank(ownerA);
        vault.setVendor(ownerB, true, 100e6);
        approve(key, 31e6);
        vm.expectRevert(BusinessPolicyVault.LimitExceeded.selector);
        pay(key, 31e6);
        approve(key, 30e6);
        pay(key, 30e6);
        approve(bytes32(uint256(2)), 20e6);
        pay(bytes32(uint256(2)), 20e6);
        vm.expectRevert(BusinessPolicyVault.LimitExceeded.selector);
        pay(bytes32(uint256(3)), 1);
    }

    function test_ExecutionRejectsUnauthorizedPausedUnlistedExpiredAndMismatchedKeys() public {
        bytes32 key = bytes32(uint256(1));
        bytes32 hash = vault.hashDirectPayment(key, CONTEXT, ownerB, 1, expiry);
        bytes32 role = vault.OPERATOR_ROLE();
        vm.prank(ownerA);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ownerA, role));
        vault.executeDirectPayment(hash, key, CONTEXT, key, ownerB, 1, expiry);
        vm.prank(ownerA);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pay(key, 1);
        vm.startPrank(ownerA);
        vault.unpause();
        vault.setVendor(ownerB, false, 0);
        vm.stopPrank();
        vm.expectRevert(BusinessPolicyVault.VendorNotAllowed.selector);
        pay(key, 1);
        vm.prank(operatorA);
        vm.expectRevert(BusinessPolicyVault.InvalidDecision.selector);
        vault.executeDirectPayment(hash, key, CONTEXT, bytes32(uint256(2)), ownerB, 1, expiry);
        vm.warp(expiry);
        vm.expectRevert(BusinessPolicyVault.DecisionExpired.selector);
        pay(key, 1);
    }
}
