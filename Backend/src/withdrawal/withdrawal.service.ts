import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import {
  WithdrawalRecord,
  WithdrawalStatus,
  MultiSigWithdrawal,
} from './withdrawal.entity';
import {
  InitiateWithdrawalDto,
  SubmitWithdrawalTxHashDto,
  MultiSigSignatureDto,
  WithdrawalQueryDto,
} from './dto/withdrawal.dto';

const ERC20_TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

const NATIVE_SENTINEL = 'NATIVE';
const DEFAULT_REQUIRED_CONFIRMATIONS = 12;

/** Maximum value expressible as EVM uint256 (2^256 − 1). */
const UINT256_MAX = 2n ** 256n - 1n;

/**
 * Canonical-integer regex: one or more decimal digits, no leading zeros (except
 * the bare "0" itself is rejected later by the > 0 check), no sign, no decimal
 * point, no whitespace.
 */
const CANONICAL_INT_RE = /^(?:0|[1-9]\d*)$/;

@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);
  private readonly withdrawals = new Map<string, WithdrawalRecord>();
  private readonly multiSigs = new Map<string, MultiSigWithdrawal>();
  private readonly provider: ethers.JsonRpcProvider;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = this.config.get<string>(
      'BLOCKCHAIN_RPC_URL',
      'https://rpc.mantle.xyz',
    );
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Validate and register a new withdrawal request.
   * Returns the unsigned transaction payload for the client to broadcast,
   * along with the created withdrawal record.
   */
  initiateWithdrawal(
    userId: string,
    dto: InitiateWithdrawalDto,
  ): {
    withdrawalId: string;
    txData: object | null;
    multiSigId?: string;
    record: WithdrawalRecord;
  } {
    const fromAddress = this.checksumAddress(dto.fromAddress);
    const toAddress = this.checksumAddress(dto.toAddress);
    const isNative =
      dto.tokenAddress.toUpperCase() === NATIVE_SENTINEL.toUpperCase();
    const tokenAddress = isNative
      ? NATIVE_SENTINEL
      : this.checksumAddress(dto.tokenAddress);

    this.validateAmount(dto.amount);
    this.validateSelfTransfer(fromAddress, toAddress);

    const hasMultiSig =
      dto.multiSigThreshold != null &&
      dto.multiSigThreshold > 0 &&
      dto.multiSigSigners?.length;

    if (hasMultiSig) {
      const signers = dto.multiSigSigners!.map((s) => this.checksumAddress(s));
      if (!signers.includes(fromAddress)) {
        throw new BadRequestException(
          'fromAddress must be one of the multiSigSigners',
        );
      }
      if (dto.multiSigThreshold! > signers.length) {
        throw new BadRequestException(
          'multiSigThreshold cannot exceed the number of signers',
        );
      }
      // Multi-sig withdrawals MUST supply chainId and expiry so that approval
      // messages are chain-scoped and time-bounded.
      if (!dto.chainId) {
        throw new BadRequestException(
          'chainId is required for multi-sig withdrawals',
        );
      }
      if (!dto.expiry || dto.expiry <= Math.floor(Date.now() / 1000)) {
        throw new BadRequestException(
          'expiry must be a future Unix timestamp (seconds) for multi-sig withdrawals',
        );
      }
    }

    const record: WithdrawalRecord = {
      id: randomUUID(),
      userId,
      fromAddress,
      toAddress,
      tokenAddress,
      amount: dto.amount,
      chainId: dto.chainId ?? 0,
      expiry: dto.expiry ?? 0,
      status: 'pending',
      confirmations: 0,
      requiredConfirmations: DEFAULT_REQUIRED_CONFIRMATIONS,
      createdAt: new Date(),
    };

    let multiSigId: string | undefined;

    if (hasMultiSig) {
      const signers = dto.multiSigSigners!.map((s) => this.checksumAddress(s));
      const multiSig: MultiSigWithdrawal = {
        id: randomUUID(),
        withdrawalId: record.id,
        threshold: dto.multiSigThreshold!,
        signers,
        signatures: {},
        status: 'pending',
        createdAt: new Date(),
      };
      this.multiSigs.set(multiSig.id, multiSig);
      record.multiSigId = multiSig.id;
      multiSigId = multiSig.id;
    }

    const txData = this.buildTxData(
      fromAddress,
      toAddress,
      tokenAddress,
      dto.amount,
      isNative,
    );

    this.withdrawals.set(record.id, record);
    this.logger.log(
      `Withdrawal ${record.id} initiated by user ${userId} [${dto.amount} ${tokenAddress}]`,
    );

    return { withdrawalId: record.id, txData, multiSigId, record };
  }

  /**
   * Submit the on-chain tx hash once the client has broadcast the transaction.
   * Starts asynchronous confirmation tracking.
   */
  async submitTxHash(
    withdrawalId: string,
    userId: string,
    dto: SubmitWithdrawalTxHashDto,
  ): Promise<WithdrawalRecord> {
    const record = this.getWithdrawalOrThrow(withdrawalId);
    this.assertOwner(record, userId);

    if (record.status !== 'pending') {
      throw new BadRequestException(
        `Withdrawal ${withdrawalId} is already ${record.status}`,
      );
    }

    if (record.multiSigId) {
      const ms = this.multiSigs.get(record.multiSigId);
      if (ms && ms.status !== 'ready' && ms.status !== 'executed') {
        throw new BadRequestException(
          'Multi-sig threshold has not been reached yet — collect all required signatures first',
        );
      }
    }

    record.txHash = dto.txHash;
    record.status = 'submitted';
    record.submittedAt = new Date();
    this.withdrawals.set(withdrawalId, record);

    // fire-and-forget confirmation tracking
    this.trackConfirmations(withdrawalId, dto.txHash).catch((err) =>
      this.logger.error(
        `Confirmation tracking failed for ${withdrawalId}`,
        err,
      ),
    );

    return record;
  }

  /**
   * Return current status of a withdrawal, refreshing on-chain state when
   * a tx hash is present but not yet confirmed.
   */
  async getStatus(
    withdrawalId: string,
    userId: string,
  ): Promise<WithdrawalRecord> {
    const record = this.getWithdrawalOrThrow(withdrawalId);
    this.assertOwner(record, userId);

    if (
      record.txHash &&
      record.status !== 'confirmed' &&
      record.status !== 'failed'
    ) {
      await this.refreshConfirmations(record);
    }

    return record;
  }

  /** List all withdrawals for the authenticated user, optionally filtered by status. */
  listWithdrawals(
    userId: string,
    query: WithdrawalQueryDto,
  ): WithdrawalRecord[] {
    let results = [...this.withdrawals.values()].filter(
      (w) => w.userId === userId,
    );

    if (query.status) {
      const normalised = query.status.toLowerCase() as WithdrawalStatus;
      results = results.filter((w) => w.status === normalised);
    }

    return results.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /** Cancel a pending withdrawal that has not yet been submitted on-chain.
   *  Atomically marks any linked multi-sig record as 'rejected' so that no
   *  further signatures can be added after cancellation.
   */
  cancelWithdrawal(withdrawalId: string, userId: string): WithdrawalRecord {
    const record = this.getWithdrawalOrThrow(withdrawalId);
    this.assertOwner(record, userId);

    if (record.status !== 'pending') {
      throw new BadRequestException(
        `Only pending withdrawals can be cancelled; current status: ${record.status}`,
      );
    }

    // Atomically cancel the withdrawal and reject the linked multisig so that
    // addMultiSigSignature cannot advance approval state on a cancelled intent.
    record.status = 'cancelled';
    this.withdrawals.set(withdrawalId, record);

    if (record.multiSigId) {
      const ms = this.multiSigs.get(record.multiSigId);
      if (ms && ms.status !== 'executed' && ms.status !== 'rejected') {
        ms.status = 'rejected';
        this.multiSigs.set(ms.id, ms);
        this.logger.log(
          `MultiSig ${ms.id} rejected due to cancellation of withdrawal ${withdrawalId}`,
        );
      }
    }

    this.logger.log(`Withdrawal ${withdrawalId} cancelled by user ${userId}`);
    return record;
  }

  // ── Multi-sig ──────────────────────────────────────────────────────────────

  /** Add one signer's signature. Once threshold is reached, status flips to 'ready'. */
  addMultiSigSignature(
    withdrawalId: string,
    userId: string,
    dto: MultiSigSignatureDto,
  ): MultiSigWithdrawal {
    const record = this.getWithdrawalOrThrow(withdrawalId);
    this.assertOwner(record, userId);

    // Issue 4 fix: reject new approvals on any non-pending withdrawal lifecycle
    // state so that cancelled, failed, or already-confirmed withdrawals cannot
    // continue accumulating signatures.
    if (record.status !== 'pending') {
      throw new BadRequestException(
        `Cannot add signatures to a withdrawal that is already ${record.status}`,
      );
    }

    if (!record.multiSigId) {
      throw new BadRequestException(
        `Withdrawal ${withdrawalId} is not a multi-sig withdrawal`,
      );
    }

    const ms = this.multiSigs.get(record.multiSigId);
    if (!ms) {
      throw new NotFoundException(
        `MultiSig record ${record.multiSigId} not found`,
      );
    }

    if (ms.status === 'executed' || ms.status === 'rejected') {
      throw new BadRequestException(`MultiSig is already ${ms.status}`);
    }

    const signerAddress = this.checksumAddress(dto.signerAddress);

    if (!ms.signers.includes(signerAddress)) {
      throw new ForbiddenException(
        `${signerAddress} is not a registered signer for this multi-sig`,
      );
    }

    if (ms.signatures[signerAddress]) {
      throw new BadRequestException(
        `Signature from ${signerAddress} already recorded`,
      );
    }

    // Issue 2 fix: verify the signer signed the full structured intent (not just
    // the withdrawal id), so the signature binds destination, asset, amount,
    // chain and expiry.
    this.verifyMultiSigSignature(withdrawalId, dto.signature, signerAddress, record);

    ms.signatures[signerAddress] = dto.signature;

    const collectedCount = Object.keys(ms.signatures).length;
    if (collectedCount >= ms.threshold) {
      ms.status = 'ready';
      this.logger.log(
        `MultiSig ${ms.id} reached threshold (${collectedCount}/${ms.threshold}) — withdrawal ${withdrawalId} is ready`,
      );
    }

    this.multiSigs.set(ms.id, ms);
    return ms;
  }

  getMultiSigStatus(
    withdrawalId: string,
    userId: string,
  ): MultiSigWithdrawal & { signaturesCollected: number } {
    const record = this.getWithdrawalOrThrow(withdrawalId);
    this.assertOwner(record, userId);

    if (!record.multiSigId) {
      throw new BadRequestException(
        `Withdrawal ${withdrawalId} is not a multi-sig withdrawal`,
      );
    }

    const ms = this.multiSigs.get(record.multiSigId);
    if (!ms) {
      throw new NotFoundException(`MultiSig ${record.multiSigId} not found`);
    }

    return { ...ms, signaturesCollected: Object.keys(ms.signatures).length };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildTxData(
    from: string,
    to: string,
    tokenAddress: string,
    amount: string,
    isNative: boolean,
  ): object | null {
    if (isNative) {
      return {
        from,
        to,
        value: `0x${BigInt(amount).toString(16)}`,
      };
    }

    try {
      const iface = new ethers.Interface(ERC20_TRANSFER_ABI);
      const data = iface.encodeFunctionData('transfer', [to, BigInt(amount)]);
      return { from, to: tokenAddress, data, value: '0x0' };
    } catch {
      // if encoding fails due to bad inputs, surface at service boundary
      throw new BadRequestException(
        'Failed to encode ERC-20 transfer calldata',
      );
    }
  }

  private async trackConfirmations(
    withdrawalId: string,
    txHash: string,
  ): Promise<void> {
    const record = this.withdrawals.get(withdrawalId);
    if (!record) return;

    try {
      const receipt = await this.provider.waitForTransaction(
        txHash,
        record.requiredConfirmations,
      );

      if (!receipt) {
        record.status = 'failed';
        record.failureReason = 'Transaction not found on-chain';
        this.withdrawals.set(withdrawalId, record);
        return;
      }

      if (receipt.status === 0) {
        record.status = 'failed';
        record.failureReason = 'Transaction reverted on-chain';
      } else {
        record.status = 'confirmed';
        record.confirmations = record.requiredConfirmations;
        record.blockNumber = receipt.blockNumber;
        record.confirmedAt = new Date();
      }

      this.withdrawals.set(withdrawalId, record);
      this.logger.log(
        `Withdrawal ${withdrawalId} status updated to ${record.status}`,
      );
    } catch (err) {
      this.logger.error(
        `Error tracking confirmations for ${withdrawalId}`,
        err,
      );
      record.status = 'failed';
      record.failureReason =
        err instanceof Error ? err.message : 'Unknown error';
      this.withdrawals.set(withdrawalId, record);
    }
  }

  private async refreshConfirmations(record: WithdrawalRecord): Promise<void> {
    if (!record.txHash) return;

    try {
      const receipt = await this.provider.getTransactionReceipt(record.txHash);
      if (!receipt) return;

      const currentBlock = await this.provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber + 1;
      record.confirmations = Math.max(0, confirmations);
      record.blockNumber = receipt.blockNumber;

      if (receipt.status === 0) {
        record.status = 'failed';
        record.failureReason = 'Transaction reverted on-chain';
      } else if (record.confirmations >= record.requiredConfirmations) {
        record.status = 'confirmed';
        record.confirmedAt = record.confirmedAt ?? new Date();
      }

      this.withdrawals.set(record.id, record);
    } catch (err) {
      this.logger.warn(
        `Could not refresh confirmations for ${record.id}: ${err}`,
      );
    }
  }

  private verifyMultiSigSignature(
    withdrawalId: string,
    signature: string,
    expectedSigner: string,
    record: WithdrawalRecord,
  ): void {
    // Reject expired approval messages before verifying the signature.
    if (record.expiry > 0 && Math.floor(Date.now() / 1000) > record.expiry) {
      throw new BadRequestException(
        'Withdrawal approval has expired; a new withdrawal must be created',
      );
    }

    // Build a structured message that binds every immutable field of the
    // withdrawal intent.  A signature over this message cannot authorize a
    // different destination, asset, amount, chain, or request — and it expires
    // at the recorded timestamp so stale approvals are never replayable.
    //
    // Fields are serialised with a deterministic sorted-key array so client
    // and server always produce the same string regardless of insertion order.
    const KEY_ORDER = [
      'amount',
      'chainId',
      'domain',
      'expiry',
      'fromAddress',
      'toAddress',
      'tokenAddress',
      'withdrawalId',
    ] as const;

    const intent = JSON.stringify(
      {
        domain: 'GateDelay-withdrawal-v1',
        chainId: record.chainId,
        withdrawalId,
        fromAddress: record.fromAddress,
        toAddress: record.toAddress,
        tokenAddress: record.tokenAddress,
        amount: record.amount,
        expiry: record.expiry,
      },
      KEY_ORDER,
    );

    try {
      const recovered = ethers.verifyMessage(intent, signature);
      if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
        throw new BadRequestException(
          `Signature does not match signer ${expectedSigner}`,
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid signature format');
    }
  }

  /**
   * Build the canonical approval message for a withdrawal.
   *
   * **Clients MUST display every field in `fields` to the signer before
   * requesting a signature.**  Signing a message that omits any of these
   * fields means the signer cannot verify what they are authorising.
   *
   * The returned `message` string is exactly what `ethers.signMessage` /
   * `personal_sign` must be called with.  Any deviation will cause server-side
   * signature verification to fail.
   *
   * Issue 3 note: multi-sig withdrawals in this service are an **off-chain
   * approval workflow**.  The `txData` returned by `initiateWithdrawal` is a
   * plain single-owner transfer; it does not route through an on-chain
   * multi-sig contract.  To enforce an on-chain threshold, callers must submit
   * `txData` to a Gnosis Safe or equivalent multi-sig contract rather than
   * broadcasting it directly.  This service tracks off-chain signer consent
   * only and must not be represented as providing on-chain multi-sig
   * authorization.
   */
  buildApprovalMessage(record: WithdrawalRecord): {
    fields: {
      domain: string;
      chainId: number;
      withdrawalId: string;
      fromAddress: string;
      toAddress: string;
      tokenAddress: string;
      amount: string;
      expiry: number;
    };
    message: string;
  } {
    const KEY_ORDER = [
      'amount',
      'chainId',
      'domain',
      'expiry',
      'fromAddress',
      'toAddress',
      'tokenAddress',
      'withdrawalId',
    ] as const;

    const fields = {
      domain: 'GateDelay-withdrawal-v1' as const,
      chainId: record.chainId,
      withdrawalId: record.id,
      fromAddress: record.fromAddress,
      toAddress: record.toAddress,
      tokenAddress: record.tokenAddress,
      amount: record.amount,
      expiry: record.expiry,
    };

    const message = JSON.stringify(fields, KEY_ORDER);

    return { fields, message };
  }

  private checksumAddress(address: string): string {
    try {
      return ethers.getAddress(address);
    } catch {
      throw new BadRequestException(`Invalid Ethereum address: ${address}`);
    }
  }

  private validateAmount(amount: string): void {
    // Reject non-canonical representations before any BigInt conversion:
    // no leading zeros, no sign prefix, no decimal point, no whitespace,
    // no hex/octet/exponential notation (BigInt() would otherwise accept them).
    if (typeof amount !== 'string' || !CANONICAL_INT_RE.test(amount)) {
      throw new BadRequestException(
        'Amount must be a canonical decimal integer string with no leading zeros, sign, or decimal point',
      );
    }

    let parsed: bigint;
    try {
      parsed = BigInt(amount);
    } catch {
      throw new BadRequestException(
        'Amount must be a valid positive integer string (in smallest unit)',
      );
    }

    if (parsed <= 0n) {
      throw new BadRequestException('Amount must be greater than zero');
    }

    if (parsed > UINT256_MAX) {
      throw new BadRequestException(
        'Amount exceeds maximum uint256 value and cannot be encoded on-chain',
      );
    }
  }

  private validateSelfTransfer(from: string, to: string): void {
    if (from.toLowerCase() === to.toLowerCase()) {
      throw new BadRequestException('fromAddress and toAddress must differ');
    }
  }

  private getWithdrawalOrThrow(withdrawalId: string): WithdrawalRecord {
    const record = this.withdrawals.get(withdrawalId);
    if (!record) {
      throw new NotFoundException(`Withdrawal ${withdrawalId} not found`);
    }
    return record;
  }

  private assertOwner(record: WithdrawalRecord, userId: string): void {
    if (record.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
  }
}
