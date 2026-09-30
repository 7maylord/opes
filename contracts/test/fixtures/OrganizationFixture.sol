// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

abstract contract OrganizationFixture is Test {
    MockUSDC internal usdc;
    address internal ownerA;
    address internal ownerB;
    address internal operatorA;
    address internal operatorB;

    function setUp() public virtual {
        ownerA = makeAddr("organization-a-owner");
        ownerB = makeAddr("organization-b-owner");
        operatorA = makeAddr("organization-a-operator");
        operatorB = makeAddr("organization-b-operator");
        usdc = new MockUSDC();
        usdc.mint(ownerA, 10_000e6);
        usdc.mint(ownerB, 10_000e6);
    }
}
