// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BusinessPolicyVault} from "./BusinessPolicyVault.sol";
import {MilestoneEscrow} from "./MilestoneEscrow.sol";

/// @dev Separate creation code keeps the factory below the EVM runtime size limit.
/// No custody or tenant roles; only its immutable factory can create vaults.
contract VaultDeployer {
    address public immutable factory;
    address public immutable token;
    error UnauthorizedFactory();

    constructor(address token_) {
        factory = msg.sender;
        token = token_;
    }

    function deploy(bytes32 organization, address owner, address operator, address pauser, address recovery)
        external
        returns (BusinessPolicyVault)
    {
        if (msg.sender != factory) revert UnauthorizedFactory();
        return new BusinessPolicyVault(token, organization, owner, operator, pauser, recovery);
    }
}

/// @notice One isolated, paused vault/escrow pair per organization on this chain.
/// A platform provisioner pays transaction gas; tenant wallets need no deployment balance.
contract OrganizationFactory is AccessControlDefaultAdminRules {
    bytes32 public constant PROVISIONER_ROLE = keccak256("PROVISIONER_ROLE");
    address public immutable token;
    VaultDeployer public immutable vaultDeployer;

    struct Deployment {
        address vault;
        address escrow;
        bytes32 configurationHash;
    }

    mapping(bytes32 organization => Deployment) public deployments;
    mapping(address operator => bytes32 organization) public operatorOrganizations;

    error InvalidConfiguration();
    error ConfigurationMismatch();
    error OperatorAlreadyAssigned();
    event OrganizationCreated(
        bytes32 indexed organization, address indexed vault, address indexed escrow, bytes32 configurationHash
    );

    constructor(address token_, address admin, address provisioner) AccessControlDefaultAdminRules(0, admin) {
        if (token_ == address(0) || IERC20Metadata(token_).decimals() != 6) revert InvalidConfiguration();
        token = token_;
        vaultDeployer = new VaultDeployer(token_);
        _grantRole(PROVISIONER_ROLE, provisioner);
    }

    function createOrganization(
        bytes32 organization,
        address tenantOwner,
        address operator,
        address pauser,
        address recovery
    ) external onlyRole(PROVISIONER_ROLE) returns (address vault, address escrow) {
        if (organization == bytes32(0)) revert InvalidConfiguration();
        bytes32 configurationHash = keccak256(abi.encode(tenantOwner, operator, pauser, recovery));
        Deployment memory existing = deployments[organization];
        if (existing.vault != address(0)) {
            if (existing.configurationHash != configurationHash) revert ConfigurationMismatch();
            return (existing.vault, existing.escrow);
        }
        _validateTenantAddress(tenantOwner);
        _validateTenantAddress(operator);
        _validateTenantAddress(pauser);
        _validateTenantAddress(recovery);
        if (operatorOrganizations[operator] != bytes32(0)) revert OperatorAlreadyAssigned();

        // Known constructors only: no arbitrary callbacks, code or delegatecalls.
        // Any failure rolls back both deployments, the registry and operator reservation.
        vault = address(vaultDeployer.deploy(organization, tenantOwner, operator, pauser, recovery));
        escrow = address(new MilestoneEscrow(vault, tenantOwner, operator, pauser));
        deployments[organization] = Deployment(vault, escrow, configurationHash);
        operatorOrganizations[operator] = organization;
        emit OrganizationCreated(organization, vault, escrow, configurationHash);
    }

    function _validateTenantAddress(address account) internal view {
        if (account == address(0) || account == address(this) || account == address(vaultDeployer) || account == token) revert InvalidConfiguration();
    }

    function renounceRole(bytes32 role, address confirmation) public override {
        if (role == DEFAULT_ADMIN_ROLE) revert InvalidConfiguration();
        super.renounceRole(role, confirmation);
    }

    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (account == address(0)) revert InvalidConfiguration();
        return super._grantRole(role, account);
    }
}
