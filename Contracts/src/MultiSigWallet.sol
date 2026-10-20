// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MultiSigWallet
/// @notice Multi-signature wallet with support for multiple signers and approval requirements.
contract MultiSigWallet {
    // -------------------------------------------------------------------------
    // Custom errors
    // -------------------------------------------------------------------------
    error NotSigner();
    error InvalidSignerCount();
    error InvalidThreshold();
    error TransactionNotFound();
    error TransactionAlreadyExecuted();
    error InsufficientApprovals();
    error DuplicateSigner();
    error SignerNotFound();
    error InvalidTransaction();
    error InsufficientRejections();
    error TransactionNotPending();

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------
    enum TransactionStatus { PENDING, APPROVED, EXECUTED, REJECTED }

    struct Transaction {
        uint256 id;
        address target;
        uint256 value;
        bytes data;
        uint256 approvalCount;
        uint256 rejectionCount;
        TransactionStatus status;
        uint256 createdAt;
        uint256 executedAt;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event ThresholdUpdated(uint256 newThreshold);
    event TransactionCreated(uint256 indexed txId, address indexed creator, address indexed target);
    event TransactionApproved(uint256 indexed txId, address indexed signer);
    event TransactionExecuted(uint256 indexed txId, address indexed executor);
    event TransactionRejected(uint256 indexed txId);

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------
    address[] public signers;
    mapping(address => bool) public isSigner;
    uint256 public threshold;
    uint256 public rejectionThreshold;

    mapping(uint256 => Transaction) public transactions;
    mapping(uint256 => mapping(address => bool)) public approvals;
    mapping(uint256 => mapping(address => bool)) public rejections;
    uint256 public transactionCount;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(address[] memory _signers, uint256 _threshold, uint256 _rejectionThreshold) {
        if (_signers.length == 0) revert InvalidSignerCount();
        if (_threshold == 0 || _threshold > _signers.length) revert InvalidThreshold();
        if (_rejectionThreshold == 0 || _rejectionThreshold > _signers.length) revert InvalidThreshold();

        for (uint256 i = 0; i < _signers.length; i++) {
            if (_signers[i] == address(0)) revert InvalidSignerCount();
            if (isSigner[_signers[i]]) revert DuplicateSigner();

            signers.push(_signers[i]);
            isSigner[_signers[i]] = true;
        }

        threshold = _threshold;
        rejectionThreshold = _rejectionThreshold;
    }

    // -------------------------------------------------------------------------
    // External functions
    // -------------------------------------------------------------------------

    /// @notice Add a new signer to the wallet.
    /// @param newSigner The address of the new signer.
    /// @dev Access: Caller permissions are checked against the sender or assigned roles.
    /// @dev Reverts: `NotSigner` if `!isSigner[msg.sender]` is true. `InvalidSignerCount` if
    ///     `newSigner == address(0)` is true. `DuplicateSigner` if `isSigner[newSigner]` is true.
    function addSigner(address newSigner) external {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (newSigner == address(0)) revert InvalidSignerCount();
        if (isSigner[newSigner]) revert DuplicateSigner();

        signers.push(newSigner);
        isSigner[newSigner] = true;

        emit SignerAdded(newSigner);
    }

    /// @notice Remove a signer from the wallet.
    /// @param signerToRemove The address of the signer to remove.
    /// @dev Access: Caller permissions are checked against the sender or assigned roles.
    /// @dev Reverts: `NotSigner` if `!isSigner[msg.sender]` is true. `SignerNotFound` if
    ///     `!isSigner[signerToRemove]` is true. `InvalidThreshold` if `signers.length - 1 <
    ///     threshold` is true.
    function removeSigner(address signerToRemove) external {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (!isSigner[signerToRemove]) revert SignerNotFound();
        if (signers.length - 1 < threshold) revert InvalidThreshold();

        isSigner[signerToRemove] = false;

        for (uint256 i = 0; i < signers.length; i++) {
            if (signers[i] == signerToRemove) {
                signers[i] = signers[signers.length - 1];
                signers.pop();
                break;
            }
        }

        emit SignerRemoved(signerToRemove);
    }

    /// @notice Update the approval threshold.
    /// @param newThreshold The new threshold value.
    /// @dev Access: Caller permissions are checked against the sender or assigned roles.
    /// @dev Reverts: `NotSigner` if `!isSigner[msg.sender]` is true. `InvalidThreshold` if
    ///     `newThreshold == 0 || newThreshold > signers.length` is true.
    function updateThreshold(uint256 newThreshold) external {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (newThreshold == 0 || newThreshold > signers.length) revert InvalidThreshold();

        threshold = newThreshold;
        emit ThresholdUpdated(newThreshold);
    }

    /// @notice Create a new transaction for approval.
    /// @param target The target address to call.
    /// @param value The amount of ETH to send.
    /// @param data The encoded function call.
    /// @return txId The ID of the created transaction.
    /// @dev Access: Caller permissions are checked against the sender or assigned roles.
    /// @dev Reverts: `NotSigner` if `!isSigner[msg.sender]` is true. `InvalidTransaction` if `target
    ///     == address(0)` is true.
    function createTransaction(address target, uint256 value, bytes calldata data)
        external
        returns (uint256 txId)
    {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (target == address(0)) revert InvalidTransaction();

        txId = transactionCount++;

        transactions[txId] = Transaction({
            id: txId,
            target: target,
            value: value,
            data: data,
            approvalCount: 0,
            rejectionCount: 0,
            status: TransactionStatus.PENDING,
            createdAt: block.timestamp,
            executedAt: 0
        });

        emit TransactionCreated(txId, msg.sender, target);
    }

    /// @notice Approve a transaction.
    /// @param txId The ID of the transaction to approve.
    /// @dev Access: Caller permissions are checked against the sender or assigned roles.
    /// @dev Reverts: `NotSigner` if `!isSigner[msg.sender]` is true. `TransactionNotFound` if `txId
    ///     >= transactionCount` is true. `InvalidTransaction` if `transaction.status !=
    ///     TransactionStatus.PENDING` is true. `InvalidTransaction` if
    ///     `approvals[txId][msg.sender]` is true.
    function approveTransaction(uint256 txId) external {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (txId >= transactionCount) revert TransactionNotFound();

        Transaction storage transaction = transactions[txId];
        if (transaction.status != TransactionStatus.PENDING) revert TransactionNotPending();
        if (approvals[txId][msg.sender]) revert InvalidTransaction();

        approvals[txId][msg.sender] = true;
        transaction.approvalCount++;

        if (transaction.approvalCount >= threshold) {
            transaction.status = TransactionStatus.APPROVED;
        }

        emit TransactionApproved(txId, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    /// @notice Revert with the provided return data, preserving the original revert reason.
    function _revertWithReason(bytes memory returndata) internal pure {
        assembly ("memory-safe") {
            revert(add(returndata, 0x20), mload(returndata))
        }
    }

    /// @notice Execute an approved transaction.
    /// @param txId The ID of the transaction to execute.
    /// @dev Access: Caller permissions are checked against the sender or assigned roles.
    /// @dev Reverts: `NotSigner` if `!isSigner[msg.sender]` is true. `TransactionNotFound` if `txId
    ///     >= transactionCount` is true. `InsufficientApprovals` if `transaction.status !=
    ///     TransactionStatus.APPROVED` is true. `TransactionAlreadyExecuted` if
    ///     `transaction.executedAt != 0` is true. Preserves target revert reason if execution fails.
    function executeTransaction(uint256 txId) external {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (txId >= transactionCount) revert TransactionNotFound();

        Transaction storage transaction = transactions[txId];
        if (transaction.status != TransactionStatus.APPROVED) revert InsufficientApprovals();
        if (transaction.executedAt != 0) revert TransactionAlreadyExecuted();

        transaction.status = TransactionStatus.EXECUTED;
        transaction.executedAt = block.timestamp;

        // Use low-level call with revert data preservation
        (bool success, bytes memory returndata) = transaction.target.call{value: transaction.value}(transaction.data);
        if (!success) {
            _revertWithReason(returndata);
        }

        emit TransactionExecuted(txId, msg.sender);
    }

    /// @notice Reject a pending transaction. Requires rejectionThreshold rejections to fully reject.
    /// @param txId The ID of the transaction to reject.
    /// @dev Access: Caller permissions are checked against the sender or assigned roles.
    /// @dev Reverts: `NotSigner` if `!isSigner[msg.sender]` is true. `TransactionNotFound` if `txId
    ///     >= transactionCount` is true. `TransactionNotPending` if `transaction.status !=
    ///     TransactionStatus.PENDING` is true. `InvalidTransaction` if `rejections[txId][msg.sender]`
    ///     is true.
    function rejectTransaction(uint256 txId) external {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (txId >= transactionCount) revert TransactionNotFound();

        Transaction storage transaction = transactions[txId];
        if (transaction.status != TransactionStatus.PENDING) revert TransactionNotPending();
        if (rejections[txId][msg.sender]) revert InvalidTransaction();

        rejections[txId][msg.sender] = true;
        transaction.rejectionCount++;

        if (transaction.rejectionCount >= rejectionThreshold) {
            transaction.status = TransactionStatus.REJECTED;
            emit TransactionRejected(txId);
        }
    }

    /// @notice Get transaction details.
    /// @param txId The ID of the transaction.
    /// @return transaction The transaction struct.
    /// @dev Access: No caller-specific access restriction is imposed.
    /// @dev Reverts: `TransactionNotFound` if `txId >= transactionCount` is true.
    function getTransaction(uint256 txId) external view returns (Transaction memory transaction) {
        if (txId >= transactionCount) revert TransactionNotFound();
        return transactions[txId];
    }

    /// @notice Get all signers.
    /// @return The array of signer addresses.
    /// @dev Access: No caller-specific access restriction is imposed.
    function getSigners() external view returns (address[] memory) {
        return signers;
    }

    /// @notice Get the number of signers.
    /// @return The count of signers.
    /// @dev Access: No caller-specific access restriction is imposed.
    function getSignerCount() external view returns (uint256) {
        return signers.length;
    }

    /// @notice Check if an address is a signer.
    /// @param account The address to check.
    /// @return True if the address is a signer.
    /// @dev Access: No caller-specific access restriction is imposed.
    function checkSigner(address account) external view returns (bool) {
        return isSigner[account];
    }

    /// @notice Get approval status for a transaction.
    /// @param txId The ID of the transaction.
    /// @param signer The signer address to check.
    /// @return True if the signer has approved the transaction.
    /// @dev Access: No caller-specific access restriction is imposed.
    /// @dev Reverts: `TransactionNotFound` if `txId >= transactionCount` is true.
    function hasApproved(uint256 txId, address signer) external view returns (bool) {
        if (txId >= transactionCount) revert TransactionNotFound();
        return approvals[txId][signer];
    }

    /// @notice Check if a signer has rejected a transaction.
    /// @param txId The ID of the transaction.
    /// @param signer The signer address to check.
    /// @return True if the signer has rejected the transaction.
    /// @dev Access: No caller-specific access restriction is imposed.
    /// @dev Reverts: `TransactionNotFound` if `txId >= transactionCount` is true.
    function hasRejected(uint256 txId, address signer) external view returns (bool) {
        if (txId >= transactionCount) revert TransactionNotFound();
        return rejections[txId][signer];
    }

    /// @notice Get the rejection threshold.
    /// @return The rejection threshold value.
    /// @dev Access: No caller-specific access restriction is imposed.
    function getRejectionThreshold() external view returns (uint256) {
        return rejectionThreshold;
    }

    /// @notice Get the rejection count for a transaction.
    /// @param txId The ID of the transaction.
    /// @return The number of rejections for the transaction.
    /// @dev Access: No caller-specific access restriction is imposed.
    /// @dev Reverts: `TransactionNotFound` if `txId >= transactionCount` is true.
    function getRejectionCount(uint256 txId) external view returns (uint256) {
        if (txId >= transactionCount) revert TransactionNotFound();
        return transactions[txId].rejectionCount;
    }

    /// @notice Update the rejection threshold.
    /// @param newRejectionThreshold The new rejection threshold value.
    /// @dev Access: Caller permissions are checked against the sender or assigned roles.
    /// @dev Reverts: `NotSigner` if `!isSigner[msg.sender]` is true. `InvalidThreshold` if
    ///     `newRejectionThreshold == 0 || newRejectionThreshold > signers.length` is true.
    function updateRejectionThreshold(uint256 newRejectionThreshold) external {
        if (!isSigner[msg.sender]) revert NotSigner();
        if (newRejectionThreshold == 0 || newRejectionThreshold > signers.length) revert InvalidThreshold();

        rejectionThreshold = newRejectionThreshold;
        emit ThresholdUpdated(newRejectionThreshold);
    }

    // -------------------------------------------------------------------------
    // Receive function
    // -------------------------------------------------------------------------
    receive() external payable {}
}
