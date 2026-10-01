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

/// @notice Agreement custody. Release/refund execution is introduced in C5; do not deploy this intermediate version.
contract MilestoneEscrow is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant ADMIN_ROLE = DEFAULT_ADMIN_ROLE;
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
            agreement.payee == address(0) || agreement.funded != 0 || amount != agreement.totalAmount
                || block.timestamp >= agreement.fundingDeadline
        ) revert InvalidFunding();
        agreement.funded = amount;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(vault, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert InvalidFunding();
        emit AgreementFunded(id, amount);
    }

    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
