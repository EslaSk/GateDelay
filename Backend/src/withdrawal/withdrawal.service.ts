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

/**
 * How many times trackConfirmations will retry after a recoverable provider
 * error before giving up and leaving the record in 'submitted' state for the
 * next manual reconciliation cycle.
 */
const MAX_TRACK_RETRIES = 5;

/**
 * Initial back-off in milliseconds (doubles on each retry, capped at 32 s).
 */
const TRACK_RETRY_BASE_MS = 2_000;

// ── Provider-error classification ─────────────────────────────────────────────

/**
 * Error patterns that indicate a transient RPC / transport problem.
 * Anything NOT in this set is treated as a terminal failure.
 */
const RECOVERABLE_ERROR_PATTERNS: RegExp[] = [
  /network/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /getaddrinfo/i,
  /server error/i,
  /rate.?limit/i,
  /429/,
  /503/,
  /504/,
  /could not detect network/i,
  /missing response/i,
  /underlying network changed/i,
];

function isRecoverableProviderError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  return RECOVERABLE_ERROR_PATTERNS.some((re) => re.test(message));
}

function backoffMs(attempt: number): number {
  return Math.min(TRACK_RETRY_BASE_MS * 2 ** attempt, 32_000);
}

// ── Pagination helpers ─────────────────────────────────────────────────────────

/**
 * A cursor encodes `${createdAt.toISOString()}|${id}` as a base-64 string so
 * it is opaque to callers and safe to pass through query strings.
 */
function encodeCursor(record: WithdrawalRecord): string {
  return Buffer.from(
    `${record.createdAt.toISOString()}|${record.id}`,
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): { ts: number; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const pipe = raw.lastIndexOf('|');
    if (pipe === -1) return null;
    const ts = Date.parse(raw.slice(0, pipe));
    if (Number.isNaN(ts)) return null;
    return { ts, id: raw.slice(pipe + 1) };
  } catch {
    return null;
  }
}

/** Stable sort key: earlier timestamp sorts first; ties broken by id (lexicographic). */
function compareAsc(a: WithdrawalRecord, b: WithdrawalRecord): number {
  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
  return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
}

// ── Page response type ─────────────────────────────────────────────────────────

export interface WithdrawalPage {
  data: WithdrawalRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ── Service ────────────────────────────────────────────────────────────────────

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
    }

    const record: WithdrawalRecord = {
      id: randomUUID(),
      userId,
      fromAddress,
      toAddress,
      tokenAddress,
      amount: dto.amount,
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

  /**
   * List withdrawals for the authenticated user with optional status filter
   * and keyset (cursor) pagination ordered by (createdAt ASC, id ASC).
   *
   * Returns a bounded page plus an opaque `nextCursor` the client passes back
   * to fetch the following page.  Concurrent inserts cannot displace records
   * across page boundaries because the cursor anchors on a stable composite key.
   */
  listWithdrawals(userId: string, query: WithdrawalQueryDto): WithdrawalPage {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);

    // 1. Filter by owner and optional status (DTO has already validated the value)
    const statusFilter = query.status
      ? (query.status.toLowerCase() as WithdrawalStatus)
      : undefined;

    let candidates = [...this.withdrawals.values()].filter(
      (w) =>
        w.userId === userId &&
        (statusFilter === undefined || w.status === statusFilter),
    );

    // 2. Sort ascending by (createdAt, id) — stable keyset order
    candidates.sort(compareAsc);

    // 3. Apply cursor: skip everything up to and including the cursor record
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (!decoded) {
        throw new BadRequestException('Invalid pagination cursor');
      }
      const { ts: cursorTs, id: cursorId } = decoded;
      const idx = candidates.findIndex(
        (w) =>
          w.createdAt.getTime() === cursorTs && w.id === cursorId,
      );
      if (idx !== -1) {
        candidates = candidates.slice(idx + 1);
      }
      // If not found the cursor record was removed; continue from the position
      // that would have followed it (first record strictly after the cursor ts/id).
      else {
        candidates = candidates.filter(
          (w) =>
            w.createdAt.getTime() > cursorTs ||
            (w.createdAt.getTime() === cursorTs &&
              w.id.localeCompare(cursorId) > 0),
        );
      }
    }

    // 4. Take one extra to detect whether another page exists
    const slice = candidates.slice(0, limit + 1);
    const hasMore = slice.length > limit;
    const data = hasMore ? slice.slice(0, limit) : slice;

    const nextCursor =
      hasMore && data.length > 0 ? encodeCursor(data[data.length - 1]) : null;

    return { data, nextCursor, hasMore };
  }

  /** Cancel a pending withdrawal that has not yet been submitted on-chain. */
  cancelWithdrawal(withdrawalId: string, userId: string): WithdrawalRecord {
    const record = this.getWithdrawalOrThrow(withdrawalId);
    this.assertOwner(record, userId);

    if (record.status !== 'pending') {
      throw new BadRequestException(
        `Only pending withdrawals can be cancelled; current status: ${record.status}`,
      );
    }

    record.status = 'cancelled';
    this.withdrawals.set(withdrawalId, record);
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

    // Verify the signer actually signed the withdrawal id
    this.verifyMultiSigSignature(withdrawalId, dto.signature, signerAddress);

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

  /**
   * Track on-chain confirmations for a submitted withdrawal.
   *
   * Error handling strategy
   * ─────────────────────────────────────────────────────────────────────────
   * • Recoverable (transport/RPC outage, rate-limit, etc.): retry with
   *   exponential back-off up to MAX_TRACK_RETRIES.  The record stays in
   *   'submitted' between attempts so a concurrent reconciliation pass can
   *   also pick it up.
   *
   * • Terminal on receipt: null receipt after provider timeout → 'failed'
   *   (transaction was dropped / never mined).
   *   receipt.status === 0 → 'failed' (EVM revert — definitive chain outcome).
   *
   * • Exhausted retries without a receipt: the record is left in 'submitted'
   *   (not 'failed') so the next reconciliation pass can retry cleanly once
   *   RPC is healthy again.
   */
  private async trackConfirmations(
    withdrawalId: string,
    txHash: string,
  ): Promise<void> {
    const record = this.withdrawals.get(withdrawalId);
    if (!record) return;

    let attempt = 0;

    while (attempt <= MAX_TRACK_RETRIES) {
      try {
        const receipt = await this.provider.waitForTransaction(
          txHash,
          record.requiredConfirmations,
        );

        // ── Terminal: provider confirmed the tx does not exist / was dropped ──
        if (!receipt) {
          record.status = 'failed';
          record.failureReason = 'Transaction not found on-chain (dropped or never mined)';
          this.withdrawals.set(withdrawalId, record);
          this.logger.warn(
            `Withdrawal ${withdrawalId} marked failed — no receipt returned`,
          );
          return;
        }

        // ── Terminal: EVM revert — receipt is authoritative ──────────────────
        if (receipt.status === 0) {
          record.status = 'failed';
          record.failureReason = 'Transaction reverted on-chain';
          this.withdrawals.set(withdrawalId, record);
          this.logger.warn(
            `Withdrawal ${withdrawalId} marked failed — EVM revert (block ${receipt.blockNumber})`,
          );
          return;
        }

        // ── Success ───────────────────────────────────────────────────────────
        record.status = 'confirmed';
        record.confirmations = record.requiredConfirmations;
        record.blockNumber = receipt.blockNumber;
        record.confirmedAt = new Date();
        this.withdrawals.set(withdrawalId, record);
        this.logger.log(
          `Withdrawal ${withdrawalId} confirmed at block ${receipt.blockNumber}`,
        );
        return;
      } catch (err) {
        if (isRecoverableProviderError(err)) {
          // Leave status as 'submitted' — do not mark failed.
          const delay = backoffMs(attempt);
          this.logger.warn(
            `Recoverable provider error tracking ${withdrawalId} ` +
              `(attempt ${attempt + 1}/${MAX_TRACK_RETRIES + 1}), ` +
              `retrying in ${delay} ms: ${(err as Error).message ?? err}`,
          );
          attempt += 1;
          if (attempt > MAX_TRACK_RETRIES) break;
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // Non-recoverable application-level error — surface immediately.
          this.logger.error(
            `Non-recoverable error tracking ${withdrawalId}`,
            err,
          );
          record.status = 'failed';
          record.failureReason =
            err instanceof Error ? err.message : 'Unknown error';
          this.withdrawals.set(withdrawalId, record);
          return;
        }
      }
    }

    // Retries exhausted — keep 'submitted' so reconciliation can resume.
    this.logger.error(
      `Tracking exhausted ${MAX_TRACK_RETRIES} retries for ${withdrawalId}. ` +
        `Record left in 'submitted' for reconciliation.`,
    );
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
  ): void {
    try {
      const message = `GateDelay withdrawal ${withdrawalId}`;
      const recovered = ethers.verifyMessage(message, signature);
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

  private checksumAddress(address: string): string {
    try {
      return ethers.getAddress(address);
    } catch {
      throw new BadRequestException(`Invalid Ethereum address: ${address}`);
    }
  }

  private validateAmount(amount: string): void {
    try {
      const parsed = BigInt(amount);
      if (parsed <= 0n) {
        throw new BadRequestException('Amount must be greater than zero');
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        'Amount must be a valid positive integer string (in smallest unit)',
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
