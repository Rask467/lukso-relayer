import dotenv from "dotenv";
import {
  setUpKeyManager,
  getSignerAddress,
  estimateGas,
  getWalletNonce,
  calcHash,
} from "../../services/lukso";
import PG from "pg-promise";
import { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import Quota from "../../types/quota";
import txQueue from "../../jobs/transaction/queue";
import { checkSignerPermissions } from "../../utils";
import ArgumentError from "../../types/errors/argumentError";
import NoGasError from "../../types/errors/noGasError";
dotenv.config();

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PK;
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { upAddress } = req.params;
    const db = req.app.get("db");

    const transactions = await db.any(
      "SELECT * FROM transactions WHERE universal_profile_address = $1 ORDER BY created_at DESC",
      upAddress
    );

    res.json({ transactions });
  } catch (err) {
    console.log(err);
    next("failed to list transactions");
  }
}

export async function execute(req: Request, res: Response, next: NextFunction) {
  try {
    const address: string = req.body.address;
    const nonce: string = req.body.transaction?.nonce;
    const abi: string = req.body.transaction?.abi;
    const signature: string = req.body.transaction?.signature;
    validateExecuteParams(address, nonce, abi, signature);

    const db = req.app.get("db");
    const { kmAddress, keyManager } = await setUpKeyManager(address, wallet);
    const signerAddress = getSignerAddress(kmAddress, nonce, abi, signature);
    await checkSignerPermissions(address, signerAddress);
    const estimatedGas = await estimateGas(keyManager, signature, nonce, abi);
    if (!estimatedGas) throw "could not estimate gas";
    const quota = await ensureRemainingQuota(db, estimatedGas, address);
    const channelId = extractChannelId(nonce);
    const walletNonce = await getWalletNonce(db, wallet);
    const hash = await calcHash(
      keyManager,
      signature,
      nonce,
      abi,
      walletNonce,
      wallet
    );

    const transaction = await createTransaction(
      db,
      estimatedGas,
      quota,
      address,
      nonce,
      signature,
      abi,
      channelId,
      signerAddress,
      walletNonce,
      hash!
    );

    txQueue.add({
      kmAddress,
      transactionId: transaction["id"],
    });
    res.json({ transactionHash: hash });
  } catch (err) {
    console.log(err);
    if (err instanceof ArgumentError) {
      next(err.message);
    } else if (err instanceof NoGasError) {
      next(err.message);
    } else {
      next("Failed to execute");
    }
  }
}

async function createTransaction(
  db: any,
  estimatedGas: number,
  quota: Quota,
  address: string,
  nonce: string,
  signature: string,
  abi: string,
  channelId: number,
  signerAddress: string,
  walletNonce: number,
  hash: string
) {
  const transaction = await db.tx(async (t: PG.ITask<{}>) => {
    await t.none("UPDATE quotas SET gas_used = gas_used + $1 WHERE id = $2", [
      estimatedGas,
      quota.id,
    ]);

    const approvedQuota = await t.oneOrNone(
      "UPDATE approved_quotas SET gas_used = gas_used + $1 WHERE approved_address = $2 and approver_address = $3 RETURNING *",
      [estimatedGas, address, quota.universal_profile_address]
    );
    return await t.one(
      "INSERT INTO transactions(universal_profile_address, nonce, signature, abi, channel_id, status, signer_address, relayer_nonce, relayer_address, estimated_gas, gas_used, hash, approved_quota_id, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()) RETURNING *",
      [
        address,
        nonce,
        signature,
        abi,
        channelId,
        "PENDING",
        signerAddress,
        walletNonce,
        wallet.address,
        estimatedGas,
        0,
        hash,
        approvedQuota?.id,
      ]
    );
  });
  if (!transaction) throw "no transaction";
  return transaction;
}

export async function quota(req: Request, res: Response, next: NextFunction) {
  try {
    const db = req.app.get("db");
    const { address, timestamp, signature } = req.body;
    validateQuotaParams(address, timestamp, signature);

    const now = new Date().getTime();
    const timeDiff = now - timestamp;
    if (timeDiff > 5000 || timeDiff < -5000)
      throw new ArgumentError("timestamp must be +/- 5 seconds");

    const message = ethers.utils.solidityKeccak256(
      ["address", "uint"],
      [address, timestamp]
    );

    const signerAddress = ethers.utils.verifyMessage(
      ethers.utils.arrayify(message),
      signature
    );
    await checkSignerPermissions(address, signerAddress);

    const { transactionQuota, approvedQuotas, parentQuotas } = await db.task(
      async (t: PG.ITask<{}>) => {
        let transactionQuota;
        transactionQuota = await t.oneOrNone(
          "SELECT * FROM quotas WHERE universal_profile_address = $1",
          address
        );

        if (!transactionQuota) {
          // First check if the UP has been initialize and if not then initialize it.
          const up = await t.oneOrNone(
            "SELECT * from universal_profiles WHERE address = $1",
            address
          );

          if (!up) {
            await t.none(
              "INSERT INTO universal_profiles(address, created_at) VALUES($1, $2)",
              [address, new Date()]
            );
          }

          transactionQuota = await t.one(
            "INSERT INTO quotas(universal_profile_address, monthly_gas, gas_used) VALUES($1, $2, $3) RETURNING *",
            [address, 650000, 0]
          );
        }

        const approvedQuotas = await t.any(
          "SELECT * FROM approved_quotas WHERE approved_address = $1",
          address
        );
        let parentQuotas;
        if (approvedQuotas && approvedQuotas.length > 0) {
          const approverAddresses = approvedQuotas.map(
            (aup) => aup.approver_address
          );
          parentQuotas = await t.any(
            "SELECT * FROM quotas WHERE universal_profile_address IN ($1:csv)",
            [approverAddresses]
          );
        }
        return { transactionQuota, approvedQuotas, parentQuotas };
      }
    );

    let totalQuota = transactionQuota.monthly_gas;
    let gasUsed = transactionQuota.gas_used;
    if (approvedQuotas && approvedQuotas.length > 0) {
      approvedQuotas.forEach((aQuota: any) => {
        const parentQuota = parentQuotas.find(
          (pQuota: any) =>
            pQuota.universal_profile_address === aQuota.approver_address
        );
        if (!parentQuota) return;
        // Although this is an approved quota the parent doesn't have any gas to pay so we can't count it.
        if (parentQuota.gas_used >= parentQuota.monthly_gas) return;
        // Calculate how much of the approved quota the parent can afford.
        const parentGasRemaining =
          parentQuota.monthly_gas - parentQuota.gas_used;
        const approvedGasRemaining = aQuota.monthly_gas - aQuota.gas_used;
        if (parentGasRemaining >= approvedGasRemaining) {
          // Parent has enough gas to pay add all to the total
          totalQuota += aQuota.monthly_gas;
        } else {
          // Parent doesn't have enough to cover what they approved, but can still pay for some.
          totalQuota += parentGasRemaining;
        }
        gasUsed += aQuota.gas_used;
      });
    }

    const date = new Date();
    const firstOfNextMonth = new Date(
      date.getFullYear(),
      date.getMonth() + 1,
      1
    );

    res.json({
      quota: gasUsed,
      unit: "gas",
      totalQuota: totalQuota,
      resetDate: firstOfNextMonth.getTime(),
    });
  } catch (err) {
    console.log(err);
    if (err instanceof ArgumentError) {
      return next(err.message);
    } else {
      return next("failed to get quota");
    }
  }
}

function validateExecuteParams(
  address: string,
  nonce: string,
  abi: string,
  sig: string
): void {
  if (address === undefined || address === "")
    throw new ArgumentError("address must be present");
  if (nonce === undefined || nonce === "")
    throw new ArgumentError("nonce must be present");
  if (abi === undefined || abi === "")
    throw new ArgumentError("abi must be present");
  if (sig === undefined || sig === "")
    throw new ArgumentError("signature must be present");
}

function validateQuotaParams(
  address: string,
  timestamp: number,
  signature: string
) {
  if (address === undefined || address === "")
    throw new ArgumentError("address must be present");
  if (timestamp === undefined || timestamp === 0)
    throw new ArgumentError("timestamp must be present");
  if (signature === undefined || signature === "")
    throw new ArgumentError("signature must be present");
}

async function ensureRemainingQuota(
  db: PG.IDatabase<{}>,
  estimatedGas: number,
  address: string
): Promise<Quota> {
  return await db.task(async (t: PG.ITask<{}>) => {
    let quota = await t.oneOrNone(
      "SELECT * FROM quotas WHERE universal_profile_address = $1",
      address
    );

    if (!quota) {
      // Initialize a new quota for this UP.
      const up = await t.oneOrNone(
        "SELECT * FROM universal_profiles WHERE address = $1",
        address
      );
      if (!up) {
        await t.none(
          "INSERT INTO universal_profiles(address, created_at) VALUES($1, $2)",
          [address, new Date()]
        );
      }

      quota = await t.one(
        "INSERT INTO quotas(universal_profile_address, monthly_gas, gas_used) VALUES($1, $2, $3) RETURNING *",
        [address, 650000, 0]
      );
      return quota;
    }

    if (quota.gas_used + estimatedGas <= quota.monthly_gas) return quota;

    // Making it here means they are out of gas on the main UP
    const approvedQuotas = await t.any(
      "SELECT * FROM approved_quotas WHERE approved_address = $1",
      address
    );
    if (approvedQuotas.length === 0) throw new NoGasError("gas limit reached");

    // Get the quota of the UP that approved this UP
    for (let i = 0; i < approvedQuotas.length; i++) {
      if (
        approvedQuotas[i].gas_used + estimatedGas >=
        approvedQuotas[i].monthly_gas
      )
        continue;
      quota = await t.oneOrNone(
        "SELECT * FROM quotas WHERE universal_profile_address = $1",
        approvedQuotas[i].approver_address
      );
      // Found a quota with enough gas to run the transaction
      if (quota.gas_used + estimatedGas <= quota.monthly_gas) break;
    }

    if (!quota) throw new NoGasError("gas limit reached");
    if (quota.gas_used + estimatedGas > quota.monthly_gas)
      throw new NoGasError("gas limit reached");
    return quota;
  });
}

function extractChannelId(nonce: string): number {
  const bn = ethers.BigNumber.from(nonce);
  return bn.shr(128).toNumber();
}
