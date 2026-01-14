import { getConnectionPool } from '../utils/connection';
import { getKeypair } from '../utils/keypair';
import { USDC_MINT } from '../utils/constants';
import Decimal from 'decimal.js/decimal';
import {
    AssetReserveConfig,
    getAssociatedTokenAddress,
    getDefaultConfigParams,
    getMedianSlotDurationInMsFromLastEpochs,
    KaminoManager,
    KaminoVault,
    KaminoVaultConfig,
    LendingMarket,
    Reserve,
    ReserveAllocationConfig,
    sleep,
} from '@kamino-finance/klend-sdk';
import { address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { sendAndConfirmTx } from '../utils/tx';

/**
 * Option: Create your own lending market + add a reserve, then create a vault on top
 * - You are the market admin AND the vault admin.
 * - This is advanced: you must provide valid oracle configuration.
 *
 * Required env vars:
 * - `PYTH_PRICE` = Pyth price account for the asset you add (base58 address)
 *
 * Optional:
 * - `EXECUTE=true` to actually send transactions (default is dry-run).
 */
(async () => {
    const c = getConnectionPool();
    const admin = await getKeypair();

    const execute = (process.env.EXECUTE ?? 'false').toLowerCase() === 'true';
    const pythPriceStr = process.env.PYTH_PRICE;
    if (!pythPriceStr) {
        throw new Error('Missing env var PYTH_PRICE (Pyth price account address)');
    }

    const slotDuration = await getMedianSlotDurationInMsFromLastEpochs();
    const kaminoManager = new KaminoManager(c.rpc, slotDuration);

    // 1) Create a new lending market
    const { market, ixs: createMarketIxs } = await kaminoManager.createMarketIxs({ admin });
    console.log('New market:', market.address);

    if (execute) {
        await sendAndConfirmTx(c, admin, createMarketIxs, [market], [], 'OptionCreateMarketReserve-CreateMarket');
    } else {
        console.log('[dry-run] Would send createMarket tx with', createMarketIxs.length, 'ixs');
    }

    // Optionally, change default market params here . TODO to explore later
    // kaminoManager.updateLendingMarketIxs(market.address, market);

    // 2) Add an asset reserve (example uses USDC)
    // initReserve needs an `adminLiquiditySource` token account (ATA) for the mint.
    const adminUsdcAta = await getAssociatedTokenAddress(USDC_MINT, admin.address, TOKEN_PROGRAM_ADDRESS);

    const priceFeed = {
        pythPrice: address(pythPriceStr),
    };

    const defaults = getDefaultConfigParams();

    const assetConfig = new AssetReserveConfig({
        mint: USDC_MINT,
        mintTokenProgram: TOKEN_PROGRAM_ADDRESS,
        tokenName: 'USDC',
        mintDecimals: 6,
        priceFeed,
        loanToValuePct: defaults.loanToValuePct,
        liquidationThresholdPct: defaults.liquidationThresholdPct,
        borrowRateCurve: defaults.borrowRateCurve,
        depositLimit: new Decimal(1_000_000),
        borrowLimit: new Decimal(1_000_000),
    });

    const { reserve, txnIxs } = await kaminoManager.addAssetToMarketIxs({
        admin,
        adminLiquiditySource: adminUsdcAta,
        marketAddress: market.address,
        assetConfig,
    });

    console.log('New reserve:', reserve.address);

    if (execute) {
        // 2a) Create + init reserve (needs reserve signer)
        await sendAndConfirmTx(c, admin, txnIxs[0], [reserve], [], 'OptionCreateMarketReserve-CreateReserve');

        // 2b) Update reserve config (oracle, limits, etc)
        await sendAndConfirmTx(c, admin, txnIxs[1], [], [], 'OptionCreateMarketReserve-UpdateReserveConfig');
    } else {
        console.log('[dry-run] Would send reserve create tx with', txnIxs[0].length, 'ixs');
        console.log('[dry-run] Would send reserve update tx with', txnIxs[1].length, 'ixs');
    }

    // 3) Create a vault (base token = USDC) and allocate to the newly created reserve
    const vaultConfig = new KaminoVaultConfig({
        admin,
        tokenMint: USDC_MINT,
        tokenMintProgramId: TOKEN_PROGRAM_ADDRESS,
        performanceFeeRatePercentage: new Decimal(1.0),
        managementFeeRatePercentage: new Decimal(2.0),
        name: 'example option create market + reserve',
        vaultTokenSymbol: 'USDC',
        vaultTokenName: 'OptionCreateMarketReserve',
    });

    const { vault: vaultKp, initVaultIxs } = await kaminoManager.createVaultIxs(vaultConfig);
    const vault = new KaminoVault(c.rpc, vaultKp.address);
    console.log('New vault:', vault.address);

    if (execute) {
        await sendAndConfirmTx(
            c,
            admin,
            [...initVaultIxs.initVaultIxs, initVaultIxs.createLUTIx, initVaultIxs.initSharesMetadataIx],
            [vaultKp],
            [],
            'OptionB2-InitVault'
        );

        await sleep(2000);
        await sendAndConfirmTx(c, admin, initVaultIxs.populateLUTIxs, [], [], 'OptionCreateMarketReserve-PopulateLUT');

        const reserveState = await Reserve.fetch(c.rpc, reserve.address);
        if (!reserveState) {
            throw new Error(`Reserve not found after creation: ${reserve.address}`);
        }

        const alloc = new ReserveAllocationConfig({ address: reserve.address, state: reserveState }, 100, new Decimal(1000));
        const setAllocIxs = await kaminoManager.updateVaultReserveAllocationIxs(vault, alloc);

        await sendAndConfirmTx(
            c,
            admin,
            [setAllocIxs.updateReserveAllocationIx, ...setAllocIxs.updateLUTIxs],
            [],
            [],
            'OptionB2-SetReserveAllocation'
        );

        console.log('Allocated vault to new reserve:', reserve.address);
    } else {
        console.log('[dry-run] Vault + allocation steps are ready (set EXECUTE=true to run).');
    }
})().catch(async (e) => {
    console.error(e);
});
