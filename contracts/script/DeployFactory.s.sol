// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {OrganizationFactory} from "../src/OrganizationFactory.sol";

contract DeployFactory is Script {
    function run() external returns (OrganizationFactory factory) {
        require(block.chainid == 5042002, "Arc testnet only");
        address token = vm.envAddress("ARC_USDC_ADDRESS");
        require(token == 0x3600000000000000000000000000000000000000, "Unexpected Arc USDC");
        address admin = vm.envAddress("FACTORY_ADMIN_ADDRESS");
        address provisioner = vm.envAddress("FACTORY_PROVISIONER_ADDRESS");
        require(admin != address(0) && provisioner != address(0), "Missing platform role");

        // Read the key inside Foundry; never pass it in command-line arguments.
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        factory = new OrganizationFactory(token, admin, provisioner);
        vm.stopBroadcast();

        console2.log("OrganizationFactory", address(factory));
        console2.log("VaultDeployer", address(factory.vaultDeployer()));
    }
}
