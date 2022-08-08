import dotenv from "dotenv";
import Queue from "bull";
import KeyManagerContract from "@lukso/lsp-smart-contracts/artifacts/LSP6KeyManager.json";
import UniversalProfileContract from "@lukso/lsp-smart-contracts/artifacts/UniversalProfile.json";
import PG from "pg-promise";
import { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import Quota from "../../types/quota";

const CHAIN_ID = process.env.CHAIN_ID;
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PK;
const transactionQueue = new Queue("transaction-execution", {
  redis: { port: 6379, host: process.env.REDIS_HOST },
});
dotenv.config();

export async function execute(req: Request, res: Response, next: NextFunction) {
  try {
    const address: string = req.body.address;
    const nonce: string = req.body.transaction.nonce;
    const abi: string = req.body.transaction.abi;
    const signature: string = req.body.transaction.signature;
    validateExecuteParams(address, nonce, abi, signature);

    const db = req.app.get("db");
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);

    const universalProfileContract = new ethers.Contract(
      address,
      UniversalProfileContract.abi,
      wallet
    );
    const keyManagerAddress = await universalProfileContract.owner();
    const keyManager = new ethers.Contract(
      keyManagerAddress,
      KeyManagerContract.abi,
      wallet
    );

    const estimatedGasBN = await keyManager.estimateGas.executeRelayCall(
      signature,
      nonce,
      abi
    );
    const estimatedGas = estimatedGasBN.toNumber();
    const quota = await ensureRemainingQuota(db, estimatedGas, address);
    const channelId = extractChannelId(nonce);

    const message = ethers.utils.solidityKeccak256(
      ["uint", "address", "uint", "bytes"],
      [CHAIN_ID, keyManagerAddress, nonce, abi]
    );

    // TODO: Double check that we need to arrayify here.
    const signerAddress = ethers.utils.verifyMessage(
      ethers.utils.arrayify(message),
      signature
    );

    const pendingWalletTransaction = await db.oneOrNone(
      "SELECT * FROM transactions WHERE relayer_address = $1 AND status = 'PENDING' ORDER BY relayer_nonce DESC LIMIT 1",
      [wallet.address]
    );

    let walletNonce: number;
    if (pendingWalletTransaction) {
      walletNonce = Number(pendingWalletTransaction.relayer_nonce) + 1;
    } else {
      walletNonce = await wallet.getTransactionCount();
    }

    let transaction;
    await db.tx(async (t: PG.ITask<{}>) => {
      transaction = await t.one(
        "INSERT INTO transactions(universal_profile_address, nonce, signature, abi, channel_id, status, signer_address, relayer_nonce, relayer_address) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
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
        ]
      );

      await t.none("UPDATE quotas SET gas_used = gas_used + $1 WHERE id = $2", [
        estimatedGas,
        quota.id,
      ]);
    });
    if (!transaction) throw "no transaction";

    // Calculate and return hash
    const unsignedTx = await keyManager.populateTransaction.executeRelayCall(
      signature,
      nonce,
      abi
    );

    const populatedUnsignedTx = await wallet.populateTransaction(unsignedTx);
    populatedUnsignedTx.nonce = walletNonce;
    const signedTx = await keyManager.signer.signTransaction(
      populatedUnsignedTx
    );
    const parsedTx = ethers.utils.parseTransaction(signedTx);

    transactionQueue.add({
      keyManagerAddress,
      transactionId: transaction["id"],
    });

    res.json({ transactionHash: parsedTx.hash });
  } catch (err) {
    console.log(err);
    next("Failed to execute");
  }
}

export async function quota(req: Request, res: Response, next: NextFunction) {
  try {
    const db = req.app.get("db");
    const { address, timestamp, signature } = req.body;

    const now = new Date().getTime();
    const timeDiff = now - timestamp;
    if (timeDiff > 5000 || timeDiff < -5000)
      throw "timestamp must be +/- 5 seconds";

    const message = ethers.utils.solidityKeccak256(
      ["address", "uint"],
      [address, timestamp]
    );

    // TODO: Should I add an owner address to the univeral profiles table?
    const signerAddress = ethers.utils.verifyMessage(
      ethers.utils.arrayify(message),
      signature
    );

    const transactionQuota = await db.task(async (t: PG.ITask<{}>) => {
      let transactionQuota;
      transactionQuota = await t.oneOrNone(
        "SELECT * FROM quotas WHERE universal_profile_address = $1",
        address
      );

      if (!transactionQuota) {
        transactionQuota = await t.one(
          "INSERT INTO quotas(universal_profile_address, monthly_gas, gas_used) VALUES($1, $2, $3) RETURNING *",
          [address, 650000, 0]
        );
      }
      return transactionQuota;
    });

    const date = new Date();
    const firstOfNextMonth = new Date(
      date.getFullYear(),
      date.getMonth() + 1,
      1
    );

    res.json({
      quota: transactionQuota.gas_used,
      unit: "gas",
      totalQuota: transactionQuota.monthly_gas,
      resetDate: firstOfNextMonth.getTime(),
    });
  } catch (err) {
    console.log(err);
    return next("failed to get quota");
  }
}

function validateExecuteParams(
  address: string,
  nonce: string,
  abi: string,
  sig: string
): void {
  if (address === undefined || address === "") throw "address must be present";
  if (nonce === undefined || nonce === "") throw "nonce must be present";
  if (abi === undefined || abi === "") throw "abi must be present";
  if (sig === undefined || sig === "") throw "signature must be present";
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
      quota = await t.one(
        "INSERT INTO quotas(universal_profile_address, monthly_gas, gas_used) VALUES($1, $2, $3) RETURNING *",
        [address, 650000, 0]
      );
      return quota;
    }

    if (quota.gas_used + estimatedGas <= quota.monthly_gas) return quota;

    // Making it here means they are out of gas on the main UP
    const approvedUniversalProfiles = await t.any(
      "SELECT * FROM approved_universal_profiles WHERE approved_address = $1",
      address
    );
    if (approvedUniversalProfiles.length === 0) throw "gas limit reached";

    // Get the quota of the UP that approved this UP
    for (let i = 0; i < approvedUniversalProfiles.length; i++) {
      quota = await t.oneOrNone(
        "SELECT * FROM quotas WHERE universal_profile_address = $1",
        approvedUniversalProfiles[i].approver_address
      );
      // Found a quota with enough gas to run the transaction
      if (quota.gas_used + estimatedGas <= quota.monthly_gas) break;
    }

    if (!quota) throw "gas limit reached";
    if (quota.gas_used + estimatedGas > quota.monthly_gas)
      throw "gas limit reached";
    return quota;
  });
}

function extractChannelId(nonce: string): number {
  const bn = ethers.BigNumber.from(nonce);
  return bn.shr(128).toNumber();
}