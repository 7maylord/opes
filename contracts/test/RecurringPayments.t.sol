// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {OrganizationFixture} from "./fixtures/OrganizationFixture.sol";
import {BusinessPolicyVault} from "../src/BusinessPolicyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract RecurringPaymentsTest is OrganizationFixture {
    BusinessPolicyVault internal vault;
    bytes32 internal constant ID = keccak256("subscription-v1");
    bytes32 internal constant CONTEXT = keccak256("evidence");
    uint64[] internal due;
    bytes32[] internal keys;
    uint64 internal end;
    uint64 internal start;

    function setUp() public override {
        super.setUp();
        vault = new BusinessPolicyVault(address(usdc), keccak256("a"), ownerA, operatorA, ownerA, ownerA);
        usdc.mint(address(vault), 100e6);
        due.push(uint64(vm.getBlockTimestamp() + 100));
        start = due[0];
        due.push(due[0] + 100);
        keys.push(keccak256("period-1"));
        keys.push(keccak256("period-2"));
        end = due[1] + 100;
        vm.startPrank(ownerA);
        vault.setLimits(10e6, 30e6, 50e6);
        vault.setVendor(ownerB, true, 40e6);
        vault.unpause();
        vm.stopPrank();
        create(ID);
    }

    function create(bytes32 id) internal {
        vm.prank(ownerA);
        vault.createRecurringMandate(id, ownerB, 20e6, due, keys, start, end, 25e6);
    }

    function hash(bytes32 id, uint32 index, uint256 amount) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                uint256(1),
                block.chainid,
                address(vault),
                keccak256("a"),
                address(usdc),
                uint8(2),
                keys[index],
                ownerB,
                amount,
                end + 1,
                bytes32(0),
                id,
                index,
                CONTEXT
            )
        );
    }

    function pay(bytes32 id, uint32 index, uint256 amount) internal {
        bytes32 decision = hash(id, index, amount);
        vm.prank(operatorA);
        vault.executeRecurringPayment(id, index, decision, keys[index], CONTEXT, amount, end + 1);
    }

    function test_DueBoundaryAndReplayAcrossVersions() public {
        vm.expectRevert(BusinessPolicyVault.CycleNotDue.selector);
        pay(ID, 0, 10e6);
        vm.warp(due[0]);
        assertEq(vault.hashRecurringPayment(ID, 0, CONTEXT, 10e6, end + 1), hash(ID, 0, 10e6));
        pay(ID, 0, 10e6);
        vm.expectRevert(BusinessPolicyVault.ObligationAlreadyPaid.selector);
        pay(ID, 0, 10e6);
        vm.prank(ownerA);
        vault.cancelRecurringMandate(ID);
        vm.expectRevert(BusinessPolicyVault.InvalidMandate.selector);
        create(keccak256("v2"));
        assertEq(vault.getRecurringMandate(ID).paid, 10e6);
    }

    function test_PauseResumeCancellationAndDirectRouteCannotBypassSchedule() public {
        bytes32 direct = vault.hashDirectPayment(keys[0], CONTEXT, ownerB, 1, end);
        vm.prank(operatorA);
        vm.expectRevert(BusinessPolicyVault.InvalidDecision.selector);
        vault.executeDirectPayment(direct, keys[0], CONTEXT, keys[0], ownerB, 1, end);
        vm.prank(ownerA);
        vault.pauseRecurringMandate(ID);
        vm.warp(due[0]);
        vm.expectRevert(BusinessPolicyVault.InvalidMandate.selector);
        pay(ID, 0, 1);
        vm.prank(ownerA);
        vault.resumeRecurringMandate(ID);
        vm.prank(ownerA);
        vault.cancelRecurringMandate(ID);
        vm.prank(ownerA);
        vm.expectRevert(BusinessPolicyVault.InvalidMandate.selector);
        vault.resumeRecurringMandate(ID);
        bytes32 next = keccak256("v2");
        create(next);
        pay(next, 0, 1);
        vm.expectRevert(BusinessPolicyVault.InvalidMandate.selector);
        pay(ID, 0, 1);
    }

    function test_CapsApprovalAndFailedTransferRollback() public {
        vm.warp(due[0]);
        vm.expectRevert(BusinessPolicyVault.LimitExceeded.selector);
        pay(ID, 0, 21e6);
        vm.expectRevert(BusinessPolicyVault.ApprovalRequired.selector);
        pay(ID, 0, 20e6);
        bytes32 decision = hash(ID, 0, 20e6);
        vm.prank(ownerA);
        vault.approveDecision(decision, end);
        usdc.setFailure(MockUSDC.Failure.Revert);
        vm.expectRevert(MockUSDC.TransferFailed.selector);
        pay(ID, 0, 20e6);
        assertEq(vault.getRecurringMandate(ID).paid, 0);
        assertFalse(vault.usedIdempotencyKeys(keys[0]));
        usdc.setFailure(MockUSDC.Failure.None);
        pay(ID, 0, 20e6);
        vm.warp(due[1]);
        vm.expectRevert(BusinessPolicyVault.LimitExceeded.selector);
        pay(ID, 1, 6e6);
        pay(ID, 1, 5e6);
        assertEq(vault.getRecurringMandate(ID).paid, 25e6);
    }

    function testFuzz_InvalidSchedulesAreRejected(uint8 fault) public {
        vm.prank(ownerA);
        vault.cancelRecurringMandate(ID);
        fault = uint8(bound(fault, 0, 6));
        if (fault == 0) due[1] = due[0];
        if (fault == 1) keys[1] = keys[0];
        if (fault == 2) keys[0] = bytes32(0);
        if (fault == 3) due[1] = end;
        if (fault == 4) keys.pop();
        if (fault == 5) delete due;
        if (fault == 6) {
            for (uint256 i; i < 23; ++i) {
                due.push(end);
            }
        }
        vm.expectRevert(BusinessPolicyVault.InvalidMandate.selector);
        create(keccak256("invalid"));
    }

    function test_SubstitutedCycleAndEndBoundaryFail() public {
        vm.warp(due[1]);
        bytes32 decision = hash(ID, 0, 1);
        vm.prank(operatorA);
        vm.expectRevert(BusinessPolicyVault.InvalidDecision.selector);
        vault.executeRecurringPayment(ID, 1, decision, keys[0], CONTEXT, 1, end + 1);
        vm.warp(end);
        vm.expectRevert(BusinessPolicyVault.CycleNotDue.selector);
        pay(ID, 0, 1);
    }

    function test_RecurringCannotBypassOwnerControlsPauseOrVendorRevocation() public {
        bytes32 role = vault.OWNER_ROLE();
        vm.prank(operatorA);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, operatorA, role)
        );
        vault.cancelRecurringMandate(ID);
        vm.warp(due[0]);
        vm.prank(ownerA);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pay(ID, 0, 1);
        vm.startPrank(ownerA);
        vault.unpause();
        vault.setVendor(ownerB, false, 0);
        vm.stopPrank();
        vm.expectRevert(BusinessPolicyVault.VendorNotAllowed.selector);
        pay(ID, 0, 1);
        assertEq(vault.getRecurringMandate(ID).paid, 0);
    }
}
