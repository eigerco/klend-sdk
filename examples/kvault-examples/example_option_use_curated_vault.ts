import { getConnectionPool } from '../utils/connection';
import { getKeypair } from '../utils/keypair';
import { EXAMPLE_USDC_VAULT } from '../utils/constants';
import Decimal from 'decimal.js/decimal';
import { getMedianSlotDurationInMsFromLastEpochs, KaminoManager, KaminoVault } from '@kamino-finance/klend-sdk';
import { sendAndConfirmTx } from '../utils/tx';

/**
 * Option: Use an existing curated vault
 * - You are NOT the admin.
 * - You just read info + deposit/withdraw.
 */
(async () => {
    const c = getConnectionPool();
    const user = await getKeypair();

    const slotDuration = await getMedianSlotDurationInMsFromLastEpochs();
    const kaminoManager = new KaminoManager(c.rpc, slotDuration);

    const vault = new KaminoVault(c.rpc, EXAMPLE_USDC_VAULT);
    const vaultState = await vault.getState();

    console.log('Vault:', vault.address);
    console.log('Base token mint:', vaultState.tokenMint);
    console.log('Shares mint:', vaultState.sharesMint);

    // Read user shares balances (unstaked + staked in vault farm, if any)
    const userSharesBefore = await kaminoManager.getUserSharesBalanceSingleVault(user.address, vault);
    console.log('User shares before:', userSharesBefore);

    // Read vault holdings (available/uninvested + invested breakdown)
    const holdingsBefore = await vault.getVaultHoldings();
    holdingsBefore.print();

    // Deposit a small amount (in token units, NOT lamports, will be converted internally) 
    const amountToDeposit = new Decimal(1);

    const depositIx = await kaminoManager.depositToVaultIxs(user, vault, amountToDeposit);

    await sendAndConfirmTx(
        c,
        user,
        [...depositIx.depositIxs, ...depositIx.stakeInFarmIfNeededIxs],
        [],
        [vaultState.vaultLookupTable],
        'Option-DepositToCuratedVault'
    );

    // Refresh shares + holdings
    const userSharesAfter = await kaminoManager.getUserSharesBalanceSingleVault(user.address, vault);
    console.log('User shares after:', userSharesAfter);

    const holdingsAfter = await vault.getVaultHoldings();
    holdingsAfter.print();
})().catch(async (e) => {
    console.error(e);
});
