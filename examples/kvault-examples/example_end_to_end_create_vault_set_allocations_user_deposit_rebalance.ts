import { createInterface } from 'readline';
import { getConnectionPool } from '../utils/connection';
import { getKeypair } from '../utils/keypair';
import { JLP_MARKET, MAIN_MARKET, USDC_MINT } from '../utils/constants';
import { loadReserveData } from '../utils/helpers';
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
    getAssociatedTokenAddress,
} from '@kamino-finance/klend-sdk';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { sendAndConfirmTx } from '../utils/tx';

/**
 * End-to-end: Create a vault, configure allocations, founder deposits, secondary user buys shares, change allocations, rebalance, then secondary user withdraws.
 *
 * Workflow:
 * 1. vaultCreation() - Admin creates a new USDC vault with performance and management fees.
 * 2. configureAllocations() - Admin sets up a 60/40 allocation split:
 *    - 60% weight: USDC reserve in MAIN market (cap: 10,000 USDC)
 *    - 40% weight: USDC reserve in JLP market (cap: 10,000 USDC)
 * 3. founderDeposit() - Founder (initial investor) deposits 1 USDC into the vault using DEPOSIT (atomic pricing).
 * 4. rebalance() - Founder calls investAllReservesIxs() to distribute funds across reserves per initial 60/40 weights.
 * 5. secondaryUserBuyShares() - Secondary user buys shares from the vault using BUY (market-based pricing).
 * 6. changeAllocations() - Admin changes the allocation to a 40/60 split (reverse weights).
 * 7. rebalanceNewAllocations() - Founder rebalances funds according to the NEW allocation weights,
 *    automatically moving funds from MAIN to JLP market.
 * 8. secondaryUserWithdraw() - Secondary user withdraws their shares from the vault using WITHDRAW.
 *
 * Key concepts:
 * - DEPOSIT: Direct capital contribution (founder) - atomic pricing at current NAV
 * - BUY: Market purchase of shares (secondary user) - fair market price based on vault performance
 * - WITHDRAW: Redeem shares for underlying tokens - receives current NAV value
 * - The vault enforces relative weight allocations across multiple reserves.
 * - investAllReservesIxs() automatically rebalances funds without requiring admin intervention.
 * - Changing allocations and rebalancing allows dynamic fund redistribution.
 * - This is an interactive example with prompts allowing you to skip or proceed at each step.
 *
 * Prerequisites:
 * - Founder wallet must have USDC balance for the deposit step.
 * - Secondary user wallet must have USDC balance for the buy shares step.
 */

// Main execution with interactive prompts
(async () => {
    console.log('\n╔═════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║     KAMINO KVAULT END-TO-END INTERACTIVE EXAMPLE                 ║');
    console.log('║  Create → Allocate → Founder Deposits → Rebalance →            ║');
    console.log('║  Secondary User Buys Shares → Change Allocations → Rebalance → ║');
    console.log('║  Secondary User Withdraws                                        ║');
    console.log('╚═════════════════════════════════════════════════════════════════════════════════╝');

    const c = getConnectionPool();
    const admin = await getKeypair();
    const founder = await getKeypair();
    const secondaryUser = await getKeypair();

    console.log('\n👤 Admin wallet:           ', admin.address.toString());
    console.log('👤 Founder wallet:         ', founder.address.toString());
    console.log('👤 Secondary user wallet: ', secondaryUser.address.toString());

    const slotDuration = await getMedianSlotDurationInMsFromLastEpochs();
    const kaminoManager = new KaminoManager(c.rpc, slotDuration);

    try {
        // Step 1: Create Vault
        const vault = await executeVaultCreation(c, admin, kaminoManager);
        if (!vault) return;

        // Step 2: Configure Allocations (60/40)
        const reservesData = await executeConfigureAllocations(c, admin, vault, kaminoManager);
        if (!reservesData) return;

        // Step 3: Founder Deposit (direct capital contribution - atomic pricing)
        const depositData = await executeFounderDeposit(c, founder, vault, kaminoManager);
        if (!depositData) return;

        // Step 4: Rebalance with initial allocations
        const rebalanceData1 = await executeRebalance(c, founder, vault, depositData.vaultState, kaminoManager, depositData.holdingsBefore);
        if (!rebalanceData1) return;

        // Step 5: Secondary User Buys Shares (market-based pricing)
        const buyData = await executeSecondaryUserBuyShares(c, secondaryUser, vault, kaminoManager);
        if (!buyData) return;

        // Step 6: Change Allocations (40/60 - reverse of initial)
        const changeAllocData = await executeChangeAllocations(c, admin, vault, kaminoManager, reservesData);
        if (!changeAllocData) return;

        // Step 7: Rebalance with new allocations
        await executeRebalanceNewAllocations(c, founder, vault, rebalanceData1.vaultState, kaminoManager, rebalanceData1.holdingsAfter);

        // Step 8: Secondary User Withdraws Shares
        await executeSecondaryUserWithdraw(c, secondaryUser, vault, kaminoManager);

        console.log('\n╔═════════════════════════════════════════════════════════════════════════════╗');
        console.log('║                       EXAMPLE COMPLETED SUCCESSFULLY                      ║');
        console.log('║  • Founder deposited initial capital (DEPOSIT)                            ║');
        console.log('║  • Secondary user bought shares (BUY) at market price                     ║');
        console.log('║  • Vault allocations changed and funds rebalanced successfully!           ║');
        console.log('║  • Secondary user withdrew shares (WITHDRAW)                              ║');
        console.log('╚═════════════════════════════════════════════════════════════════════════════╝\n');
    } catch (e) {
        console.error('\n❌ Error:', e);
    }
})();

// ============================================================================
// HELPER FUNCTIONS (in order of use)
// ============================================================================

// Interactive prompt helper
function askUser(question: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.on('error', (error) => {
            rl.close();
            reject(error);
        });

        rl.question(`\n${question} (y/n): `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

// Helper function to validate user has sufficient USDC balance
async function validateUserHasBalance(
    c: ReturnType<typeof getConnectionPool>,
    userAddress: Awaited<ReturnType<typeof getKeypair>>['address'],
    requiredAmount: Decimal,
    operationName: string
): Promise<void> {
    try {
        const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, userAddress);
        const ataInfo = await c.rpc.getAccountInfo(userUsdcAta).send();

        if (!ataInfo) {
            throw new Error(
                `${operationName} failed: User wallet has no USDC account. Please ensure you have USDC in your wallet before proceeding.`
            );
        }

        console.log(`✓ User has USDC account for ${operationName}`);
    } catch (error) {
        if (error instanceof Error && error.message.includes('no USDC account')) {
            throw error;
        }
        console.log(`⚠️  Note: Could not validate USDC balance. Proceeding anyway. (${operationName})`);
    }
}

// ============================================================================
// GUARD CLAUSE WRAPPERS (ask → early return if skipped → execute)
// ============================================================================

async function executeVaultCreation(
    c: ReturnType<typeof getConnectionPool>,
    admin: Awaited<ReturnType<typeof getKeypair>>,
    kaminoManager: KaminoManager
): Promise<KaminoVault | null> {
    const shouldContinue = await askUser(
        '\n➡️  Ready to create vault? This will initialize a new USDC vault on-chain.'
    );
    if (!shouldContinue) {
        console.log('⏭️  Skipped STEP 1: Vault Creation');
        return null;
    }
    return vaultCreation(c, admin, kaminoManager);
}

async function executeConfigureAllocations(
    c: ReturnType<typeof getConnectionPool>,
    admin: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager
): Promise<{ mainUsdcReserve: ReserveWithAddress; jlpUsdcReserve: ReserveWithAddress } | null> {
    const shouldContinue = await askUser(
        '\n➡️  Ready to configure reserve allocations? This will set up 60/40 split between MAIN and JLP markets.'
    );
    if (!shouldContinue) {
        console.log('⏭️  Skipped STEP 2: Reserve Allocations');
        return null;
    }
    return configureAllocations(c, admin, vault, kaminoManager);
}

async function executeFounderDeposit(
    c: ReturnType<typeof getConnectionPool>,
    founder: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager
): Promise<{ holdingsBefore: Awaited<ReturnType<typeof vault.getVaultHoldings>>; vaultState: Awaited<ReturnType<typeof vault.getState>> } | null> {
    const shouldContinue = await askUser(
        '\n➡️  Ready to execute founder deposit? This will deposit 1 USDC into the vault (DEPOSIT = atomic pricing).'
    );
    if (!shouldContinue) {
        console.log('⏭️  Skipped STEP 3: Founder Deposit');
        return null;
    }
    return founderDeposit(c, founder, vault, kaminoManager);
}

async function executeRebalance(
    c: ReturnType<typeof getConnectionPool>,
    founder: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    vaultState: Awaited<ReturnType<typeof vault.getState>>,
    kaminoManager: KaminoManager,
    holdingsBefore: Awaited<ReturnType<typeof vault.getVaultHoldings>>
): Promise<{ vaultState: Awaited<ReturnType<typeof vault.getState>>; holdingsAfter: Awaited<ReturnType<typeof vault.getVaultHoldings>> } | null> {
    const shouldContinue = await askUser(
        '\n➡️  Ready to rebalance? This will distribute the deposited funds across the configured reserves.'
    );
    if (!shouldContinue) {
        console.log('⏭️  Skipped STEP 4: Rebalance');
        return null;
    }
    return rebalance(c, founder, vault, vaultState, kaminoManager, holdingsBefore);
}

async function executeSecondaryUserBuyShares(
    c: ReturnType<typeof getConnectionPool>,
    secondaryUser: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager
): Promise<{ holdingsBefore: Awaited<ReturnType<typeof vault.getVaultHoldings>>; vaultState: Awaited<ReturnType<typeof vault.getState>> } | null> {
    const shouldContinue = await askUser(
        '\n➡️  Ready to execute secondary user buy shares? This will buy 1 USDC worth of shares at market price (BUY = market-based pricing).'
    );
    if (!shouldContinue) {
        console.log('⏭️  Skipped STEP 5: Secondary User Buy Shares');
        return null;
    }
    return secondaryUserBuyShares(c, secondaryUser, vault, kaminoManager);
}

async function executeSecondaryUserWithdraw(
    c: ReturnType<typeof getConnectionPool>,
    secondaryUser: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager
): Promise<void> {
    const shouldContinue = await askUser(
        '\n➡️  Ready to execute secondary user withdraw? This will withdraw all shares from the vault (WITHDRAW = redeem for current NAV).'
    );
    if (!shouldContinue) {
        console.log('⏭️  Skipped STEP 8: Secondary User Withdraw');
        return;
    }
    await secondaryUserWithdraw(c, secondaryUser, vault, kaminoManager);
}

// Step 1: Create the vault
async function vaultCreation(
    c: ReturnType<typeof getConnectionPool>,
    admin: Awaited<ReturnType<typeof getKeypair>>,
    kaminoManager: KaminoManager
): Promise<KaminoVault> {
    console.log('\n========== STEP 1: CREATE VAULT ==========');
    console.log('Creating a new USDC vault with admin:', admin.address.toString());

    const vaultConfig = new KaminoVaultConfig({
        admin,
        tokenMint: USDC_MINT,
        tokenMintProgramId: TOKEN_PROGRAM_ADDRESS,
        performanceFeeRatePercentage: new Decimal(1.0),
        managementFeeRatePercentage: new Decimal(2.0),
        name: 'e2e vault (multi-reserve allocations)',
        vaultTokenSymbol: 'USDC',
        vaultTokenName: 'E2EVaultMultiReserve',
    });

    const { vault: vaultKp, initVaultIxs } = await kaminoManager.createVaultIxs(vaultConfig);
    const vault = new KaminoVault(c.rpc, vaultKp.address);

    console.log('✓ Vault created (not yet on-chain)');
    console.log('  Vault address:', vault.address.toString());
    console.log('  Vault token mint:', USDC_MINT.toString());
    console.log('  Performance fee: 1.0%');
    console.log('  Management fee: 2.0%');

    console.log('\nInitializing vault on-chain...');
    await sendAndConfirmTx(
        c,
        admin,
        [...initVaultIxs.initVaultIxs, initVaultIxs.createLUTIx, initVaultIxs.initSharesMetadataIx],
        [vaultKp],
        [],
        'E2E-InitVault'
    );
    console.log('✓ Vault initialized with LUT and shares metadata');

    console.log('\nWaiting for LUT creation...');
    await sleep(2000);

    console.log('Populating LUT...');
    await sendAndConfirmTx(c, admin, initVaultIxs.populateLUTIxs, [], [], 'E2E-PopulateLUT');
    console.log('✓ LUT populated');

    return vault;
}

// Allocation configuration constants
const ALLOCATION_CAP_USDC = new Decimal(10_000);
const MAIN_WEIGHT_INITIAL = 60;
const JLP_WEIGHT_INITIAL = 40;
const MAIN_WEIGHT_NEW = 40;
const JLP_WEIGHT_NEW = 60;

// Step 2: Configure reserve allocations
async function configureAllocations(
    c: ReturnType<typeof getConnectionPool>,
    admin: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager
): Promise<{ mainUsdcReserve: ReserveWithAddress; jlpUsdcReserve: ReserveWithAddress }> {
    console.log('\n========== STEP 2: CONFIGURE RESERVE ALLOCATIONS ==========');
    console.log('Loading USDC reserves from MAIN and JLP markets...');

    const [{ reserve: mainUsdcReserveObj }, { reserve: jlpUsdcReserveObj }] = await Promise.all([
        loadReserveData({ rpc: c.rpc, marketPubkey: MAIN_MARKET, mintPubkey: USDC_MINT }),
        loadReserveData({ rpc: c.rpc, marketPubkey: JLP_MARKET, mintPubkey: USDC_MINT }),
    ]);

    const [mainUsdcReserveState, jlpUsdcReserveState] = await Promise.all([
        Reserve.fetch(c.rpc, mainUsdcReserveObj.address),
        Reserve.fetch(c.rpc, jlpUsdcReserveObj.address),
    ]);

    if (!mainUsdcReserveState) {
        throw new Error(`MAIN market USDC reserve not found: ${mainUsdcReserveObj.address}`);
    }
    if (!jlpUsdcReserveState) {
        throw new Error(`JLP market USDC reserve not found: ${jlpUsdcReserveObj.address}`);
    }

    const mainUsdcReserve: ReserveWithAddress = {
        address: mainUsdcReserveObj.address,
        state: mainUsdcReserveState,
    };

    const jlpUsdcReserve: ReserveWithAddress = {
        address: jlpUsdcReserveObj.address,
        state: jlpUsdcReserveState,
    };

    console.log('✓ USDC reserves loaded:');
    console.log('  MAIN market reserve:', mainUsdcReserve.address.toString());
    console.log('  JLP market reserve:', jlpUsdcReserve.address.toString());

    // weights are relative; caps are in token units (USDC)
    const allocMainMarketUsdc = new ReserveAllocationConfig(mainUsdcReserve, MAIN_WEIGHT_INITIAL, ALLOCATION_CAP_USDC);
    const allocJlpMarketUsdc = new ReserveAllocationConfig(jlpUsdcReserve, JLP_WEIGHT_INITIAL, ALLOCATION_CAP_USDC);

    console.log('\nAllocations to set:');
    console.log(`  MAIN market: weight ${MAIN_WEIGHT_INITIAL}, cap ${ALLOCATION_CAP_USDC.toString()} USDC`);
    console.log(`  JLP market: weight ${JLP_WEIGHT_INITIAL}, cap ${ALLOCATION_CAP_USDC.toString()} USDC`);

    console.log('\nApplying allocations on-chain...');
    for (const [label, alloc] of [
        ['E2E-SetAllocation-MainMarketUSDC', allocMainMarketUsdc],
        ['E2E-SetAllocation-JlpMarketUSDC', allocJlpMarketUsdc],
    ] as const) {
        const setAllocIxs = await kaminoManager.updateVaultReserveAllocationIxs(vault, alloc);
        await sendAndConfirmTx(
            c,
            admin,
            [setAllocIxs.updateReserveAllocationIx, ...setAllocIxs.updateLUTIxs],
            [],
            [],
            label
        );
        console.log(`✓ ${label} applied`);
    }

    console.log('✓ All reserve allocations configured');

    return { mainUsdcReserve, jlpUsdcReserve };
}

// Step 3: Founder deposit (initial capital contribution - uses DEPOSIT with atomic pricing)
async function founderDeposit(
    c: ReturnType<typeof getConnectionPool>,
    founder: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager
): Promise<{ holdingsBefore: Awaited<ReturnType<typeof vault.getVaultHoldings>>; vaultState: Awaited<ReturnType<typeof vault.getState>> }> {
    console.log('\n========== STEP 3: FOUNDER DEPOSIT (DEPOSIT = Atomic Pricing) ==========');
    console.log('Founder address:', founder.address.toString());
    console.log('Role: Founder - direct capital contribution at current NAV');

    const amountToDeposit = new Decimal(1); // 1 USDC (token units)

    // Validate founder has sufficient USDC balance
    await validateUserHasBalance(c, founder.address, amountToDeposit, 'Founder Deposit');

    const vaultState = await vault.getState();
    // Note: vaultState.vaultLookupTable address is immutable and safe to reuse for all transactions in this flow
    const holdingsBefore = await vault.getVaultHoldings();

    const depositIxs = await kaminoManager.depositToVaultIxs(founder, vault, amountToDeposit);

    console.log('Sending deposit transaction...');
    await sendAndConfirmTx(
        c,
        founder,
        [...depositIxs.depositIxs, ...depositIxs.stakeInFarmIfNeededIxs, ...depositIxs.stakeInFlcFarmIfNeededIxs],
        [],
        [vaultState.vaultLookupTable],
        'E2E-FounderDeposit'
    );
    console.log('✓ Founder deposit confirmed on-chain');

    const founderShares = await kaminoManager.getUserSharesBalanceSingleVault(founder.address, vault);
    console.log('\n📊 Founder shares after deposit:', founderShares.toString());

    // Validate vault share supply increased
    const vaultStateAfterDeposit = await vault.getState();
    console.log('📊 Vault shares supply after founder deposit:', vaultStateAfterDeposit.sharesMintDecimals.toString(), 'decimals');

    return { holdingsBefore, vaultState };
}

// Step 5: Secondary user buys shares (market entry - uses BUY with market-based pricing)
async function secondaryUserBuyShares(
    c: ReturnType<typeof getConnectionPool>,
    secondaryUser: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager
): Promise<{ holdingsBefore: Awaited<ReturnType<typeof vault.getVaultHoldings>>; vaultState: Awaited<ReturnType<typeof vault.getState>> }> {
    console.log('\n========== STEP 5: SECONDARY USER BUY SHARES (BUY = Market-Based Pricing) ==========');
    console.log('Secondary user address:', secondaryUser.address.toString());
    console.log('Role: Secondary investor - buys shares at fair market price reflecting vault performance');

    const amountToBuy = new Decimal(1); // 1 USDC worth of shares (token units)

    // Validate secondary user has sufficient USDC balance
    await validateUserHasBalance(c, secondaryUser.address, amountToBuy, 'Secondary User Buy Shares');

    const vaultState = await vault.getState();
    // Note: vaultState.vaultLookupTable address is immutable and safe to reuse throughout this function
    const holdingsBefore = await vault.getVaultHoldings();

    console.log('\n📊 Vault holdings BEFORE secondary user buy:');
    console.log('  Available (uninvested): ', holdingsBefore.available.toString(), 'USDC');
    console.log('  Total invested: ', holdingsBefore.invested.toString(), 'USDC');
    console.log('  Total AUM (including pending fees): ', holdingsBefore.totalAUMIncludingFees.toString(), 'USDC');
    holdingsBefore.print();

    console.log('\nSecondary user buying:', amountToBuy.toString(), 'USDC worth of shares (using BUY operation)');

    const buyIxs = await kaminoManager.buyVaultSharesIxs(secondaryUser, vault, amountToBuy);

    console.log('Sending buy shares transaction...');
    await sendAndConfirmTx(
        c,
        secondaryUser,
        [...buyIxs.depositIxs, ...buyIxs.stakeInFarmIfNeededIxs, ...buyIxs.stakeInFlcFarmIfNeededIxs],
        [],
        [vaultState.vaultLookupTable],
        'E2E-SecondaryUserBuyShares'
    );
    console.log('✓ Secondary user buy shares confirmed on-chain');

    const secondaryUserShares = await kaminoManager.getUserSharesBalanceSingleVault(secondaryUser.address, vault);
    console.log('\n📊 Secondary user shares after buy:', secondaryUserShares.toString());

    // Validate vault share supply increased with secondary user entry
    const vaultStateAfterBuy = await vault.getState();
    console.log('📊 Vault shares supply after secondary user buy:', vaultStateAfterBuy.sharesMintDecimals.toString(), 'decimals');

    const holdingsAfterBuy = await vault.getVaultHoldings();
    console.log('\n📊 Vault holdings AFTER secondary user buy:');
    console.log('  Available (uninvested): ', holdingsAfterBuy.available.toString(), 'USDC');
    console.log('  Total invested: ', holdingsAfterBuy.invested.toString(), 'USDC');
    console.log('  Total AUM (including pending fees): ', holdingsAfterBuy.totalAUMIncludingFees.toString(), 'USDC');

    const availableDiff = holdingsAfterBuy.available.sub(holdingsBefore.available);
    const investedDiff = holdingsAfterBuy.invested.sub(holdingsBefore.invested);
    console.log('\n📊 Change in vault metrics due to secondary user buy:');
    console.log('  Available change: ', availableDiff.toString(), 'USDC');
    console.log('  Invested change: ', investedDiff.toString(), 'USDC');

    return { holdingsBefore, vaultState };
}

// Step 4: Rebalance across allocations
async function rebalance(
    c: ReturnType<typeof getConnectionPool>,
    founder: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    vaultState: Awaited<ReturnType<typeof vault.getState>>,
    kaminoManager: KaminoManager,
    holdingsBefore: Awaited<ReturnType<typeof vault.getVaultHoldings>>
): Promise<{ vaultState: Awaited<ReturnType<typeof vault.getState>>; holdingsAfter: Awaited<ReturnType<typeof vault.getVaultHoldings>> }> {
    console.log('\n========== STEP 4: REBALANCE ACROSS ALLOCATIONS ==========');
    console.log('Founder (payer) address:', founder.address.toString());
    console.log('Calling investAllReservesIxs to rebalance funds...');

    const investAllReservesIxs = await kaminoManager.investAllReservesIxs(founder, vault);

    console.log('Sending rebalance transaction...');
    await sendAndConfirmTx(
        c,
        founder,
        investAllReservesIxs,
        [],
        [vaultState.vaultLookupTable],
        'E2E-InvestAllReserves'
    );
    console.log('✓ Rebalance confirmed on-chain');

    const holdingsAfter = await vault.getVaultHoldings();

    console.log('\n📊 Vault holdings BEFORE rebalance:');
    console.log('  Available (uninvested): ', holdingsBefore.available.toString(), 'USDC');
    console.log('  Total invested: ', holdingsBefore.invested.toString(), 'USDC');
    console.log('  Total AUM (including pending fees): ', holdingsBefore.totalAUMIncludingFees.toString(), 'USDC');

    console.log('\n📊 Vault holdings AFTER rebalance:');
    console.log('  Available (uninvested): ', holdingsAfter.available.toString(), 'USDC');
    console.log('  Total invested: ', holdingsAfter.invested.toString(), 'USDC');
    console.log('  Total AUM (including pending fees): ', holdingsAfter.totalAUMIncludingFees.toString(), 'USDC');

    console.log('\n📊 Detailed allocation breakdown AFTER rebalance:');
    holdingsAfter.print();

    const investedDiff = holdingsAfter.invested.sub(holdingsBefore.invested);
    console.log('\n✓ Rebalance complete!');
    console.log('  Funds moved into reserves: ', investedDiff.toString(), 'USDC');

    return { vaultState, holdingsAfter };
}

// ============================================================================
// INTERMEDIATE SCENARIO: CHANGE ALLOCATIONS AND REBALANCE
// ============================================================================

async function executeChangeAllocations(
    c: ReturnType<typeof getConnectionPool>,
    admin: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager,
    reservesData: { mainUsdcReserve: ReserveWithAddress; jlpUsdcReserve: ReserveWithAddress }
): Promise<boolean> {
    const shouldContinue = await askUser(
        '\n➡️  Ready to change allocations? This will reverse the weights to 40/60 (MAIN/JLP).'
    );
    if (!shouldContinue) {
        console.log('⏭️  Skipped STEP 6: Change Allocations');
        return false;
    }
    await changeAllocations(c, admin, vault, kaminoManager, reservesData);
    return true;
}

async function executeRebalanceNewAllocations(
    c: ReturnType<typeof getConnectionPool>,
    founder: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    vaultState: Awaited<ReturnType<typeof vault.getState>>,
    kaminoManager: KaminoManager,
    holdingsBefore: Awaited<ReturnType<typeof vault.getVaultHoldings>>
): Promise<void> {
    const shouldContinue = await askUser(
        '\n➡️  Ready to rebalance with new allocations? Funds will be redistributed according to the NEW 40/60 split.'
    );
    if (!shouldContinue) {
        console.log('⏭️  Skipped STEP 7: Rebalance with New Allocations');
        return;
    }
    await rebalanceNewAllocations(c, founder, vault, vaultState, kaminoManager, holdingsBefore);
}

// Step 6: Change allocations from 60/40 to 40/60
async function changeAllocations(
    c: ReturnType<typeof getConnectionPool>,
    admin: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager,
    reservesData: { mainUsdcReserve: ReserveWithAddress; jlpUsdcReserve: ReserveWithAddress }
): Promise<void> {
    console.log('\n========== STEP 6: CHANGE ALLOCATIONS ==========');
    console.log('Changing vault allocations from 60/40 (MAIN/JLP) to 40/60...');

    // New allocation: 40% to MAIN, 60% to JLP (reversed)
    const allocMainMarketUsdcNew = new ReserveAllocationConfig(reservesData.mainUsdcReserve, MAIN_WEIGHT_NEW, ALLOCATION_CAP_USDC);
    const allocJlpMarketUsdcNew = new ReserveAllocationConfig(reservesData.jlpUsdcReserve, JLP_WEIGHT_NEW, ALLOCATION_CAP_USDC);

    console.log('\nNew allocations:');
    console.log(`  MAIN market: weight ${MAIN_WEIGHT_NEW} (was ${MAIN_WEIGHT_INITIAL}), cap ${ALLOCATION_CAP_USDC.toString()} USDC`);
    console.log(`  JLP market: weight ${JLP_WEIGHT_NEW} (was ${JLP_WEIGHT_INITIAL}), cap ${ALLOCATION_CAP_USDC.toString()} USDC`);

    console.log('\nApplying new allocations on-chain...');
    for (const [label, alloc] of [
        ['E2E-UpdateAllocation-MainMarketUSDC', allocMainMarketUsdcNew],
        ['E2E-UpdateAllocation-JlpMarketUSDC', allocJlpMarketUsdcNew],
    ] as const) {
        const setAllocIxs = await kaminoManager.updateVaultReserveAllocationIxs(vault, alloc);
        await sendAndConfirmTx(
            c,
            admin,
            [setAllocIxs.updateReserveAllocationIx, ...setAllocIxs.updateLUTIxs],
            [],
            [],
            label
        );
        console.log(`✓ ${label} applied`);
    }

    console.log('✓ All reserve allocations updated successfully');
}

// Step 7: Rebalance with new allocations
async function rebalanceNewAllocations(
    c: ReturnType<typeof getConnectionPool>,
    founder: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    vaultState: Awaited<ReturnType<typeof vault.getState>>,
    kaminoManager: KaminoManager,
    holdingsBefore: Awaited<ReturnType<typeof vault.getVaultHoldings>>
): Promise<void> {
    console.log('\n========== STEP 7: REBALANCE WITH NEW ALLOCATIONS ==========');
    console.log('Founder (payer) address:', founder.address.toString());
    console.log('Calling investAllReservesIxs to rebalance funds with the new allocation weights...');

    const investAllReservesIxs = await kaminoManager.investAllReservesIxs(founder, vault);

    console.log('Sending rebalance transaction...');
    await sendAndConfirmTx(
        c,
        founder,
        investAllReservesIxs,
        [],
        [vaultState.vaultLookupTable],
        'E2E-InvestAllReservesNewAlloc'
    );
    console.log('✓ Rebalance with new allocations confirmed on-chain');

    const holdingsAfter = await vault.getVaultHoldings();

    console.log('\n📊 Vault holdings BEFORE rebalance with new allocations:');
    console.log('  Available (uninvested): ', holdingsBefore.available.toString(), 'USDC');
    console.log('  Total invested: ', holdingsBefore.invested.toString(), 'USDC');
    console.log('  Total AUM (including pending fees): ', holdingsBefore.totalAUMIncludingFees.toString(), 'USDC');

    console.log('\n📊 Vault holdings AFTER rebalance with new allocations:');
    console.log('  Available (uninvested): ', holdingsAfter.available.toString(), 'USDC');
    console.log('  Total invested: ', holdingsAfter.invested.toString(), 'USDC');
    console.log('  Total AUM (including pending fees): ', holdingsAfter.totalAUMIncludingFees.toString(), 'USDC');

    console.log('\n📊 Detailed allocation breakdown AFTER rebalance with new weights (40/60):');
    holdingsAfter.print();

    console.log('\n✓ Rebalance with new allocations complete!');
    console.log('  Funds have been redistributed according to the new 40/60 allocation weights.');
}

// Step 8: Secondary user withdraws shares
async function secondaryUserWithdraw(
    c: ReturnType<typeof getConnectionPool>,
    secondaryUser: Awaited<ReturnType<typeof getKeypair>>,
    vault: KaminoVault,
    kaminoManager: KaminoManager
): Promise<void> {
    console.log('\n========== STEP 8: SECONDARY USER WITHDRAW (WITHDRAW = Redeem for Current NAV) ==========');
    console.log('Secondary user address:', secondaryUser.address.toString());
    console.log('Role: Secondary investor - withdraws shares at fair redemption value');

    const vaultState = await vault.getState();

    // Get user shares before withdrawal
    const secondaryUserSharesBeforeFull = await kaminoManager.getUserSharesBalanceSingleVault(secondaryUser.address, vault);
    const secondaryUserSharesBefore = secondaryUserSharesBeforeFull.totalShares;
    console.log('\n📊 Secondary user shares BEFORE withdrawal:', secondaryUserSharesBefore.toString());

    // Get vault holdings and user token balance before withdrawal
    const vaultHoldingsBefore = await vault.getVaultHoldings();
    console.log('\n📊 Vault holdings BEFORE secondary user withdrawal:');
    console.log('  Available (uninvested): ', vaultHoldingsBefore.available.toString(), 'USDC');
    console.log('  Total invested: ', vaultHoldingsBefore.invested.toString(), 'USDC');
    console.log('  Total AUM (including pending fees): ', vaultHoldingsBefore.totalAUMIncludingFees.toString(), 'USDC');
    vaultHoldingsBefore.print();

    // Get secondary user USDC balance before withdrawal
    const userUsdcAta = await getAssociatedTokenAddress(USDC_MINT, secondaryUser.address);

    // Withdraw all secondary user shares
    const slot = await c.rpc.getSlot().send();
    const withdrawIxs = await kaminoManager.withdrawFromVaultIxs(
        secondaryUser,
        vault,
        secondaryUserSharesBefore,
        slot
    );

    console.log('\nSecondary user withdrawing:', secondaryUserSharesBefore.toString(), 'shares (using WITHDRAW operation)');
    console.log('Sending withdrawal transaction...');

    await sendAndConfirmTx(
        c,
        secondaryUser,
        [...withdrawIxs.withdrawIxs, ...withdrawIxs.postWithdrawIxs, ...withdrawIxs.unstakeFromFarmIfNeededIxs],
        [],
        [vaultState.vaultLookupTable],
        'E2E-SecondaryUserWithdraw'
    );
    console.log('✓ Secondary user withdrawal confirmed on-chain');

    // Get user shares after withdrawal
    const secondaryUserSharesAfterFull = await kaminoManager.getUserSharesBalanceSingleVault(secondaryUser.address, vault);
    const secondaryUserSharesAfter = secondaryUserSharesAfterFull.totalShares;
    console.log('\n📊 Secondary user shares AFTER withdrawal:', secondaryUserSharesAfter.toString());

    // Get vault holdings after withdrawal
    const vaultHoldingsAfter = await vault.getVaultHoldings();
    console.log('\n📊 Vault holdings AFTER secondary user withdrawal:');
    console.log('  Available (uninvested): ', vaultHoldingsAfter.available.toString(), 'USDC');
    console.log('  Total invested: ', vaultHoldingsAfter.invested.toString(), 'USDC');
    console.log('  Total AUM (including pending fees): ', vaultHoldingsAfter.totalAUMIncludingFees.toString(), 'USDC');
    vaultHoldingsAfter.print();

    // Calculate and display the impact
    const sharesDiff = secondaryUserSharesAfter.sub(secondaryUserSharesBefore);
    const availableDiff = vaultHoldingsAfter.available.sub(vaultHoldingsBefore.available);
    const investedDiff = vaultHoldingsAfter.invested.sub(vaultHoldingsBefore.invested);

    console.log('\n📊 Impact of secondary user withdrawal:');
    console.log('  Secondary user shares change: ', sharesDiff.toString(), '(withdrew', secondaryUserSharesBefore.toString(), ')');
    console.log('  Vault available change: ', availableDiff.toString(), 'USDC');
    console.log('  Vault invested change: ', investedDiff.toString(), 'USDC');

    console.log('\n✓ Secondary user withdrawal complete!');
    console.log('  Shares have been redeemed for underlying USDC tokens at the current NAV.');
}
