// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {OrganizationFixture} from "./fixtures/OrganizationFixture.sol";
import {BusinessPolicyVault} from "../src/BusinessPolicyVault.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract EscrowFundingTest is OrganizationFixture {
    BusinessPolicyVault internal vault;
    MilestoneEscrow internal escrow;
    bytes32 internal constant ID = keccak256("agreement");
    bytes32 internal constant KEY = keccak256("funding-obligation");
    bytes32 internal constant CONTEXT = keccak256("evidence");
    uint64 internal deadline;
    bytes32 internal decision;

    function setUp() public override {
        super.setUp();
        vault = new BusinessPolicyVault(address(usdc), keccak256("a"), ownerA, operatorA, ownerA, ownerA);
        escrow = new MilestoneEscrow(address(vault), ownerA);
        deadline = uint64(vm.getBlockTimestamp() + 100);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10e6;
        amounts[1] = 20e6;
        bytes32[] memory criteria = new bytes32[](2);
        criteria[0] = keccak256("design");
        criteria[1] = keccak256("delivery");
        vm.startPrank(ownerA);
        vault.setLimits(30e6, 50e6, 100e6);
        vault.setVendor(ownerB, true, 50e6);
        vault.setEscrow(address(escrow), true);
        vault.unpause();
        escrow.createAgreement(ID, ownerB, address(vault), CONTEXT, amounts, criteria, true, deadline, deadline + 100);
        escrow.unpause();
        vm.stopPrank();
        usdc.mint(address(vault), 100e6);
        decision = vault.hashEscrowFunding(KEY, CONTEXT, address(escrow), ID, 30e6, deadline + 1);
        vm.prank(ownerA);
        vault.approveDecision(decision, deadline + 1);
    }

    function fund() internal {
        vm.prank(operatorA);
        vault.fundEscrow(decision, KEY, CONTEXT, KEY, address(escrow), ID, 30e6, deadline + 1);
    }

    function test_ExactFundingChargesBeneficiaryAndRejectsReplay() public {
        fund();
        assertEq(escrow.getAgreement(ID).funded, 30e6);
        assertEq(usdc.balanceOf(address(escrow)), 30e6);
        assertEq(usdc.balanceOf(address(vault)), 70e6);
        assertEq(usdc.balanceOf(ownerB), 10_000e6);
        assertEq(usdc.allowance(address(vault), address(escrow)), 0);
        assertEq(vault.vendorDailySpent(ownerB, vm.getBlockTimestamp() / 1 days), 30e6);
        vm.expectRevert(BusinessPolicyVault.InvalidDecision.selector);
        fund();
    }

    function test_FailureRollsBackBothContractsAndCanRetry() public {
        usdc.setFailure(MockUSDC.Failure.Revert);
        vm.expectRevert(MockUSDC.TransferFailed.selector);
        fund();
        assertEq(escrow.getAgreement(ID).funded, 0);
        assertFalse(vault.usedIdempotencyKeys(KEY));
        assertFalse(vault.fundedAgreements(ID));
        assertEq(vault.dailySpent(vm.getBlockTimestamp() / 1 days), 0);
        assertEq(usdc.allowance(address(vault), address(escrow)), 0);
        (address approver,) = vault.approvals(decision);
        assertEq(approver, ownerA);
        usdc.setFailure(MockUSDC.Failure.None);
        fund();
    }

    function test_VaultBindingDeadlineAndPayeePolicy() public {
        vm.prank(operatorA);
        vm.expectRevert(MilestoneEscrow.UnauthorizedFunder.selector);
        escrow.fundAgreement(ID, 30e6);
        BusinessPolicyVault other =
            new BusinessPolicyVault(address(usdc), keccak256("b"), ownerB, operatorB, ownerB, ownerB);
        vm.prank(ownerB);
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        other.setEscrow(address(escrow), true);
        vm.prank(ownerA);
        vault.setVendor(ownerB, false, 0);
        vm.expectRevert(BusinessPolicyVault.VendorNotAllowed.selector);
        fund();
        vm.prank(ownerA);
        vault.setVendor(ownerB, true, 50e6);
        vm.warp(deadline);
        vm.expectRevert(MilestoneEscrow.InvalidFunding.selector);
        fund();
    }

    function testFuzz_ChangedFundingAmountCannotReuseApproval(uint256 amount) public {
        vm.assume(amount != 30e6);
        vm.prank(operatorA);
        vm.expectRevert(BusinessPolicyVault.InvalidDecision.selector);
        vault.fundEscrow(decision, KEY, CONTEXT, KEY, address(escrow), ID, amount, deadline + 1);
    }

    function test_InvalidAgreementDoesNotReserveId() public {
        uint256[] memory amounts = new uint256[](1);
        bytes32[] memory criteria = new bytes32[](1);
        criteria[0] = CONTEXT;
        vm.prank(ownerA);
        vm.expectRevert(MilestoneEscrow.InvalidAgreement.selector);
        escrow.createAgreement(
            keccak256("bad"), ownerB, address(vault), CONTEXT, amounts, criteria, false, deadline, deadline + 1
        );
        assertEq(escrow.getAgreement(keccak256("bad")).payee, address(0));
    }

    function test_ReportedTransferSuccessWithoutFundsIsRejected() public {
        vm.mockCall(
            address(usdc),
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(vault), address(escrow), 30e6),
            abi.encode(true)
        );
        vm.expectRevert(MilestoneEscrow.InvalidFunding.selector);
        fund();
        assertEq(escrow.getAgreement(ID).funded, 0);
        assertFalse(vault.fundedAgreements(ID));
    }

    function test_FundingAlwaysNeedsLiveOwnerApproval() public {
        vm.prank(ownerA);
        vault.approveDecision(decision, uint64(vm.getBlockTimestamp() + 1));
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.expectRevert(BusinessPolicyVault.ApprovalRequired.selector);
        fund();
    }
}
