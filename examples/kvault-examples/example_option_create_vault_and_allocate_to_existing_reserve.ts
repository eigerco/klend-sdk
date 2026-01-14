import { getConnectionPool } from '../utils/connection';
import { getKeypair } from '../utils/keypair';
import { USDC_MINT, USDC_RESERVE_JLP_MARKET } from '../utils/constants';
import Decimal from 'decimal.js/decimal';
import {
    getMedianSlotDurationInMsFromLastEpochs,
    KaminoManager,
    KaminoVault,
    KaminoVaultConfig,
    Reserve,
    ReserveAllocationConfig,
    type ReserveWithAddress,
    sleep,
} from '@kamino-finance/klend-sdk';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { sendAndConfirmTx } from '../utils/tx';

/**
 * Option: Create your own vault that invests into existing reserves/markets
 * - You are the vault admin.
 * - You pick which existing reserves to allocate to.
 */
(async () => {
    const c = getConnectionPool();
    const admin = await getKeypair();

    const slotDuration = await getMedianSlotDurationInMsFromLastEpochs();
    const kaminoManager = new KaminoManager(c.rpc, slotDuration);

    // 1) Create the vault (USDC base token)
    const vaultConfig = new KaminoVaultConfig({
        admin,
        tokenMint: USDC_MINT,
        tokenMintProgramId: TOKEN_PROGRAM_ADDRESS,
        performanceFeeRatePercentage: new Decimal(1.0),
        managementFeeRatePercentage: new Decimal(2.0),
        name: 'example option create vault allocate existing reserve',
        vaultTokenSymbol: 'USDC',
        vaultTokenName: 'OptionCreateVaultAllocateExistingReserve',
    });

    const { vault: vaultKp, initVaultIxs } = await kaminoManager.createVaultIxs(vaultConfig);
    const vault = new KaminoVault(c.rpc, vaultKp.address);

    console.log('New vault:', vault.address);

    // Init vault + LUT + shares metadata (minimal init)
    await sendAndConfirmTx(
        c,
        admin,
        [...initVaultIxs.initVaultIxs, initVaultIxs.createLUTIx, initVaultIxs.initSharesMetadataIx],
        [vaultKp],
        [],
        'OptionCreateVaultAllocateExistingReserve-InitVault'
    );

    // LUT population is a separate tx
    await sleep(2000);
    await sendAndConfirmTx(c, admin, initVaultIxs.populateLUTIxs, [], [], 'OptionCreateVaultAllocateExistingReserve-PopulateLUT');

    // 2) Allocate to an EXISTING USDC reserve (example: USDC reserve in JLP market)
    const reserveState = await Reserve.fetch(c.rpc, USDC_RESERVE_JLP_MARKET);
    if (!reserveState) {
        throw new Error(`Reserve not found: ${USDC_RESERVE_JLP_MARKET}`);
    }

    const reserveWithAddress: ReserveWithAddress = {
        address: USDC_RESERVE_JLP_MARKET,
        state: reserveState,
    };

    // weight is relative; cap is in token units (USDC)
    const allocation = new ReserveAllocationConfig(reserveWithAddress, 100, new Decimal(1000));

    const setAllocIxs = await kaminoManager.updateVaultReserveAllocationIxs(vault, allocation);

    await sendAndConfirmTx(
        c,
        admin,
        [setAllocIxs.updateReserveAllocationIx, ...setAllocIxs.updateLUTIxs],
        [],
        [],
        'OptionCreateVaultAllocateExistingReserve-SetReserveAllocation'
    );

    console.log('Allocated vault to existing reserve:', USDC_RESERVE_JLP_MARKET);
})().catch(async (e) => {
    console.error(e);
});
