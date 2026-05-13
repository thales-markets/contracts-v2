/**
 * Sets per-game risk overrides for OvertimeBonusHoldem to match the OTHER poker games' actual
 * on-chain state on optimisticSepolia (NOT the GAME_OVERRIDES table in upgradeAllToLatest.js,
 * which is aspirational and not currently applied to TCP / VP / UTH):
 *   - maxProfitUsdOverride = 0      (no override; effective profit cap = global $1000)
 *   - maxBetPerGameUsd     = $50    (matches TCP / VP / UTH)
 *   - minBetPerGameUsd     = 0      (no override; contract default $3 applies)
 *
 * Idempotent: skips writes when already at the target value.
 *
 * Run: `npx hardhat run scripts/deployContracts/deployCasinoV2/setBonusHoldemRiskConfig.js \
 *        --network optimisticSepolia`
 */

const { ethers } = require('hardhat');
const { getTargetAddress, delay } = require('../../helpers');

const TARGET_MAX_PROFIT_USD = 0n;
const TARGET_MAX_BET_USD = ethers.parseEther('50');
const TARGET_MIN_BET_USD = 0n;
const STEP_DELAY = 4000;

async function main() {
	const [signer] = await ethers.getSigners();
	const network = (await ethers.provider.getNetwork()).name;
	console.log('Signer :', signer.address);
	console.log('Network:', network);

	const coreAddr = getTargetAddress('CasinoCoreV2', network);
	const bhAddr = getTargetAddress('OvertimeBonusHoldem', network);
	if (!coreAddr || !bhAddr)
		throw new Error('CasinoCoreV2 / OvertimeBonusHoldem missing in deployments.json');

	const core = await ethers.getContractAt('CasinoCoreV2', coreAddr);

	const beforeMaxProfit = await core.maxProfitUsdOverride(bhAddr);
	if (beforeMaxProfit === TARGET_MAX_PROFIT_USD) {
		console.log(`maxProfitUsd: already $${ethers.formatEther(beforeMaxProfit)} — skipped`);
	} else {
		const tx = await core.setMaxProfitUsdOverride(bhAddr, TARGET_MAX_PROFIT_USD);
		await tx.wait();
		console.log(
			`maxProfitUsd: $${ethers.formatEther(beforeMaxProfit)} → $${ethers.formatEther(
				TARGET_MAX_PROFIT_USD
			)}  tx=${tx.hash}`
		);
		await delay(STEP_DELAY);
	}

	const beforeMinBet = await core.minBetPerGameUsd(bhAddr);
	if (beforeMinBet === TARGET_MIN_BET_USD) {
		console.log(`minBetUsd: already $${ethers.formatEther(beforeMinBet)} — skipped`);
	} else {
		const tx = await core.setMinBetPerGameUsd(bhAddr, TARGET_MIN_BET_USD);
		await tx.wait();
		console.log(
			`minBetUsd: $${ethers.formatEther(beforeMinBet)} → $${ethers.formatEther(
				TARGET_MIN_BET_USD
			)}  tx=${tx.hash}`
		);
		await delay(STEP_DELAY);
	}

	const beforeMaxBet = await core.maxBetPerGameUsd(bhAddr);
	if (beforeMaxBet === TARGET_MAX_BET_USD) {
		console.log(`maxBetUsd: already $${ethers.formatEther(beforeMaxBet)} — skipped`);
	} else {
		const tx = await core.setMaxBetPerGameUsd(bhAddr, TARGET_MAX_BET_USD);
		await tx.wait();
		console.log(
			`maxBetUsd: $${ethers.formatEther(beforeMaxBet)} → $${ethers.formatEther(
				TARGET_MAX_BET_USD
			)}  tx=${tx.hash}`
		);
		await delay(STEP_DELAY);
	}

	console.log('\n==== BonusHoldem risk config ====');
	console.log(`  maxProfitUsd: $${ethers.formatEther(await core.maxProfitUsdOverride(bhAddr))}`);
	console.log(`  minBetUsd:    $${ethers.formatEther(await core.minBetPerGameUsd(bhAddr))}`);
	console.log(`  maxBetUsd:    $${ethers.formatEther(await core.maxBetPerGameUsd(bhAddr))}`);
}

main()
	.then(() => process.exit(0))
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
