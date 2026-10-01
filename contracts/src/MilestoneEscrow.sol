// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IEscrowVault {
    function token() external view returns (IERC20);
    function organizationDomain() external view returns (bytes32);
    function owner() external view returns (address);
}

/// @notice Organization-bound escrow with evidence-approved, fixed milestone allocations.
contract MilestoneEscrow is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    address public immutable vault;
    IERC20 public immutable token;
    bytes32 public immutable organizationDomain;

    struct Agreement {
        address payee;
        address refundTo;
        bytes32 termsHash;
        uint256 totalAmount;
        uint256 funded;
        bool sequentialRelease;
        uint64 fundingDeadline;
        uint64 completionDeadline;
        uint256[] milestoneAmounts;
        bytes32[] acceptanceCriteriaHashes;
    }
    mapping(bytes32 id => Agreement) internal _agreements;
    enum MilestoneState {
        Pending,
        Accepted,
        Disputed,
        Refundable,
        Released,
        Refunded
    }

    struct Acceptance {
        MilestoneState state;
        bytes32 decisionHash;
        bytes32 evidenceHash;
        uint64 expiresAt;
        address approver;
    }
    mapping(bytes32 id => mapping(uint32 index => Acceptance)) public milestones;
    mapping(bytes32 id => bool) public cancelled;
    mapping(bytes32 id => bool) public agreementPaused;
    mapping(bytes32 id => uint256) public released;
    mapping(bytes32 id => uint256) public refunded;
    mapping(bytes32 key => bool) public usedIdempotencyKeys;
    error InvalidMilestone();
    error InvalidAuthorization();
    error Replay();
    event MilestoneApproved(
        bytes32 indexed agreementId, uint32 indexed milestoneIndex, bytes32 decisionHash, bytes32 evidenceHash
    );
    event MilestoneApprovalInvalidated(bytes32 indexed agreementId, uint32 indexed milestoneIndex);
    event MilestoneReleased(
        bytes32 indexed agreementId, uint32 indexed milestoneIndex, address indexed payee, uint256 amount
    );
    event MilestoneDisputed(bytes32 indexed agreementId, uint32 indexed milestoneIndex, bytes32 reasonHash);
    event MilestoneResolved(bytes32 indexed agreementId, uint32 indexed milestoneIndex, bool releaseToPayee);
    event AgreementCancelled(bytes32 indexed agreementId, bytes32 reasonHash);
    event AgreementPauseChanged(bytes32 indexed agreementId, bool paused);
    event UnreleasedFundsRefunded(bytes32 indexed agreementId, address indexed refundTo, uint256 amount);
    error InvalidAgreement();
    error InvalidFunding();
    error UnauthorizedFunder();
    event AgreementCreated(bytes32 indexed agreementId, address indexed payee, uint256 totalAmount, bytes32 termsHash);
    event AgreementFunded(bytes32 indexed agreementId, uint256 amount);

    constructor(address vault_, address admin) AccessControlDefaultAdminRules(0, admin) {
        if (vault_ == address(0) || IEscrowVault(vault_).owner() != admin) revert InvalidAgreement();
        vault = vault_;
        token = IEscrowVault(vault_).token();
        organizationDomain = IEscrowVault(vault_).organizationDomain();
        _grantRole(APPROVER_ROLE, admin);
        _pause();
    }

    function getAgreement(bytes32 id) external view returns (Agreement memory) {
        return _agreements[id];
    }

    function createAgreement(
        bytes32 id,
        address payee,
        address refundTo,
        bytes32 termsHash,
        uint256[] calldata amounts,
        bytes32[] calldata criteria,
        bool sequentialRelease,
        uint64 fundingDeadline,
        uint64 completionDeadline
    ) external onlyRole(ADMIN_ROLE) {
        if (
            id == bytes32(0) || _agreements[id].payee != address(0) || payee == address(0) || payee == vault
                || payee == address(this) || payee == address(token) || payee == owner() || refundTo != vault
                || termsHash == bytes32(0) || amounts.length == 0 || amounts.length > 5
                || amounts.length != criteria.length || fundingDeadline <= block.timestamp
                || completionDeadline <= fundingDeadline
        ) revert InvalidAgreement();
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            if (amounts[i] == 0 || criteria[i] == bytes32(0)) revert InvalidAgreement();
            total += amounts[i];
        }
        _agreements[id] = Agreement(
            payee,
            refundTo,
            termsHash,
            total,
            0,
            sequentialRelease,
            fundingDeadline,
            completionDeadline,
            amounts,
            criteria
        );
        emit AgreementCreated(id, payee, total, termsHash);
    }

    function fundAgreement(bytes32 id, uint256 amount) external whenNotPaused nonReentrant {
        if (msg.sender != vault) revert UnauthorizedFunder();
        Agreement storage agreement = _agreements[id];
        if (
            agreement.payee == address(0) || agreement.funded != 0 || amount != agreement.totalAmount || cancelled[id]
                || agreementPaused[id] || block.timestamp >= agreement.fundingDeadline
        ) revert InvalidFunding();
        agreement.funded = amount;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(vault, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert InvalidFunding();
        emit AgreementFunded(id, amount);
    }

    function _milestone(bytes32 id, uint32 index) internal view returns (Acceptance storage acceptance) {
        if (_agreements[id].funded == 0 || index >= _agreements[id].milestoneAmounts.length) revert InvalidMilestone();
        return milestones[id][index];
    }

    function approveMilestone(bytes32 id, uint32 index, bytes32 decisionHash, bytes32 evidenceHash, uint64 expiresAt)
        external
        onlyRole(APPROVER_ROLE)
        whenNotPaused
    {
        Acceptance storage acceptance = _milestone(id, index);
        Agreement storage agreement = _agreements[id];
        if (
            cancelled[id] || agreementPaused[id] || msg.sender == agreement.payee || decisionHash == bytes32(0)
                || evidenceHash == bytes32(0) || expiresAt <= block.timestamp
                || expiresAt > agreement.completionDeadline
                || (acceptance.state != MilestoneState.Pending && acceptance.state != MilestoneState.Accepted)
        ) revert InvalidAuthorization();
        milestones[id][index] = Acceptance(MilestoneState.Accepted, decisionHash, evidenceHash, expiresAt, msg.sender);
        emit MilestoneApproved(id, index, decisionHash, evidenceHash);
    }

    function invalidateMilestoneApproval(bytes32 id, uint32 index) external onlyRole(APPROVER_ROLE) {
        Acceptance storage acceptance = _milestone(id, index);
        if (msg.sender == _agreements[id].payee || acceptance.state != MilestoneState.Accepted) {
            revert InvalidAuthorization();
        }
        delete milestones[id][index];
        emit MilestoneApprovalInvalidated(id, index);
    }

    function releaseMilestone(bytes32 id, uint32 index, bytes32 key)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        Acceptance storage acceptance = _milestone(id, index);
        Agreement storage agreement = _agreements[id];
        if (
            cancelled[id] || agreementPaused[id] || block.timestamp >= agreement.completionDeadline
                || acceptance.state != MilestoneState.Accepted || acceptance.expiresAt <= block.timestamp
                || acceptance.decisionHash == bytes32(0) || acceptance.evidenceHash == bytes32(0)
                || !hasRole(APPROVER_ROLE, acceptance.approver) || acceptance.approver == agreement.payee
        ) revert InvalidAuthorization();
        if (key == bytes32(0) || usedIdempotencyKeys[key]) revert Replay();
        if (agreement.sequentialRelease) {
            for (uint32 i; i < index; ++i) {
                if (milestones[id][i].state != MilestoneState.Released) revert InvalidMilestone();
            }
        }
        uint256 amount = agreement.milestoneAmounts[index];
        acceptance.state = MilestoneState.Released;
        usedIdempotencyKeys[key] = true;
        released[id] += amount;
        token.safeTransfer(agreement.payee, amount);
        emit MilestoneReleased(id, index, agreement.payee, amount);
    }

    function disputeMilestone(bytes32 id, uint32 index, bytes32 reasonHash) external {
        Acceptance storage acceptance = _milestone(id, index);
        if (msg.sender != _agreements[id].payee) _checkRole(ADMIN_ROLE);
        if (
            reasonHash == bytes32(0) || cancelled[id]
                || (acceptance.state != MilestoneState.Pending && acceptance.state != MilestoneState.Accepted)
        ) revert InvalidMilestone();
        acceptance.state = MilestoneState.Disputed;
        emit MilestoneDisputed(id, index, reasonHash);
    }

    function resolveMilestone(bytes32 id, uint32 index, bool releaseToPayee) external onlyRole(ADMIN_ROLE) {
        Acceptance storage acceptance = _milestone(id, index);
        if (acceptance.state != MilestoneState.Disputed || msg.sender == _agreements[id].payee) {
            revert InvalidMilestone();
        }
        if (releaseToPayee && (cancelled[id] || block.timestamp >= _agreements[id].completionDeadline)) {
            revert InvalidAuthorization();
        }
        delete milestones[id][index];
        milestones[id][index].state = releaseToPayee ? MilestoneState.Pending : MilestoneState.Refundable;
        emit MilestoneResolved(id, index, releaseToPayee);
    }

    function cancelAgreement(bytes32 id, bytes32 reasonHash) external onlyRole(ADMIN_ROLE) {
        Agreement storage agreement = _agreements[id];
        if (agreement.payee == address(0) || cancelled[id] || reasonHash == bytes32(0)) revert InvalidAgreement();
        cancelled[id] = true;
        for (uint32 i; i < agreement.milestoneAmounts.length; ++i) {
            MilestoneState state = milestones[id][i].state;
            if (state == MilestoneState.Pending || state == MilestoneState.Accepted) {
                milestones[id][i].state = MilestoneState.Refundable;
            }
        }
        emit AgreementCancelled(id, reasonHash);
    }

    function refundUnreleased(bytes32 id, bytes32 key) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        Agreement storage agreement = _agreements[id];
        if (!cancelled[id] || agreementPaused[id] || agreement.funded == 0) revert InvalidAgreement();
        if (key == bytes32(0) || usedIdempotencyKeys[key]) revert Replay();
        uint256 amount;
        for (uint32 i; i < agreement.milestoneAmounts.length; ++i) {
            if (milestones[id][i].state == MilestoneState.Refundable) {
                amount += agreement.milestoneAmounts[i];
                milestones[id][i].state = MilestoneState.Refunded;
            }
        }
        if (amount == 0) revert InvalidFunding();
        refunded[id] += amount;
        usedIdempotencyKeys[key] = true;
        token.safeTransfer(agreement.refundTo, amount);
        emit UnreleasedFundsRefunded(id, agreement.refundTo, amount);
    }

    function setAgreementPaused(bytes32 id, bool value) external onlyRole(ADMIN_ROLE) {
        if (_agreements[id].payee == address(0)) revert InvalidAgreement();
        agreementPaused[id] = value;
        emit AgreementPauseChanged(id, value);
    }

    function renounceRole(bytes32 role, address confirmation) public override {
        if (role == ADMIN_ROLE) revert InvalidAuthorization();
        super.renounceRole(role, confirmation);
    }

    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (
            account == address(0)
                || (role == OPERATOR_ROLE && (hasRole(ADMIN_ROLE, account) || hasRole(APPROVER_ROLE, account)))
                || ((role == ADMIN_ROLE || role == APPROVER_ROLE) && hasRole(OPERATOR_ROLE, account))
        ) revert InvalidAuthorization();
        return super._grantRole(role, account);
    }

    function pause() external {
        if (!hasRole(ADMIN_ROLE, msg.sender)) _checkRole(PAUSER_ROLE);
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
