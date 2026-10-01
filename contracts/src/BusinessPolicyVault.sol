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

/// @notice Organization-scoped custody, policy and bounded payment execution.
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

    uint256 public constant DECISION_SCHEMA_VERSION = 1;
    uint8 public constant DIRECT_PAYMENT = 1;
    uint8 public constant RECURRING_PAYMENT = 2;

    enum MandateStatus {
        None,
        Active,
        Paused,
        Cancelled
    }

    struct RecurringMandate {
        address vendor;
        uint256 amountPerCycleMax;
        uint256 totalAmountMax;
        uint256 paid;
        uint64 startsAt;
        uint64 endsAt;
        MandateStatus status;
        uint64[] dueAt;
        bytes32[] obligationKeys;
    }

    mapping(bytes32 id => RecurringMandate) private _mandates;
    mapping(bytes32 key => bytes32 mandateId) public recurringMandateFor;
    error InvalidMandate();
    error CycleNotDue();
    event RecurringMandateCreated(bytes32 indexed mandateId, address indexed vendor);
    event RecurringPaymentExecuted(bytes32 indexed mandateId, bytes32 indexed obligationKey, uint256 amount);
    event RecurringMandateStatusChanged(bytes32 indexed mandateId, MandateStatus status);

    struct Approval {
        address owner;
        uint64 expiresAt;
    }

    mapping(bytes32 key => bool) public usedIdempotencyKeys;
    mapping(bytes32 decision => Approval) public approvals;
    mapping(uint256 day => uint256) public dailySpent;
    mapping(address vendor => mapping(uint256 day => uint256)) public vendorDailySpent;

    error InvalidDecision();
    error DecisionExpired();
    error ObligationAlreadyPaid();
    error VendorNotAllowed();
    error LimitExceeded();
    error ApprovalRequired();

    event DecisionApproved(bytes32 indexed decisionHash, uint64 expiresAt, address approver);
    event PaymentExecuted(
        bytes32 indexed decisionHash,
        bytes32 indexed idempotencyKey,
        address indexed vendor,
        uint256 amount,
        address operator
    );

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

    function hashDirectPayment(
        bytes32 obligationKey,
        bytes32 contextHash,
        address vendor,
        uint256 amount,
        uint64 expiresAt
    ) public view returns (bytes32) {
        return _hashPayment(DIRECT_PAYMENT, obligationKey, contextHash, vendor, amount, expiresAt, bytes32(0), 0);
    }

    function _hashPayment(
        uint8 action,
        bytes32 obligationKey,
        bytes32 contextHash,
        address vendor,
        uint256 amount,
        uint64 expiresAt,
        bytes32 mandateId,
        uint32 cycleIndex
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DECISION_SCHEMA_VERSION,
                block.chainid,
                address(this),
                organizationDomain,
                address(token),
                action,
                obligationKey,
                vendor,
                amount,
                expiresAt,
                bytes32(0),
                mandateId,
                cycleIndex,
                contextHash
            )
        );
    }

    function approveDecision(bytes32 decisionHash, uint64 expiresAt) external onlyRole(OWNER_ROLE) {
        if (decisionHash == bytes32(0)) revert InvalidDecision();
        if (expiresAt <= block.timestamp) revert DecisionExpired();
        approvals[decisionHash] = Approval({owner: msg.sender, expiresAt: expiresAt});
        emit DecisionApproved(decisionHash, expiresAt, msg.sender);
    }

    function executeDirectPayment(
        bytes32 decisionHash,
        bytes32 obligationKey,
        bytes32 contextHash,
        bytes32 idempotencyKey,
        address vendor,
        uint256 amount,
        uint64 expiresAt
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        if (
            idempotencyKey != obligationKey || recurringMandateFor[obligationKey] != bytes32(0)
                || decisionHash != hashDirectPayment(obligationKey, contextHash, vendor, amount, expiresAt)
        ) revert InvalidDecision();
        _executePayment(decisionHash, obligationKey, contextHash, vendor, amount, expiresAt);
    }

    function _executePayment(
        bytes32 decisionHash,
        bytes32 obligationKey,
        bytes32 contextHash,
        address vendor,
        uint256 amount,
        uint64 expiresAt
    ) internal {
        if (amount == 0) revert InvalidAmount();
        if (expiresAt <= block.timestamp) revert DecisionExpired();
        if (obligationKey == bytes32(0) || contextHash == bytes32(0)) revert InvalidDecision();
        if (usedIdempotencyKeys[obligationKey]) revert ObligationAlreadyPaid();
        VendorPolicy memory policy = vendorPolicies[vendor];
        if (!policy.allowed) revert VendorNotAllowed();
        uint256 day = block.timestamp / 1 days;
        uint256 total = dailySpent[day] + amount;
        uint256 vendorTotal = vendorDailySpent[vendor][day] + amount;
        if (amount > singleMax || total > organizationDailyMax || vendorTotal > policy.dailyLimit) {
            revert LimitExceeded();
        }
        Approval memory approval = approvals[decisionHash];
        if (amount > autonomousMax && (approval.owner != owner() || approval.expiresAt <= block.timestamp)) {
            revert ApprovalRequired();
        }
        usedIdempotencyKeys[obligationKey] = true;
        dailySpent[day] = total;
        vendorDailySpent[vendor][day] = vendorTotal;
        delete approvals[decisionHash];
        token.safeTransfer(vendor, amount);
        emit PaymentExecuted(decisionHash, obligationKey, vendor, amount, msg.sender);
    }

    function setLimits(uint256 autonomous, uint256 single, uint256 daily) external onlyRole(OWNER_ROLE) {
        if (autonomous > single || single > daily) revert InvalidLimits();
        autonomousMax = autonomous;
        singleMax = single;
        organizationDailyMax = daily;
        emit LimitsUpdated(autonomous, single, daily);
    }

    function getRecurringMandate(bytes32 mandateId) external view returns (RecurringMandate memory) {
        return _mandates[mandateId];
    }

    function createRecurringMandate(
        bytes32 mandateId,
        address vendor,
        uint256 amountPerCycleMax,
        uint64[] calldata dueAt,
        bytes32[] calldata obligationKeys,
        uint64 startsAt,
        uint64 endsAt,
        uint256 totalAmountMax
    ) external onlyRole(OWNER_ROLE) {
        uint256 count = dueAt.length;
        if (
            mandateId == bytes32(0) || _mandates[mandateId].status != MandateStatus.None
                || !vendorPolicies[vendor].allowed || count == 0 || count > 24 || obligationKeys.length != count
                || amountPerCycleMax == 0 || totalAmountMax < amountPerCycleMax || startsAt < block.timestamp
                || endsAt <= startsAt
        ) revert InvalidMandate();
        for (uint256 i; i < count; ++i) {
            bytes32 key = obligationKeys[i];
            if (
                key == bytes32(0) || usedIdempotencyKeys[key] || dueAt[i] < startsAt || dueAt[i] >= endsAt
                    || (i > 0 && dueAt[i] <= dueAt[i - 1])
            ) revert InvalidMandate();
            // ponytail: quadratic uniqueness check is bounded to 24 cycles; use a set if the cap grows.
            for (uint256 j; j < i; ++j) {
                if (obligationKeys[j] == key) revert InvalidMandate();
            }
            bytes32 previous = recurringMandateFor[key];
            if (previous != bytes32(0) && _mandates[previous].status != MandateStatus.Cancelled) {
                revert InvalidMandate();
            }
            recurringMandateFor[key] = mandateId;
        }
        _mandates[mandateId] = RecurringMandate(
            vendor, amountPerCycleMax, totalAmountMax, 0, startsAt, endsAt, MandateStatus.Active, dueAt, obligationKeys
        );
        emit RecurringMandateCreated(mandateId, vendor);
    }

    function hashRecurringPayment(
        bytes32 mandateId,
        uint32 cycleIndex,
        bytes32 contextHash,
        uint256 amount,
        uint64 expiresAt
    ) public view returns (bytes32) {
        RecurringMandate storage mandate = _mandates[mandateId];
        if (cycleIndex >= mandate.obligationKeys.length) revert InvalidMandate();
        return _hashPayment(
            RECURRING_PAYMENT,
            mandate.obligationKeys[cycleIndex],
            contextHash,
            mandate.vendor,
            amount,
            expiresAt,
            mandateId,
            cycleIndex
        );
    }

    function executeRecurringPayment(
        bytes32 mandateId,
        uint32 cycleIndex,
        bytes32 decisionHash,
        bytes32 obligationKey,
        bytes32 contextHash,
        uint256 amount,
        uint64 expiresAt
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        RecurringMandate storage mandate = _mandates[mandateId];
        if (mandate.status != MandateStatus.Active || cycleIndex >= mandate.dueAt.length) revert InvalidMandate();
        if (block.timestamp < mandate.dueAt[cycleIndex] || block.timestamp >= mandate.endsAt) revert CycleNotDue();
        if (
            obligationKey != mandate.obligationKeys[cycleIndex]
                || decisionHash != hashRecurringPayment(mandateId, cycleIndex, contextHash, amount, expiresAt)
        ) revert InvalidDecision();
        if (amount > mandate.amountPerCycleMax || mandate.paid + amount > mandate.totalAmountMax) {
            revert LimitExceeded();
        }
        mandate.paid += amount;
        _executePayment(decisionHash, obligationKey, contextHash, mandate.vendor, amount, expiresAt);
        emit RecurringPaymentExecuted(mandateId, obligationKey, amount);
    }

    function pauseRecurringMandate(bytes32 mandateId) external onlyRole(OWNER_ROLE) {
        if (_mandates[mandateId].status != MandateStatus.Active) revert InvalidMandate();
        _mandates[mandateId].status = MandateStatus.Paused;
        emit RecurringMandateStatusChanged(mandateId, MandateStatus.Paused);
    }

    function resumeRecurringMandate(bytes32 mandateId) external onlyRole(OWNER_ROLE) {
        if (_mandates[mandateId].status != MandateStatus.Paused || block.timestamp >= _mandates[mandateId].endsAt) {
            revert InvalidMandate();
        }
        _mandates[mandateId].status = MandateStatus.Active;
        emit RecurringMandateStatusChanged(mandateId, MandateStatus.Active);
    }

    function cancelRecurringMandate(bytes32 mandateId) external onlyRole(OWNER_ROLE) {
        MandateStatus status = _mandates[mandateId].status;
        if (status != MandateStatus.Active && status != MandateStatus.Paused) revert InvalidMandate();
        _mandates[mandateId].status = MandateStatus.Cancelled;
        emit RecurringMandateStatusChanged(mandateId, MandateStatus.Cancelled);
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
