// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {OrganizationFixture} from "./fixtures/OrganizationFixture.sol";
import {OrganizationFactory, VaultDeployer} from "../src/OrganizationFactory.sol";
import {BusinessPolicyVault} from "../src/BusinessPolicyVault.sol";
import {MilestoneEscrow} from "../src/MilestoneEscrow.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Vm} from "forge-std/Vm.sol";

contract OrganizationFactoryTest is OrganizationFixture {
    OrganizationFactory internal factory;
    address internal platformAdmin;
    address internal provisioner;
    address internal pauser;
    bytes32 internal constant ORG_A = keccak256("organization-a");
    bytes32 internal constant ORG_B = keccak256("organization-b");

    function setUp() public override {
        super.setUp();
        platformAdmin = makeAddr("platform-admin");
        provisioner = makeAddr("platform-provisioner");
        pauser = makeAddr("tenant-pauser");
        factory = new OrganizationFactory(address(usdc), platformAdmin, provisioner);
    }

    function createA() internal returns (BusinessPolicyVault vault, MilestoneEscrow escrow) {
        vm.prank(provisioner);
        (address vaultAddress, address escrowAddress) =
            factory.createOrganization(ORG_A, ownerA, operatorA, pauser, ownerA);
        return (BusinessPolicyVault(vaultAddress), MilestoneEscrow(escrowAddress));
    }

    function test_ProvisionerCreatesPausedTenantOwnedPairWithoutTenantGas() public {
        vm.deal(ownerA, 0);
        vm.deal(operatorA, 0);
        uint256 ownerBalance = usdc.balanceOf(ownerA);
        vm.prank(ownerA);
        usdc.transfer(ownerB, ownerBalance);
        (BusinessPolicyVault vault, MilestoneEscrow escrow) = createA();
        assertEq(ownerA.balance, 0);
        assertEq(operatorA.balance, 0);
        assertEq(usdc.balanceOf(ownerA), 0);
        assertEq(usdc.balanceOf(operatorA), 0);
        assertEq(vault.owner(), ownerA);
        assertEq(escrow.owner(), ownerA);
        assertEq(vault.organizationDomain(), ORG_A);
        assertEq(escrow.organizationDomain(), ORG_A);
        assertEq(escrow.vault(), address(vault));
        assertEq(address(vault.token()), address(usdc));
        assertEq(address(escrow.token()), address(usdc));
        assertEq(vault.recoveryAddress(), ownerA);
        assertTrue(vault.paused());
        assertTrue(escrow.paused());
        assertEq(vault.singleMax(), 0);
        assertTrue(vault.hasRole(vault.OPERATOR_ROLE(), operatorA));
        assertTrue(escrow.hasRole(escrow.OPERATOR_ROLE(), operatorA));
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), pauser));
        assertTrue(escrow.hasRole(escrow.PAUSER_ROLE(), pauser));
        assertTrue(escrow.hasRole(escrow.APPROVER_ROLE(), ownerA));
        assertFalse(vault.approvedEscrows(address(escrow)), "owner must configure spending");
        assertFalse(vault.hasRole(vault.OWNER_ROLE(), address(factory)));
        assertFalse(escrow.hasRole(escrow.ADMIN_ROLE(), address(factory)));
        assertFalse(vault.hasRole(vault.OPERATOR_ROLE(), provisioner));
        assertFalse(escrow.hasRole(escrow.OPERATOR_ROLE(), provisioner));
        assertLe(address(factory).code.length, 24576);
        assertLe(address(factory.vaultDeployer()).code.length, 24576);
        assertLe(address(vault).code.length, 24576);
        assertLe(address(escrow).code.length, 24576);
        assertLe(type(OrganizationFactory).creationCode.length + 96, 49152);
    }

    function test_IdenticalRetryReturnsPairWithoutRedeploymentOrReconfiguration() public {
        vm.recordLogs();
        (BusinessPolicyVault vault, MilestoneEscrow escrow) = createA();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 factoryEvents;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory)) continue;
            ++factoryEvents;
            assertEq(logs[i].topics[0], keccak256("OrganizationCreated(bytes32,address,address,bytes32)"));
            assertEq(logs[i].topics[1], ORG_A);
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(vault)))));
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(address(escrow)))));
        }
        assertEq(factoryEvents, 1);
        vm.prank(ownerA);
        vault.setLimits(1, 2, 3);
        uint64 nonce = vm.getNonce(address(factory));
        vm.recordLogs();
        (BusinessPolicyVault again, MilestoneEscrow againEscrow) = createA();
        assertEq(address(again), address(vault));
        assertEq(address(againEscrow), address(escrow));
        assertEq(vm.getNonce(address(factory)), nonce);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(vault.singleMax(), 2);
        vm.prank(provisioner);
        vm.expectRevert(OrganizationFactory.ConfigurationMismatch.selector);
        factory.createOrganization(ORG_A, ownerB, operatorA, pauser, ownerA);
    }

    function testFuzz_UntrustedCallerCannotClaimOrganization(address caller) public {
        vm.assume(caller != provisioner);
        bytes32 role = factory.PROVISIONER_ROLE();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, caller, role));
        factory.createOrganization(ORG_A, ownerA, operatorA, pauser, ownerA);
        (address vault,,) = factory.deployments(ORG_A);
        assertEq(vault, address(0));
    }

    function testFuzz_ChangedRoleConfigurationCannotReplacePair(uint8 field) public {
        (BusinessPolicyVault vault, MilestoneEscrow escrow) = createA();
        field = uint8(bound(field, 0, 3));
        vm.prank(provisioner);
        vm.expectRevert(OrganizationFactory.ConfigurationMismatch.selector);
        factory.createOrganization(
            ORG_A,
            field == 0 ? ownerB : ownerA,
            field == 1 ? operatorB : operatorA,
            field == 2 ? ownerB : pauser,
            field == 3 ? ownerB : ownerA
        );
        (address registeredVault, address registeredEscrow,) = factory.deployments(ORG_A);
        assertEq(registeredVault, address(vault));
        assertEq(registeredEscrow, address(escrow));
    }

    function test_FactoryRejectsInvalidTokenAndProvisioner() public {
        vm.expectRevert(OrganizationFactory.InvalidConfiguration.selector);
        new OrganizationFactory(address(0), platformAdmin, provisioner);
        vm.expectRevert(OrganizationFactory.InvalidConfiguration.selector);
        new OrganizationFactory(address(usdc), platformAdmin, address(0));
        vm.mockCall(address(usdc), abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        vm.expectRevert(OrganizationFactory.InvalidConfiguration.selector);
        new OrganizationFactory(address(usdc), platformAdmin, provisioner);
    }

    function test_TenantsHaveSeparateStorageAndCannotReuseOperatorsOrEscrows() public {
        (BusinessPolicyVault a, MilestoneEscrow escrowA) = createA();
        vm.prank(provisioner);
        vm.expectRevert(OrganizationFactory.OperatorAlreadyAssigned.selector);
        factory.createOrganization(ORG_B, ownerB, operatorA, ownerB, ownerB);
        vm.prank(provisioner);
        (address bAddress, address escrowB) = factory.createOrganization(ORG_B, ownerB, operatorB, ownerB, ownerB);
        BusinessPolicyVault b = BusinessPolicyVault(bAddress);
        assertNotEq(address(a), bAddress);
        assertNotEq(address(escrowA), escrowB);
        vm.prank(ownerA);
        a.setLimits(1, 2, 3);
        assertEq(b.singleMax(), 0);
        vm.prank(ownerB);
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        b.setEscrow(address(escrowA), true);
        bytes32 role = a.OWNER_ROLE();
        vm.prank(ownerB);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ownerB, role));
        a.setLimits(3, 4, 5);
        assertEq(factory.operatorOrganizations(operatorA), ORG_A);
        assertEq(factory.operatorOrganizations(operatorB), ORG_B);
    }

    function test_FailedSecondDeploymentRollsBackPairAndCanRetry() public {
        address helper = address(factory.vaultDeployer());
        uint64 nonce = vm.getNonce(helper);
        address predictedVault = vm.computeCreateAddress(helper, nonce);
        // Force escrow's constructor binding check to fail after vault creation.
        vm.mockCall(predictedVault, abi.encodeWithSignature("owner()"), abi.encode(ownerB));
        // mockCall installs stub code at empty addresses; remove it so CREATE can proceed.
        vm.etch(predictedVault, hex"");
        vm.expectRevert(MilestoneEscrow.InvalidAgreement.selector);
        createA();
        assertEq(predictedVault.code.length, 0);
        assertEq(vm.getNonce(helper), nonce);
        assertEq(factory.operatorOrganizations(operatorA), bytes32(0));
        (address registered,,) = factory.deployments(ORG_A);
        assertEq(registered, address(0));
        vm.clearMockedCalls();
        (BusinessPolicyVault vault,) = createA();
        assertEq(address(vault), predictedVault);
    }

    function test_InvalidBindingsCannotReserveOrganization() public {
        vm.startPrank(provisioner);
        vm.expectRevert(OrganizationFactory.InvalidConfiguration.selector);
        factory.createOrganization(bytes32(0), ownerA, operatorA, pauser, ownerA);
        vm.expectRevert(OrganizationFactory.InvalidConfiguration.selector);
        factory.createOrganization(ORG_A, address(factory), operatorA, pauser, ownerA);
        vm.expectRevert(OrganizationFactory.InvalidConfiguration.selector);
        factory.createOrganization(ORG_A, ownerA, operatorA, address(0), ownerA);
        vm.expectRevert(BusinessPolicyVault.InvalidConfiguration.selector);
        factory.createOrganization(ORG_A, ownerA, ownerA, pauser, ownerA);
        vm.stopPrank();
        createA();
    }

    function test_ProvisionerRotationAndHelperAccessDoNotGrantCustody() public {
        VaultDeployer helper = factory.vaultDeployer();
        vm.prank(provisioner);
        vm.expectRevert(VaultDeployer.UnauthorizedFactory.selector);
        helper.deploy(ORG_A, ownerA, operatorA, pauser, ownerA);
        address replacement = makeAddr("replacement-provisioner");
        bytes32 role = factory.PROVISIONER_ROLE();
        vm.startPrank(platformAdmin);
        factory.revokeRole(role, provisioner);
        factory.grantRole(role, replacement);
        vm.stopPrank();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, provisioner, role)
        );
        createA();
        vm.prank(replacement);
        (address vault,) = factory.createOrganization(ORG_A, ownerA, operatorA, pauser, ownerA);
        bytes32 ownerRole = BusinessPolicyVault(vault).OWNER_ROLE();
        vm.prank(platformAdmin);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, platformAdmin, ownerRole)
        );
        BusinessPolicyVault(vault).setLimits(1, 2, 3);
    }

    function test_CreatedPairCanFundAndReleaseWithTenantRoles() public {
        (BusinessPolicyVault vault, MilestoneEscrow escrow) = createA();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 100);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10e6;
        bytes32[] memory criteria = new bytes32[](1);
        criteria[0] = ORG_A;
        vm.startPrank(ownerA);
        vault.setLimits(10e6, 10e6, 10e6);
        vault.setVendor(ownerB, true, 10e6);
        vault.setEscrow(address(escrow), true);
        escrow.createAgreement(ORG_A, ownerB, address(vault), ORG_A, amounts, criteria, false, expiry, expiry + 100);
        vault.unpause();
        escrow.unpause();
        bytes32 decision = vault.hashEscrowFunding(ORG_A, ORG_A, address(escrow), ORG_A, 10e6, expiry);
        vault.approveDecision(decision, expiry);
        vm.stopPrank();
        usdc.mint(address(vault), 10e6);
        vm.prank(operatorA);
        vault.fundEscrow(decision, ORG_A, ORG_A, ORG_A, address(escrow), ORG_A, 10e6, expiry);
        vm.prank(ownerA);
        escrow.approveMilestone(ORG_A, 0, decision, ORG_A, expiry);
        vm.prank(operatorA);
        escrow.releaseMilestone(ORG_A, 0, ORG_A);
        assertEq(usdc.balanceOf(ownerB), 10_010e6);
        assertEq(escrow.released(ORG_A), 10e6);
        vm.startPrank(pauser);
        vault.pause();
        escrow.pause();
        vm.stopPrank();
        assertTrue(vault.paused());
        assertTrue(escrow.paused());
    }
}
