// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {EscrowFixture} from "./EscrowFunding.t.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Deliberately hostile test token: invoke one nested call before moving balances.
contract CallbackUSDC is MockUSDC {
    address target;
    bytes payload;
    bool public attempted;
    bool public succeeded;
    bytes public result;

    function arm(address target_, bytes memory payload_) external {
        target = target_;
        payload = payload_;
        attempted = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && target != address(0) && !attempted) {
            attempted = true;
            (succeeded, result) = target.call(payload);
        }
        super._update(from, to, value);
    }
}

contract ReentrancyTest is EscrowFixture {
    function createToken() internal override returns (MockUSDC) {
        return new CallbackUSDC();
    }

    function setUp() public override {
        super.setUp();
        bytes32 operatorRole = vault.OPERATOR_ROLE();
        vm.startPrank(ownerA);
        // Give the hostile callback real execution authority so role checks cannot mask a missing guard.
        vault.grantRole(operatorRole, address(usdc));
        escrow.grantRole(operatorRole, address(usdc));
        escrow.grantRole(operatorRole, operatorA);
        vm.stopPrank();
    }

    function direct(bytes32 key) internal view returns (bytes memory) {
        bytes32 hash = vault.hashDirectPayment(key, CONTEXT, ownerB, 1e6, deadline);
        return abi.encodeCall(vault.executeDirectPayment, (hash, key, CONTEXT, key, ownerB, 1e6, deadline));
    }

    function execute(address caller, address target, bytes memory data) internal {
        vm.prank(caller);
        (bool ok, bytes memory result) = target.call(data);
        assertTrue(ok, string(result));
    }

    function blocked() internal view {
        CallbackUSDC token = CallbackUSDC(address(usdc));
        assertTrue(token.attempted());
        assertFalse(token.succeeded());
        assertEq(token.result(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertFalse(vault.usedIdempotencyKeys(CONTEXT));
    }

    function test_DirectCannotReenterWithFreshObligation() public {
        CallbackUSDC(address(usdc)).arm(address(vault), direct(CONTEXT));
        execute(operatorA, address(vault), direct(KEY));
        blocked();
        assertEq(usdc.balanceOf(ownerB), 10_001e6);
        assertEq(vault.dailySpent(vm.getBlockTimestamp() / 1 days), 1e6);
    }

    function test_RecurringCannotReenterDirectRoute() public {
        uint64[] memory due = new uint64[](1);
        due[0] = uint64(vm.getBlockTimestamp());
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = KEY;
        vm.prank(ownerA);
        vault.createRecurringMandate(ID, ownerB, 1e6, due, keys, due[0], deadline, 1e6);
        bytes32 hash = vault.hashRecurringPayment(ID, 0, CONTEXT, 1e6, deadline);
        CallbackUSDC(address(usdc)).arm(address(vault), direct(CONTEXT));
        vm.prank(operatorA);
        vault.executeRecurringPayment(ID, 0, hash, KEY, CONTEXT, 1e6, deadline);
        blocked();
        assertEq(vault.getRecurringMandate(ID).paid, 1e6);
        assertEq(usdc.balanceOf(ownerB), 10_001e6);
    }

    function test_FundingCannotReenterVault() public {
        CallbackUSDC(address(usdc)).arm(address(vault), direct(CONTEXT));
        fund();
        blocked();
        assertEq(usdc.balanceOf(address(escrow)), 30e6);
        assertEq(vault.dailySpent(vm.getBlockTimestamp() / 1 days), 30e6);
    }

    function test_FundingCannotReenterEscrow() public {
        CallbackUSDC(address(usdc)).arm(address(escrow), abi.encodeCall(escrow.fundAgreement, (ID, 30e6)));
        fund();
        blocked();
        assertEq(escrow.getAgreement(ID).funded, 30e6);
    }

    function approveBoth() internal {
        fund();
        vm.startPrank(ownerA);
        escrow.approveMilestone(ID, 0, decision, CONTEXT, deadline);
        escrow.approveMilestone(ID, 1, decision, CONTEXT, deadline);
        vm.stopPrank();
    }

    function test_ReleaseCannotReenterNextAcceptedMilestone() public {
        approveBoth();
        CallbackUSDC(address(usdc)).arm(address(escrow), abi.encodeCall(escrow.releaseMilestone, (ID, 1, CONTEXT)));
        vm.prank(operatorA);
        escrow.releaseMilestone(ID, 0, KEY);
        blocked();
        assertFalse(escrow.usedIdempotencyKeys(CONTEXT));
        assertEq(escrow.released(ID), 10e6);
        assertEq(usdc.balanceOf(address(escrow)), 20e6);
    }

    function test_RefundCannotReenterWithFreshKey() public {
        fund();
        vm.prank(ownerA);
        escrow.cancelAgreement(ID, CONTEXT);
        CallbackUSDC(address(usdc)).arm(address(escrow), abi.encodeCall(escrow.refundUnreleased, (ID, CONTEXT)));
        vm.prank(operatorA);
        escrow.refundUnreleased(ID, KEY);
        blocked();
        assertFalse(escrow.usedIdempotencyKeys(CONTEXT));
        assertEq(escrow.refunded(ID), 30e6);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    function test_RecoveryCannotReenterAsAuthorizedOwner() public {
        bytes32 role = vault.OPERATOR_ROLE();
        vm.startPrank(ownerA);
        vault.pause();
        vault.revokeRole(role, address(usdc));
        vault.beginDefaultAdminTransfer(address(usdc));
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(address(usdc));
        vault.acceptDefaultAdminTransfer();
        CallbackUSDC(address(usdc)).arm(address(vault), abi.encodeCall(vault.recoverUsdc, (1e6)));
        vm.prank(address(usdc));
        vault.recoverUsdc(1e6);
        blocked();
        assertEq(usdc.balanceOf(ownerA), 10_001e6);
        assertEq(usdc.balanceOf(address(vault)), 99e6);
    }
}
