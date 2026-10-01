// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {EscrowFixture} from "./EscrowFunding.t.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract EscrowLifecycleTest is EscrowFixture {
    function setUp() public override {
        super.setUp();
        fund();
        bytes32 role = escrow.OPERATOR_ROLE();
        vm.prank(ownerA);
        escrow.grantRole(role, operatorA);
    }

    function accept(uint32 index) internal {
        vm.prank(ownerA);
        escrow.approveMilestone(ID, index, decision, CONTEXT, deadline + 100);
    }

    function release(uint32 index) internal {
        vm.prank(operatorA);
        escrow.releaseMilestone(ID, index, bytes32(uint256(index) + 1));
    }

    function test_OrderingExactReleaseAndReplay() public {
        accept(1);
        vm.expectRevert(MilestoneEscrow.InvalidMilestone.selector);
        release(1);
        accept(0);
        release(0);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(0);
        release(1);
        assertEq(escrow.released(ID), 30e6);
        assertEq(usdc.balanceOf(ownerB), 10_030e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(vault.dailySpent(vm.getBlockTimestamp() / 1 days), 30e6);
    }

    function test_CancelRefundPreservesDisputeHoldAndConservesFunds() public {
        vm.prank(ownerB);
        escrow.disputeMilestone(ID, 1, CONTEXT);
        vm.prank(ownerA);
        escrow.cancelAgreement(ID, CONTEXT);
        vm.prank(operatorA);
        escrow.refundUnreleased(ID, keccak256("refund-1"));
        assertEq(escrow.refunded(ID), 10e6);
        assertEq(usdc.balanceOf(address(escrow)), 20e6);
        vm.prank(ownerA);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.resolveMilestone(ID, 1, true);
        vm.prank(ownerA);
        escrow.resolveMilestone(ID, 1, false);
        vm.prank(operatorA);
        escrow.refundUnreleased(ID, keccak256("refund-2"));
        assertEq(escrow.refunded(ID) + escrow.released(ID) + usdc.balanceOf(address(escrow)), 30e6);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        vm.prank(operatorA);
        vm.expectRevert(MilestoneEscrow.Replay.selector);
        escrow.refundUnreleased(ID, keccak256("refund-2"));
    }

    function test_DisputeResolutionAndResubmissionRequireFreshAcceptance() public {
        accept(0);
        vm.prank(ownerA);
        escrow.invalidateMilestoneApproval(ID, 0);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(0);
        accept(0);
        vm.prank(ownerB);
        escrow.disputeMilestone(ID, 0, CONTEXT);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(0);
        vm.prank(ownerA);
        escrow.resolveMilestone(ID, 0, true);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(0);
        accept(0);
        release(0);
    }

    function test_RoleSeparationAndRevokedApprover() public {
        bytes32 role = escrow.APPROVER_ROLE();
        vm.prank(operatorA);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, operatorA, role)
        );
        escrow.approveMilestone(ID, 0, decision, CONTEXT, deadline);
        vm.prank(ownerA);
        escrow.grantRole(role, ownerB);
        vm.prank(ownerB);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.approveMilestone(ID, 0, decision, CONTEXT, deadline);
        accept(0);
        vm.prank(ownerA);
        escrow.revokeRole(role, ownerA);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(0);
    }

    function test_ExpiryPauseAndTransferFailureCannotConsumeAllocation() public {
        accept(0);
        vm.prank(ownerA);
        escrow.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        release(0);
        vm.prank(ownerA);
        escrow.unpause();
        usdc.setFailure(MockUSDC.Failure.Revert);
        vm.expectRevert(MockUSDC.TransferFailed.selector);
        release(0);
        assertEq(escrow.released(ID), 0);
        assertFalse(escrow.usedIdempotencyKeys(bytes32(uint256(1))));
        usdc.setFailure(MockUSDC.Failure.None);
        vm.warp(deadline + 100);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(0);
    }

    function test_RefundFailureRollsBackAndNeverReclaimsReleasedMilestone() public {
        accept(0);
        release(0);
        vm.prank(ownerA);
        escrow.cancelAgreement(ID, CONTEXT);
        usdc.setFailure(MockUSDC.Failure.Revert);
        vm.prank(operatorA);
        vm.expectRevert(MockUSDC.TransferFailed.selector);
        escrow.refundUnreleased(ID, CONTEXT);
        assertEq(escrow.refunded(ID), 0);
        assertFalse(escrow.usedIdempotencyKeys(CONTEXT));
        usdc.setFailure(MockUSDC.Failure.None);
        vm.prank(operatorA);
        escrow.refundUnreleased(ID, CONTEXT);
        assertEq(escrow.released(ID), 10e6);
        assertEq(escrow.refunded(ID), 20e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_AcceptanceCannotAuthorizeAnotherAllocationOrOutliveExpiry() public {
        vm.prank(ownerA);
        escrow.approveMilestone(ID, 0, decision, CONTEXT, deadline);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(1);
        vm.prank(operatorA);
        vm.expectRevert(MilestoneEscrow.InvalidMilestone.selector);
        escrow.releaseMilestone(keccak256("other-agreement"), 0, CONTEXT);
        vm.warp(deadline);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(0);
        assertEq(escrow.released(ID), 0);
        assertEq(usdc.balanceOf(address(escrow)), 30e6);
    }

    function test_AgreementPauseBlocksReleaseAndRefundUntilAdminResumes() public {
        accept(0);
        vm.prank(ownerA);
        escrow.setAgreementPaused(ID, true);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        release(0);
        vm.prank(ownerA);
        escrow.cancelAgreement(ID, CONTEXT);
        vm.prank(operatorA);
        vm.expectRevert(MilestoneEscrow.InvalidAgreement.selector);
        escrow.refundUnreleased(ID, CONTEXT);
        vm.prank(ownerA);
        escrow.setAgreementPaused(ID, false);
        vm.prank(operatorA);
        escrow.refundUnreleased(ID, CONTEXT);
        assertEq(escrow.refunded(ID), 30e6);
    }
}
