// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {EscrowFixture} from "./EscrowFunding.t.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract FinancialSequencesTest is EscrowFixture {
    bytes32 constant MANDATE = keccak256("sequence-mandate");
    uint256 directPaid;
    uint256 recurringPaid;
    uint256 recovered;
    mapping(bytes32 => bool) moved;

    function setUp() public override {
        super.setUp();
        bytes32 role = escrow.OPERATOR_ROLE();
        uint64[] memory due = new uint64[](2);
        due[0] = uint64(vm.getBlockTimestamp());
        due[1] = due[0] + 1;
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = bytes32(uint256(100));
        keys[1] = bytes32(uint256(101));
        vm.startPrank(ownerA);
        escrow.grantRole(role, operatorA);
        vault.createRecurringMandate(MANDATE, ownerB, 1e6, due, keys, due[0], deadline + 100, 2e6);
        vm.stopPrank();
    }

    // Each seed explores an ordered transaction history, checking independent accounting after every action.
    function testFuzz_FinancialHistoryConservesFundsAndCannotReplay(bytes32 seed) public {
        for (uint256 step; step < 64; ++step) {
            seed = keccak256(abi.encode(seed, step));
            uint256 n = uint256(seed);
            uint256 action = n % 12;
            uint32 index = uint32((n >> 8) % 2);
            bytes32 key = bytes32(uint256(200 + (n >> 16) % 8));
            bytes memory data;
            address target = address(escrow);
            address caller = operatorA;
            uint256 amount = 1 + (n >> 32) % 1e6;
            usdc.setFailure(MockUSDC.Failure((n >> 64) % 3));
            if (action == 0) {
                target = address(vault);
                data = abi.encodeCall(
                    vault.fundEscrow, (decision, KEY, CONTEXT, KEY, address(escrow), ID, 30e6, deadline + 1)
                );
                key = KEY;
            } else if (action == 1) {
                target = address(vault);
                bytes32 hash = vault.hashDirectPayment(key, CONTEXT, ownerB, amount, deadline + 100);
                data = abi.encodeCall(
                    vault.executeDirectPayment, (hash, key, CONTEXT, key, ownerB, amount, deadline + 100)
                );
            } else if (action == 2) {
                target = address(vault);
                key = bytes32(uint256(100 + index));
                bytes32 hash = vault.hashRecurringPayment(MANDATE, index, CONTEXT, amount, deadline + 100);
                data = abi.encodeCall(
                    vault.executeRecurringPayment, (MANDATE, index, hash, key, CONTEXT, amount, deadline + 100)
                );
            } else if (action == 3) {
                caller = ownerA;
                data = abi.encodeCall(escrow.approveMilestone, (ID, index, seed, CONTEXT, deadline + 100));
            } else if (action == 4) {
                data = abi.encodeCall(escrow.releaseMilestone, (ID, index, key));
            } else if (action == 5) {
                caller = ownerB;
                data = abi.encodeCall(escrow.disputeMilestone, (ID, index, seed));
            } else if (action == 6) {
                caller = ownerA;
                data = abi.encodeCall(escrow.resolveMilestone, (ID, index, (n >> 104) % 2 == 0));
            } else if (action == 7) {
                caller = ownerA;
                data = abi.encodeCall(escrow.cancelAgreement, (ID, seed));
            } else if (action == 8) {
                data = abi.encodeCall(escrow.refundUnreleased, (ID, key));
            } else if (action == 9) {
                caller = ownerA;
                target = address(vault);
                data = vault.paused() ? abi.encodeCall(vault.unpause, ()) : abi.encodeCall(vault.pause, ());
            } else if (action == 10) {
                caller = ownerA;
                target = address(vault);
                data = abi.encodeCall(vault.recoverUsdc, (amount));
            } else {
                vm.warp(vm.getBlockTimestamp() + (n >> 96) % 20);
                continue;
            }
            // Wrong-tenant attempts must fail even with otherwise valid calldata.
            bool foreign = (n >> 80) % 5 == 0;
            if (foreign) caller = operatorB;
            bytes32 beforeState = snapshot(key);
            vm.prank(caller);
            (bool ok,) = target.call(data);
            if (foreign) assertFalse(ok, "foreign tenant executed action");
            if (!ok) assertEq(snapshot(key), beforeState, "failure changed financial state");
            if (ok && (action <= 2 || action == 4 || action == 8)) {
                bytes32 scoped = keccak256(abi.encode(target, key));
                assertFalse(moved[scoped], "replayed movement");
                moved[scoped] = true;
            }
            if (ok && action == 1) directPaid += amount;
            if (ok && action == 2) recurringPaid += amount;
            if (ok && action == 10) recovered += amount;
            checkAccounting();
        }
    }

    function snapshot(bytes32 key) internal view returns (bytes32) {
        (MilestoneEscrow.MilestoneState a, bytes32 d0, bytes32 e0, uint64 t0, address p0) = escrow.milestones(ID, 0);
        (MilestoneEscrow.MilestoneState b, bytes32 d1, bytes32 e1, uint64 t1, address p1) = escrow.milestones(ID, 1);
        (address approver, uint64 expiry) = vault.approvals(decision);
        return keccak256(
            abi.encode(
                usdc.balanceOf(address(vault)),
                usdc.balanceOf(address(escrow)),
                usdc.balanceOf(ownerA),
                usdc.balanceOf(ownerB),
                escrow.released(ID),
                escrow.refunded(ID),
                escrow.getAgreement(ID).funded,
                vault.getRecurringMandate(MANDATE).paid,
                vault.dailySpent(vm.getBlockTimestamp() / 1 days),
                approver,
                expiry,
                vault.usedIdempotencyKeys(key),
                escrow.usedIdempotencyKeys(key),
                vault.fundedAgreements(ID),
                escrow.cancelled(ID),
                usdc.allowance(address(vault), address(escrow)),
                a,
                d0,
                e0,
                t0,
                p0,
                b,
                d1,
                e1,
                t1,
                p1
            )
        );
    }

    function checkAccounting() internal view {
        uint256 funded = escrow.getAgreement(ID).funded;
        uint256 released = escrow.released(ID);
        uint256 refunded = escrow.refunded(ID);
        assertEq(funded, released + refunded + usdc.balanceOf(address(escrow)), "escrow conservation");
        assertEq(usdc.balanceOf(ownerB), 10_000e6 + directPaid + recurringPaid + released, "payee attribution");
        assertEq(usdc.balanceOf(ownerA), 10_000e6 + recovered, "recovery destination");
        assertEq(
            usdc.balanceOf(address(vault)) + usdc.balanceOf(address(escrow)) + directPaid + recurringPaid + released
                + recovered,
            100e6,
            "treasury conservation"
        );
        assertEq(vault.getRecurringMandate(MANDATE).paid, recurringPaid);
        assertEq(vault.dailySpent(vm.getBlockTimestamp() / 1 days), funded + directPaid + recurringPaid);
        assertLe(vault.dailySpent(vm.getBlockTimestamp() / 1 days), 50e6);
    }
}
