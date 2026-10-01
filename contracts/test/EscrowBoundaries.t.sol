// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {EscrowFixture} from "./EscrowFunding.t.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";

contract EscrowBoundariesTest is EscrowFixture {
    function testFuzz_FundingDeadlineIsExclusive(uint8 offset) public {
        offset = uint8(bound(offset, 0, 2));
        vm.warp(uint256(deadline) - 1 + offset);
        vm.prank(operatorA);
        (bool ok,) = address(vault)
            .call(
                abi.encodeCall(vault.fundEscrow, (decision, KEY, CONTEXT, KEY, address(escrow), ID, 30e6, deadline + 1))
            );
        assertEq(ok, offset == 0);
        assertEq(escrow.getAgreement(ID).funded, ok ? 30e6 : 0);
        assertEq(vault.usedIdempotencyKeys(KEY), ok);
    }

    function testFuzz_ReleaseExpiresAtApprovalOrCompletion(uint8 offset, bool atCompletion) public {
        fund();
        bytes32 role = escrow.OPERATOR_ROLE();
        uint64 expiry = atCompletion ? deadline + 100 : deadline;
        vm.startPrank(ownerA);
        escrow.grantRole(role, operatorA);
        escrow.approveMilestone(ID, 0, decision, CONTEXT, expiry);
        vm.stopPrank();
        offset = uint8(bound(offset, 0, 2));
        vm.warp(uint256(expiry) - 1 + offset);
        vm.prank(operatorA);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.releaseMilestone, (ID, 0, KEY)));
        assertEq(ok, offset == 0);
        assertEq(escrow.released(ID), ok ? 10e6 : 0);
        assertEq(usdc.balanceOf(address(escrow)), ok ? 20e6 : 30e6);
    }

    function test_ApprovalRejectsEmptyCommitmentsAndInvalidTime() public {
        fund();
        vm.startPrank(ownerA);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.approveMilestone(ID, 0, bytes32(0), CONTEXT, deadline);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.approveMilestone(ID, 0, decision, bytes32(0), deadline);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.approveMilestone(ID, 0, decision, CONTEXT, deadline + 101);
        uint64 now_ = uint64(vm.getBlockTimestamp());
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.approveMilestone(ID, 0, decision, CONTEXT, now_);
        vm.stopPrank();
    }

    function test_OperatorCannotAcquireApprovalOrAdminAuthority() public {
        bytes32 operatorRole = escrow.OPERATOR_ROLE();
        bytes32 approverRole = escrow.APPROVER_ROLE();
        vm.startPrank(ownerA);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.grantRole(operatorRole, ownerA);
        escrow.grantRole(operatorRole, operatorA);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.grantRole(approverRole, operatorA);
        escrow.beginDefaultAdminTransfer(operatorA);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(operatorA);
        vm.expectRevert(MilestoneEscrow.InvalidAuthorization.selector);
        escrow.acceptDefaultAdminTransfer();
        assertEq(escrow.owner(), ownerA);
    }
}
