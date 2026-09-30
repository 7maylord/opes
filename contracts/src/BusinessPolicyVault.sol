// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Organization-scoped custody and policy. Payment execution is added separately.
contract BusinessPolicyVault is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // One owner authority, with OpenZeppelin's two-step transfer safeguards.
    bytes32 public constant OWNER_ROLE = DEFAULT_ADMIN_ROLE;
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable token;
    bytes32 public immutable organizationDomain;
    address public immutable recoveryAddress;

    uint256 public autonomousMax;
    uint256 public singleMax;
    uint256 public organizationDailyMax;

    struct VendorPolicy {
        bool allowed;
        uint256 dailyLimit;
    }

    mapping(address vendor => VendorPolicy) public vendorPolicies;

    error InvalidConfiguration();
    error InvalidLimits();
    error InvalidAmount();
    error OwnerRequired();

    event VendorPolicyUpdated(address indexed vendor, bool allowed, uint256 dailyLimit);
    event LimitsUpdated(uint256 autonomousMax, uint256 singleMax, uint256 dailyMax);
    event FundsRecovered(address indexed destination, uint256 amount, address indexed owner);

    constructor(address usdc, bytes32 organization, address owner_, address operator, address pauser, address recovery)
        AccessControlDefaultAdminRules(0, owner_)
    {
        if (
            usdc == address(0) || organization == bytes32(0) || recovery == address(0) || recovery == address(this)
                || recovery == usdc || recovery == operator
        ) revert InvalidConfiguration();
        // Deployment configuration must also verify the official network/token binding.
        if (IERC20Metadata(usdc).decimals() != 6) revert InvalidConfiguration();
        token = IERC20(usdc);
        organizationDomain = organization;
        recoveryAddress = recovery;
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(PAUSER_ROLE, pauser);
        _pause();
    }

    function setVendor(address vendor, bool allowed, uint256 dailyLimit) external onlyRole(OWNER_ROLE) {
        if (vendor == address(0) || vendor == address(this) || vendor == address(token)) revert InvalidConfiguration();
        if (allowed && dailyLimit == 0) revert InvalidLimits();
        vendorPolicies[vendor] = VendorPolicy({allowed: allowed, dailyLimit: dailyLimit});
        emit VendorPolicyUpdated(vendor, allowed, dailyLimit);
    }

    function setLimits(uint256 autonomous, uint256 single, uint256 daily) external onlyRole(OWNER_ROLE) {
        if (autonomous > single || single > daily) revert InvalidLimits();
        autonomousMax = autonomous;
        singleMax = single;
        organizationDailyMax = daily;
        emit LimitsUpdated(autonomous, single, daily);
    }

    function pause() external {
        if (!hasRole(OWNER_ROLE, msg.sender)) _checkRole(PAUSER_ROLE);
        _pause();
    }

    function unpause() external onlyRole(OWNER_ROLE) {
        if (singleMax == 0 || organizationDailyMax == 0) revert InvalidLimits();
        _unpause();
    }

    /// @dev The application must reconcile pending/unknown transactions before requesting recovery.
    function recoverUsdc(uint256 amount) external onlyRole(OWNER_ROLE) whenPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        token.safeTransfer(recoveryAddress, amount);
        emit FundsRecovered(recoveryAddress, amount, msg.sender);
    }

    function renounceRole(bytes32 role, address confirmation) public override {
        if (role == OWNER_ROLE) revert OwnerRequired();
        super.renounceRole(role, confirmation);
    }

    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (
            account == address(0) || (role == OWNER_ROLE && hasRole(OPERATOR_ROLE, account))
                || (role == OPERATOR_ROLE && hasRole(OWNER_ROLE, account))
        ) revert InvalidConfiguration();
        return super._grantRole(role, account);
    }
}
