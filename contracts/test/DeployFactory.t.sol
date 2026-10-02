// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeployFactory} from "../script/DeployFactory.s.sol";
import {OrganizationFactory} from "../src/OrganizationFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract DeployFactoryTest is Test {
    DeployFactory internal script;
    address internal constant TOKEN = 0x3600000000000000000000000000000000000000;
    address internal admin;
    address internal provisioner;

    function setUp() public {
        script = new DeployFactory();
        admin = makeAddr("platform-admin");
        provisioner = makeAddr("platform-provisioner");
        vm.chainId(5042002);
        vm.etch(TOKEN, address(new MockUSDC()).code);
        // Test-only signer: environment overrides are confined to this test process.
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "1");
        vm.setEnv("ARC_USDC_ADDRESS", vm.toString(TOKEN));
        vm.setEnv("FACTORY_ADMIN_ADDRESS", vm.toString(admin));
        vm.setEnv("FACTORY_PROVISIONER_ADDRESS", vm.toString(provisioner));
    }

    function test_DeploymentGuardsAndPlatformRoleBindings() public {
        // Environment cheatcodes are process-wide: exercise overrides serially.
        vm.chainId(1);
        vm.expectRevert("Arc testnet only");
        script.run();
        vm.chainId(5042002);

        vm.setEnv("ARC_USDC_ADDRESS", vm.toString(address(new MockUSDC())));
        vm.expectRevert("Unexpected Arc USDC");
        script.run();
        vm.setEnv("ARC_USDC_ADDRESS", vm.toString(TOKEN));

        vm.setEnv("FACTORY_PROVISIONER_ADDRESS", vm.toString(address(0)));
        vm.expectRevert("Missing platform role");
        script.run();
        vm.setEnv("FACTORY_PROVISIONER_ADDRESS", vm.toString(provisioner));
        vm.setEnv("FACTORY_ADMIN_ADDRESS", vm.toString(address(0)));
        vm.expectRevert("Missing platform role");
        script.run();
        vm.setEnv("FACTORY_ADMIN_ADDRESS", vm.toString(admin));

        OrganizationFactory factory = script.run();
        assertEq(factory.token(), TOKEN);
        assertEq(factory.defaultAdmin(), admin);
        assertTrue(factory.hasRole(factory.PROVISIONER_ROLE(), provisioner));
        assertFalse(factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), vm.addr(1)));
        assertFalse(factory.hasRole(factory.PROVISIONER_ROLE(), vm.addr(1)));
        assertEq(factory.vaultDeployer().factory(), address(factory));
        assertEq(factory.vaultDeployer().token(), TOKEN);
    }
}
